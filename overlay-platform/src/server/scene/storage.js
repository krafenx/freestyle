import fs from 'node:fs';
import path from 'node:path';
import { HEAD_BYTES, readJpegSize, sniffFile } from '../../../public/js/scene/sniff.js';
import { isLinkToken, newLinkToken } from '../auth/tokens.js';
import { AppError } from '../errors.js';

/* Загруженные файлы на диске. Здесь нет ни прав, ни пределов площадки — только
   приём файла, его проверка по содержимому и раскладка по папкам. Кто и что может
   загружать, решает scene.js.

   Раскладка:  <папка загрузок>/<номер площадки>/<номер файла>
   У файла на диске нет ни имени, ни расширения: имя, которое дал человек, хранится
   в базе только для показа. Папка загрузок не входит в раздаваемые файлы сайта —
   получить файл можно только по адресу /media/…, где проверяются права. */

const ID_LENGTH = 12; // номера площадок и файлов
const INCOMING = '.incoming'; // сюда файл пишется, пока загружается

export function createMediaStorage({ dir, now = Date.now } = {}) {
  const incomingDir = path.join(dir, INCOMING);

  const isId = (value) => isLinkToken(value, ID_LENGTH);
  const workspaceDir = (workspaceId) => path.join(dir, workspaceId);

  function unlinkQuietly(file) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if (err?.code !== 'ENOENT') console.error('[krafen-overlay] Не удалось удалить файл:', err);
    }
  }

  /* Записать блок целиком. Система вправе принять за один раз только часть блока —
     тогда остаток дописывается; иначе в файле молча не хватило бы куска. */
  async function writeAll(handle, block) {
    let done = 0;
    while (done < block.length) {
      const { bytesWritten } = await handle.write(block, done, block.length - done);
      if (bytesWritten <= 0) throw new Error('Диск не принял данные файла');
      done += bytesWritten;
    }
  }

  /* Дочитать и выбросить остаток запроса, но не больше limit байт. Нужно, чтобы
     браузер получил внятный ответ об отказе: если оборвать соединение посреди
     отправки, вместо ответа он увидит просто «обрыв связи». */
  async function skip(stream, limit) {
    let total = 0;
    try {
      for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
        total += chunk.length;
        if (total > limit) {
          stream.destroy();
          break;
        }
      }
    } catch {
      // соединение оборвалось — отвечать уже некому
    }
  }

  /* Принять файл из запроса во временный файл.

     Тип определяется по первым байтам содержимого — имя и заявленный тип не
     учитываются вовсе. Размер считается по тому, что реально пришло. При отказе
     остаток дочитывается впустую (не дальше drainLimit) и ничего не сохраняется.

     limitFor(kind) — предел размера для картинки, GIF или видео.
     Ответ: { tmpPath, bytes, kind, mime, format, width, height }. */
  async function receive(stream, { limitFor, drainLimit, imageMaxSide, imageMaxPixels }) {
    fs.mkdirSync(incomingDir, { recursive: true });
    const tmpPath = path.join(incomingDir, newLinkToken(26));

    let handle = null;
    let total = 0;
    let head = Buffer.alloc(0);
    let found = null;
    let refusal = null;

    const tooLarge = (kind) => new AppError('file_too_large', 413, { kind, limitBytes: limitFor(kind) });

    // Первые байты набрались (или файл кончился раньше) — выясняем, что это
    async function recognise() {
      found = sniffFile(head);
      if (!found) {
        refusal = new AppError('file_type_not_allowed', 415);
        return;
      }
      if (total > limitFor(found.kind)) {
        refusal = tooLarge(found.kind);
        return;
      }
      // «wx+»: файл создаётся заново (существующий не перезаписывается) и открыт и на запись,
      // и на чтение — после приёма из него читаются размеры JPEG
      handle = await fs.promises.open(tmpPath, 'wx+', 0o600);
      await writeAll(handle, head);
    }

    try {
      const chunks = stream.iterator({ destroyOnReturn: false });
      for (;;) {
        let step;
        try {
          step = await chunks.next();
        } catch {
          // Соединение оборвалось посреди файла. Сбои самого сервера (например, кончилось
          // место на диске) сюда не попадают: они возникают ниже и остаются сбоями
          throw new AppError('upload_interrupted', 400);
        }
        if (step.done) break;
        const chunk = step.value;
        total += chunk.length;
        if (refusal) {
          if (total > drainLimit) {
            stream.destroy();
            break;
          }
        } else if (!found) {
          head = head.length ? Buffer.concat([head, chunk]) : chunk;
          if (head.length >= HEAD_BYTES) await recognise();
        } else if (total > limitFor(found.kind)) {
          refusal = tooLarge(found.kind);
        } else {
          await writeAll(handle, chunk);
        }
      }

      if (!refusal && !found) {
        if (total === 0) refusal = new AppError('file_empty', 400);
        else await recognise(); // файл короче, чем нужно для уверенного ответа, — решаем по тому, что есть
      }
      if (refusal) throw refusal;

      // Размеры картинки: слишком большая «съест» память браузера и OBS при показе
      let { width, height } = found;
      if (found.kind !== 'video') {
        if (found.format === 'JPEG') {
          const size = await readJpegSize(async (offset, length) => {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            return buffer.subarray(0, bytesRead);
          });
          width = size?.width ?? 0;
          height = size?.height ?? 0;
        }
        if (!(width > 0 && height > 0)) throw new AppError('image_unreadable', 400);
        if (width > imageMaxSide || height > imageMaxSide || width * height > imageMaxPixels) {
          throw new AppError('image_too_big', 400, { limit: imageMaxSide, megapixels: Math.floor(imageMaxPixels / 1_000_000) });
        }
      }

      await handle.close();
      handle = null;
      return { tmpPath, bytes: total, kind: found.kind, mime: found.mime, format: found.format, width, height };
    } catch (err) {
      await handle?.close().catch(() => {});
      unlinkQuietly(tmpPath);
      throw err;
    }
  }

  // Принятый файл занимает своё место в папке площадки
  function keep(tmpPath, workspaceId, fileId) {
    if (!isId(workspaceId) || !isId(fileId)) throw new Error('Некорректный номер площадки или файла');
    fs.mkdirSync(workspaceDir(workspaceId), { recursive: true });
    fs.renameSync(tmpPath, path.join(workspaceDir(workspaceId), fileId));
  }

  function discard(tmpPath) {
    unlinkQuietly(tmpPath);
  }

  function remove(workspaceId, fileId) {
    if (!isId(workspaceId) || !isId(fileId)) return;
    unlinkQuietly(path.join(workspaceDir(workspaceId), fileId));
  }

  function removeWorkspace(workspaceId) {
    if (!isId(workspaceId)) return;
    fs.rmSync(workspaceDir(workspaceId), { recursive: true, force: true });
  }

  // Где лежит файл: папка и имя по отдельности — так его отдаёт сервер (см. scene/http.js)
  function locate(workspaceId, fileId) {
    if (!isId(workspaceId) || !isId(fileId)) return null;
    return { root: workspaceDir(workspaceId), name: fileId };
  }

  /* Уборка: недокачанные файлы, папки удалённых площадок и файлы, о которых база
     не знает. Свежее (моложе maxAgeMs) не трогается — оно может ещё загружаться.
     Всё, что не похоже на наши номера, остаётся как есть. Возвращает число удалённого. */
  function sweep({ hasWorkspace, hasFile, maxAgeMs = 60 * 60 * 1000 } = {}) {
    let removed = 0;
    const old = (file) => {
      try {
        return now() - fs.statSync(file).mtimeMs > maxAgeMs;
      } catch {
        return false;
      }
    };
    const list = (folder) => {
      try {
        return fs.readdirSync(folder, { withFileTypes: true });
      } catch {
        return [];
      }
    };

    for (const entry of list(incomingDir)) {
      const file = path.join(incomingDir, entry.name);
      if (entry.isFile() && old(file)) {
        unlinkQuietly(file);
        removed += 1;
      }
    }

    for (const entry of list(dir)) {
      if (!entry.isDirectory() || !isId(entry.name)) continue;
      if (!hasWorkspace(entry.name)) {
        removeWorkspace(entry.name);
        removed += 1;
        continue;
      }
      for (const item of list(workspaceDir(entry.name))) {
        const file = path.join(workspaceDir(entry.name), item.name);
        if (item.isFile() && isId(item.name) && !hasFile(entry.name, item.name) && old(file)) {
          unlinkQuietly(file);
          removed += 1;
        }
      }
    }
    return removed;
  }

  return { receive, skip, keep, discard, remove, removeWorkspace, locate, sweep };
}
