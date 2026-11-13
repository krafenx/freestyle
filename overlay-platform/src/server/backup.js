import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/* Резервная копия: база и загруженные файлы одним снимком.

   Зачем отдельный модуль, а не «скопировать папку»: база работает в режиме WAL,
   и обычное копирование файла .db во время работы даёт копию без последних
   записей — они ещё лежат в .db-wal. `VACUUM INTO` собирает из этих частей один
   цельный файл и делает это согласованно: копия соответствует одному моменту,
   даже если в неё одновременно пишут. Загруженные файлы копируются следом,
   только те, о которых база знает.

   Чего копия не гарантирует: файл, загруженный в ту же секунду, может попасть
   в копию не полностью — тогда его не будет и в списке базы, то есть копия
   останется цельной, просто без последней загрузки. */

const FORMAT = 1;
const MANIFEST = 'backup.json';

function stamp(date) {
  const two = (n) => String(n).padStart(2, '0');
  return [
    date.getUTCFullYear(), two(date.getUTCMonth() + 1), two(date.getUTCDate()),
    '-', two(date.getUTCHours()), two(date.getUTCMinutes()), two(date.getUTCSeconds()),
  ].join('');
}

/* Список файлов, о которых знает база: площадка → файлы. Отдельно, потому что
   база нужна и для копии, и для проверки. */
function listMedia(db) {
  return db
    .prepare(`
      SELECT w.public_id AS workspace, f.public_id AS file, f.size_bytes AS bytes, f.name AS name
      FROM media_files f JOIN workspaces w ON w.id = f.workspace_id
      ORDER BY w.public_id, f.created_at
    `)
    .all();
}

function mediaPath(uploadsDir, workspaceId, fileId) {
  return path.join(uploadsDir, workspaceId, fileId);
}

/* Снять копию. Возвращает, где она лежит и что в ней.
   targetDir — куда положить; внутри создаётся папка backup-<время>. */
export function createBackup({ dbPath, uploadsDir, targetDir, now = () => new Date(), log = () => {} }) {
  if (!targetDir) throw new Error('Не указано, куда класть копию');
  const at = now();
  const name = `backup-${stamp(at)}`;
  const dir = path.resolve(targetDir, name);
  fs.mkdirSync(dir, { recursive: true });

  // 1. База — одним цельным файлом. Если база ещё не создана, копировать нечего.
  const dbFile = path.join(dir, 'overlay.db');
  let db = null;
  let media = [];
  let schemaVersion = 0;
  if (fs.existsSync(dbPath)) {
    db = new DatabaseSync(dbPath);
    try {
      // VACUUM INTO не перезаписывает существующий файл — имя всегда новое
      db.exec(`VACUUM INTO '${dbFile.replaceAll("'", "''")}'`);
      media = listMedia(db);
      schemaVersion = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get()?.v ?? 0;
    } finally {
      db.close();
    }
  } else {
    log('Базы ещё нет — копирую только загруженные файлы.');
  }

  // 2. Файлы — только те, о которых знает база, и только целые
  const filesDir = path.join(dir, 'uploads');
  let copied = 0;
  let bytes = 0;
  const skipped = [];
  for (const item of media) {
    const from = mediaPath(uploadsDir, item.workspace, item.file);
    let stat = null;
    try {
      stat = fs.statSync(from);
    } catch {
      skipped.push({ workspace: item.workspace, file: item.file, name: item.name, why: 'нет на диске' });
      continue;
    }
    if (stat.size !== item.bytes) {
      /* Файл недописан или испорчен: в копию его не берём. Молчать об этом нельзя —
         иначе копия выглядела бы целой, а файла в ней не было бы. */
      skipped.push({ workspace: item.workspace, file: item.file, name: item.name, why: `размер ${stat.size} вместо ${item.bytes}` });
      continue;
    }
    const to = path.join(filesDir, item.workspace, item.file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied += 1;
    bytes += stat.size;
  }

  const manifest = {
    format: FORMAT,
    madeAt: at.toISOString(),
    schemaVersion,
    database: fs.existsSync(dbFile) ? path.basename(dbFile) : null,
    // Пропущенные файлы перечислены поимённо: копия цельная, но неполная — и это видно
    media: { known: media.length, copied, missing: skipped.length, bytes, skipped },
  };
  fs.writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

  return { dir, name, manifest };
}

/* Проверить копию, не распаковывая её на место: база открывается, структура
   на месте, у каждого файла из базы есть файл на диске нужного размера.
   Это то, что нужно запускать после копирования — «копия есть» и «копия цела»
   разные вещи. */
export function checkBackup(dir) {
  const problems = [];
  const target = path.resolve(dir);
  const manifestPath = path.join(target, MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, problems: [`Нет файла ${MANIFEST} — это не копия платформы.`] };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, problems: [`Файл ${MANIFEST} испорчен: ${err.message}`] };
  }
  if (manifest.format !== FORMAT) problems.push(`Неизвестный формат копии: ${manifest.format}`);

  const dbFile = path.join(target, manifest.database || 'overlay.db');
  let media = [];
  let schemaVersion = 0;
  let integrity = null;
  if (fs.existsSync(dbFile)) {
    let db = null;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
      integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check ?? null;
      if (integrity !== 'ok') problems.push(`База повреждена: ${integrity}`);
      schemaVersion = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get()?.v ?? 0;
      media = listMedia(db);
    } catch (err) {
      problems.push(`Базу не удалось открыть: ${err.message}`);
    } finally {
      db?.close();
    }
  } else if (manifest.database) {
    problems.push('В копии нет файла базы.');
  }

  /* Файл, о котором при копировании честно записали «не взяли», пропажей не считается:
     его и не должно быть. Всё остальное отсутствующее или не того размера — порча. */
  const declared = new Set((manifest.media?.skipped || []).map((item) => `${item.workspace}/${item.file}`));
  const filesDir = path.join(target, 'uploads');
  let present = 0;
  let absent = 0;
  const lost = [];
  for (const item of media) {
    const key = `${item.workspace}/${item.file}`;
    const file = path.join(filesDir, item.workspace, item.file);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      if (declared.has(key)) continue;
      absent += 1;
      lost.push(key);
      if (absent <= 10) problems.push(`Нет файла ${key} («${item.name}»).`);
      continue;
    }
    if (stat.size !== item.bytes) {
      problems.push(`Файл ${key} не того размера: ${stat.size} вместо ${item.bytes}.`);
    } else {
      present += 1;
    }
  }
  if (absent > 10) problems.push(`…и ещё ${absent - 10} файлов отсутствуют.`);

  return {
    ok: problems.length === 0,
    dir: target,
    madeAt: manifest.madeAt ?? null,
    schemaVersion,
    database: integrity,
    media: {
      known: media.length,
      present,
      absent,
      // Известные потери: их не было на диске в момент копирования
      missingAtCopy: (manifest.media?.skipped || []).length,
      skipped: manifest.media?.skipped || [],
    },
    lost,
    problems,
  };
}

export { MANIFEST, FORMAT, stamp };
