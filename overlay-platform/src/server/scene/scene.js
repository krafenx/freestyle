import { checkSettings, defaultsOf, isShown, readSettings } from '../../../public/js/scene/schema.js';
import { sourceType } from '../../../public/js/scene/sources/index.js';
import { createRateLimiter } from '../auth/rate-limit.js';
import { isLinkToken, newLinkToken } from '../auth/tokens.js';
import { inTransaction } from '../db/database.js';
import { AppError, isUniqueViolation } from '../errors.js';
import { cleanLine, lengthOf } from '../text.js';

/* Сцена площадки: источники и загруженные файлы. Здесь только правила: что можно
   сделать со сценой и что при этом меняется в базе. Адреса — в http.js, файлы
   на диске — в storage.js, а что умеет каждый тип источника — в его модуле
   (public/js/scene/sources).

   Права. Со сценой работают владелец и модераторы — на равных. Каждое действие
   ниже первой строкой входит в площадку через workspaces.enter(): это та же самая
   проверка, что у страницы площадки, и для постороннего ответ тот же — «площадка
   не найдена». Своей проверки прав у сцены нет.

   Оверлей — исключение: страница в OBS не входит в аккаунт, площадку ей открывает
   ссылка оверлея (workspaces.enterOverlay). По ссылке можно только читать, и только
   то, что сейчас в эфире. Действует ли ссылка, решают тоже площадки.

   Версия сцены растёт на единицу при каждом сохранённом изменении. После него
   открытые страницы площадки и оверлеи получают сигнал с номером версии и
   перечитывают сцену обычным запросом. */

const MB = 1024 * 1024;

export const SOURCE_ID_LENGTH = 12;
export const FILE_ID_LENGTH = 12;

export const DEFAULT_SCENE_LIMITS = Object.freeze({
  sourcesPerScene: 100,
  filesPerWorkspace: 200,
  storageBytesPerWorkspace: 200 * MB, // все файлы одной площадки вместе
  storageBytesTotal: 5 * 1024 * MB, // все файлы сервера вместе (настройка UPLOADS_TOTAL_LIMIT_MB)
  fileBytes: Object.freeze({ image: 10 * MB, gif: 20 * MB, video: 50 * MB }),
  imageMaxSide: 8192, // картинка крупнее не нужна сцене 1920×1080 и опасна для памяти браузера
  imageMaxPixels: 40_000_000,
  uploadsAtOncePerUser: 2,
  uploadsAtOnce: 8,
  // За это время не пришло ни байта файла — связь потеряна: загрузка обрывается и освобождает место
  uploadIdleMs: 60 * 1000,
  // Защита от скриптов: человек столько не нажимает
  commandsPerUser: { limit: 600, windowMs: 60 * 1000 },
  uploadsPerUser: { limit: 60, windowMs: 10 * 60 * 1000 },
});

const NAME_MAX = 40;
const FILE_NAME_MAX = 80;
const POSITION_MAX = 8192; // источник может выходить за край сцены, но не «улетать» бесконечно
const SIZE_MIN = 8;
const SIZE_MAX = 8192;
const COPY_SHIFT = 24; // копия появляется чуть в стороне от оригинала
const SHIFT_TRIES = 40; // сколько раз подряд новый источник отступает от занятого места

const FIELDS = new Set(['name', 'x', 'y', 'width', 'height', 'opacity', 'visible', 'locked', 'file', 'settings']);
const GEOMETRY = ['x', 'y', 'width', 'height'];
const ORIGIN_PATTERN = /^[0-9a-z]{8,32}$/;

const iso = (ms) => new Date(ms).toISOString();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return isPlain(value) ? value : {};
  } catch {
    return {};
  }
}

export function createScene({ db, workspaces, storage, now = Date.now, limits = {}, onChange = null } = {}) {
  const rules = {
    ...DEFAULT_SCENE_LIMITS,
    ...limits,
    fileBytes: { ...DEFAULT_SCENE_LIMITS.fileBytes, ...limits.fileBytes },
  };
  const largestFile = Math.max(...Object.values(rules.fileBytes));
  // При отказе остаток файла дочитывается впустую, но не дальше этого предела
  const drainLimit = largestFile + MB;

  const limiter = createRateLimiter({ now });
  const transaction = (work) => inTransaction(db, work);
  const uploading = new Map(); // человек → сколько его файлов загружается прямо сейчас
  let uploadingTotal = 0;

  const SOURCE_COLUMNS = `
    s.id, s.public_id, s.type, s.name, s.x, s.y, s.width, s.height, s.opacity, s.layer,
    s.visible, s.locked, s.media_id, s.settings, s.state, m.public_id AS media_public_id
  `;
  const MEDIA_COLUMNS = `
    m.id, m.public_id, m.kind, m.mime, m.size_bytes, m.width, m.height, m.name, m.created_at,
    u.display_name AS uploader_name,
    (SELECT COUNT(*) FROM sources s WHERE s.media_id = m.id) AS used_by
  `;

  const sql = {
    scene: db.prepare('SELECT scene_width, scene_height, scene_version FROM workspaces WHERE id = ?'),
    bumpVersion: db.prepare('UPDATE workspaces SET scene_version = scene_version + 1 WHERE id = ? RETURNING scene_version'),

    sources: db.prepare(`
      SELECT ${SOURCE_COLUMNS} FROM sources s LEFT JOIN media_files m ON m.id = s.media_id
      WHERE s.workspace_id = ? ORDER BY s.layer, s.id
    `),
    source: db.prepare(`
      SELECT ${SOURCE_COLUMNS} FROM sources s LEFT JOIN media_files m ON m.id = s.media_id
      WHERE s.public_id = ? AND s.workspace_id = ?
    `),
    sourceById: db.prepare(`
      SELECT ${SOURCE_COLUMNS} FROM sources s LEFT JOIN media_files m ON m.id = s.media_id WHERE s.id = ?
    `),
    // Для оверлея: только то, что показано
    visibleSources: db.prepare(`
      SELECT ${SOURCE_COLUMNS} FROM sources s LEFT JOIN media_files m ON m.id = s.media_id
      WHERE s.workspace_id = ? AND s.visible = 1 ORDER BY s.layer, s.id
    `),
    countSources: db.prepare('SELECT COUNT(*) AS n FROM sources WHERE workspace_id = ?'),
    sourceCorners: db.prepare('SELECT x, y FROM sources WHERE workspace_id = ?'),
    sourceNames: db.prepare('SELECT name FROM sources WHERE workspace_id = ?'),
    insertSource: db.prepare(`
      INSERT INTO sources
        (public_id, workspace_id, type, name, x, y, width, height, opacity, layer, visible, locked, media_id, settings, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateSource: db.prepare(`
      UPDATE sources
      SET name = ?, x = ?, y = ?, width = ?, height = ?, opacity = ?, visible = ?, locked = ?, media_id = ?, settings = ?, state = ?
      WHERE id = ?
    `),
    setState: db.prepare('UPDATE sources SET state = ? WHERE id = ?'),
    setLayer: db.prepare('UPDATE sources SET layer = ? WHERE id = ?'),
    deleteSource: db.prepare('DELETE FROM sources WHERE id = ?'),

    media: db.prepare(`
      SELECT ${MEDIA_COLUMNS} FROM media_files m LEFT JOIN users u ON u.id = m.uploaded_by
      WHERE m.workspace_id = ? ORDER BY m.created_at DESC, m.id DESC
    `),
    mediaFile: db.prepare(`
      SELECT ${MEDIA_COLUMNS} FROM media_files m LEFT JOIN users u ON u.id = m.uploaded_by
      WHERE m.public_id = ? AND m.workspace_id = ?
    `),
    // Для оверлея: файл отдаётся, только пока его показывает хотя бы один видимый источник
    mediaOnAir: db.prepare(`
      SELECT m.public_id, m.mime, m.size_bytes FROM media_files m
      WHERE m.public_id = ? AND m.workspace_id = ?
        AND EXISTS (SELECT 1 FROM sources s WHERE s.media_id = m.id AND s.visible = 1)
    `),
    insertMedia: db.prepare(`
      INSERT INTO media_files (public_id, workspace_id, uploaded_by, kind, mime, size_bytes, width, height, name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    deleteMedia: db.prepare('DELETE FROM media_files WHERE id = ?'),
    usage: db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM media_files WHERE workspace_id = ?'),
    totalBytes: db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM media_files'),

    // Для уборки папки загрузок
    workspaceExists: db.prepare('SELECT 1 AS yes FROM workspaces WHERE public_id = ?'),
    fileExists: db.prepare(`
      SELECT 1 AS yes FROM media_files m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.public_id = ? AND w.public_id = ?
    `),
  };

  /* ---------- Права и частота ---------- */

  /* Единственный вход в сцену. Владелец и модератор проходят, остальные получают
     «площадка не найдена» — так же, как на странице площадки. */
  function enter({ userId, workspaceId } = {}) {
    return workspaces.enter({ userId, workspaceId });
  }

  function assertNotTooOften(key, rule) {
    const waitMs = limiter.retryAfterMs(key, rule);
    if (waitMs > 0) {
      throw new AppError('too_many_requests', 429, { retryAfterSeconds: Math.ceil(waitMs / 1000) });
    }
  }

  // Каждая команда, меняющая сцену, идёт в счёт — удачная или нет
  function countCommand(userId, ws) {
    const key = `scene:${userId}:${ws.rowId}`;
    assertNotTooOften(key, rules.commandsPerUser);
    limiter.hit(key, rules.commandsPerUser);
  }

  /* ---------- Сохранение и оповещение ---------- */

  function announce(ws, version, { userId, origin }) {
    if (!onChange) return;
    try {
      onChange({
        workspaceId: ws.publicId,
        what: 'scene',
        audience: 'team',
        actorId: userId,
        version,
        // Метка страницы — не право и не секрет: по ней страница узнаёт в рассылке собственную правку
        origin: typeof origin === 'string' && ORIGIN_PATTERN.test(origin) ? origin : null,
      });
    } catch (err) {
      // Изменение уже сохранено: сбой при оповещении не должен превращать его в ошибку
      console.error('[krafen-overlay] Не удалось оповестить страницы площадки о сцене:', err);
    }
  }

  /* Одно изменение сцены: всё, что делает work, и новый номер версии сохраняются
     вместе или не сохраняются вовсе. Если work сообщает unchanged — менять было
     нечего: версия остаётся прежней и никого не оповещают. */
  function commit(ws, who, work) {
    const { unchanged, ...answer } = transaction(() => {
      const out = work();
      const version = out.unchanged
        ? sql.scene.get(ws.rowId).scene_version
        : sql.bumpVersion.get(ws.rowId).scene_version;
      return { ...out, version };
    });
    if (!unchanged) announce(ws, answer.version, who);
    return answer;
  }

  /* ---------- Что уходит на страницу ---------- */

  function sourceView(row) {
    const module = sourceType(row.type);
    const view = {
      id: row.public_id,
      type: row.type,
      name: row.name,
      x: row.x,
      y: row.y,
      width: row.width,
      height: row.height,
      opacity: row.opacity,
      visible: row.visible === 1,
      locked: row.locked === 1,
      // Настройки всегда полные: чего в записи нет, берётся по умолчанию
      settings: module ? readSettings(module.fields, parseJson(row.settings)) : {},
    };
    if (module?.media) view.file = row.media_public_id ?? null;
    if (module?.readState) view.state = module.readState(view.settings, parseJson(row.state));
    return view;
  }

  function mediaView(row) {
    return {
      id: row.public_id,
      kind: row.kind,
      mime: row.mime,
      size: row.size_bytes,
      width: row.width,
      height: row.height,
      name: row.name,
      uploadedBy: row.uploader_name ?? null,
      createdAt: iso(row.created_at),
      usedBy: row.used_by,
    };
  }

  function usageOf(workspaceRowId) {
    const row = sql.usage.get(workspaceRowId);
    return { files: row.files, storageBytes: row.bytes };
  }

  const orderOf = (workspaceRowId) => sql.sources.all(workspaceRowId).map((row) => row.public_id);

  /* ---------- Поиск ---------- */

  function findSource(ws, sourceId) {
    const row = isLinkToken(sourceId, SOURCE_ID_LENGTH) ? sql.source.get(sourceId, ws.rowId) : null;
    // Источник другой площадки не отличается от несуществующего
    if (!row) throw new AppError('source_not_found', 404);
    return row;
  }

  function findMedia(ws, fileId) {
    const row = isLinkToken(fileId, FILE_ID_LENGTH) ? sql.mediaFile.get(fileId, ws.rowId) : null;
    if (!row) throw new AppError('media_not_found', 404);
    return row;
  }

  /* ---------- Проверка присланного ---------- */

  function requireName(value) {
    const name = cleanLine(value);
    if (!name) throw new AppError('source_name_required', 400, { field: 'name' });
    if (lengthOf(name) > NAME_MAX) throw new AppError('source_name_too_long', 400, { field: 'name' });
    return name;
  }

  function requireInt(value, min, max, field, code) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new AppError(code, 400, { field });
    const number = Math.round(value);
    if (number < min || number > max) throw new AppError(code, 400, { field });
    return number;
  }

  /* Что человек хочет задать или изменить. Проверяется каждое присланное поле;
     незнакомое поле — отказ, а не молчаливый пропуск. Возвращает только то, что прислано. */
  function readChange(input, module, ws) {
    if (!isPlain(input)) throw new AppError('source_field_invalid', 400, { field: '' });
    for (const key of Object.keys(input)) {
      if (!FIELDS.has(key)) throw new AppError('source_field_invalid', 400, { field: key });
    }

    const change = {};
    if (own(input, 'name')) change.name = requireName(input.name);
    for (const key of ['x', 'y']) {
      if (own(input, key)) change[key] = requireInt(input[key], -POSITION_MAX, POSITION_MAX, key, 'source_geometry_invalid');
    }
    for (const key of ['width', 'height']) {
      if (own(input, key)) change[key] = requireInt(input[key], SIZE_MIN, SIZE_MAX, key, 'source_geometry_invalid');
    }
    if (own(input, 'opacity')) change.opacity = requireInt(input.opacity, 0, 100, 'opacity', 'source_field_invalid');
    for (const key of ['visible', 'locked']) {
      if (!own(input, key)) continue;
      if (typeof input[key] !== 'boolean') throw new AppError('source_field_invalid', 400, { field: key });
      change[key] = input[key];
    }

    if (own(input, 'file')) {
      // Файл есть только у тех типов, которым он нужен, и только своей площадки
      if (!module?.media) throw new AppError('source_field_invalid', 400, { field: 'file' });
      if (input.file === null) {
        change.media = null;
      } else {
        const file = findMedia(ws, input.file);
        if (!module.media.kinds.includes(file.kind)) throw new AppError('media_kind_mismatch', 400, { field: 'file' });
        change.media = file;
      }
    }

    if (own(input, 'settings')) {
      const checked = module ? checkSettings(module.fields, input.settings) : { ok: false, field: '' };
      if (!checked.ok) {
        throw new AppError('source_setting_invalid', 400, { field: checked.field ? `settings.${checked.field}` : 'settings' });
      }
      change.settings = checked.value;
    }
    return change;
  }

  // «Текст», «Текст 2», «Текст 3»… — первое название, которого на сцене ещё нет
  function freeName(workspaceRowId, title) {
    const taken = new Set(sql.sourceNames.all(workspaceRowId).map((row) => row.name.toLowerCase()));
    for (let n = 1; ; n += 1) {
      const name = n === 1 ? title : `${title} ${n}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }

  function copyName(workspaceRowId, name) {
    const base = [...name].slice(0, NAME_MAX - 12).join('');
    return freeName(workspaceRowId, `${base} — копия`);
  }

  function insertSource(ws, record) {
    for (let attempt = 1; ; attempt += 1) {
      const publicId = newLinkToken(SOURCE_ID_LENGTH);
      try {
        sql.insertSource.run(
          publicId, ws.rowId, record.type, record.name, record.x, record.y, record.width, record.height,
          record.opacity, record.layer, record.visible ? 1 : 0, record.locked ? 1 : 0, record.mediaId,
          JSON.stringify(record.settings), JSON.stringify(record.state)
        );
        return publicId;
      } catch (err) {
        // Случайный номер совпал с уже занятым — берём другой
        if (!isUniqueViolation(err) || attempt >= 5) throw err;
      }
    }
  }

  // Порядок слоёв записывается подряд, без пропусков: 0 — в самом низу
  function writeOrder(rowIds) {
    rowIds.forEach((rowId, layer) => sql.setLayer.run(layer, rowId));
  }

  function assertRoomForSource(workspaceRowId) {
    if (sql.countSources.get(workspaceRowId).n >= rules.sourcesPerScene) {
      throw new AppError('sources_limit', 409, { limit: rules.sourcesPerScene });
    }
  }

  /* ---------- Сцена ---------- */

  function get({ userId, workspaceId } = {}) {
    const ws = enter({ userId, workspaceId });
    const scene = sql.scene.get(ws.rowId);
    return {
      workspace: { id: ws.publicId, name: ws.name, role: ws.role },
      scene: { width: scene.scene_width, height: scene.scene_height, version: scene.scene_version },
      sources: sql.sources.all(ws.rowId).map(sourceView), // снизу вверх: первый — в самом низу
      media: sql.media.all(ws.rowId).map(mediaView),
      usage: usageOf(ws.rowId),
      limits: {
        sources: rules.sourcesPerScene,
        files: rules.filesPerWorkspace,
        storageBytes: rules.storageBytesPerWorkspace,
        fileBytes: { ...rules.fileBytes },
      },
      // Часы сервера: по ним страницы считают таймеры, чтобы у всех совпадало
      serverTime: now(),
    };
  }

  /* ---------- Источники ---------- */

  /* Место для источника, которому его не назначили. Если ровно там уже стоит другой,
     новый встаёт чуть ниже и правее: иначе он закрыл бы прежний целиком, и не было бы
     видно, что их два. */
  function freeSpot(workspaceRowId, x, y) {
    const taken = new Set(sql.sourceCorners.all(workspaceRowId).map((item) => `${item.x}:${item.y}`));
    let spot = { x, y };
    for (let i = 0; i < SHIFT_TRIES && taken.has(`${spot.x}:${spot.y}`); i += 1) {
      if (spot.x + COPY_SHIFT > POSITION_MAX || spot.y + COPY_SHIFT > POSITION_MAX) break;
      spot = { x: spot.x + COPY_SHIFT, y: spot.y + COPY_SHIFT };
    }
    return spot;
  }

  function createSource({ userId, workspaceId, origin, type, props } = {}) {
    const ws = enter({ userId, workspaceId });
    countCommand(userId, ws);
    const module = sourceType(type);
    if (!module) throw new AppError('source_type_unknown', 400, { field: 'type' });

    return commit(ws, { userId, origin }, () => {
      const change = readChange(props === undefined ? {} : props, module, ws);
      assertRoomForSource(ws.rowId);

      const scene = sql.scene.get(ws.rowId);
      const settings = { ...defaultsOf(module.fields), ...change.settings };
      const width = change.width ?? module.size.width;
      const height = change.height ?? module.size.height;
      // Без указаний источник встаёт по центру сцены
      let spot = {
        x: change.x ?? Math.round((scene.scene_width - width) / 2),
        y: change.y ?? Math.round((scene.scene_height - height) / 2),
      };
      if (change.x === undefined && change.y === undefined) spot = freeSpot(ws.rowId, spot.x, spot.y);
      const publicId = insertSource(ws, {
        type: module.type,
        name: change.name ?? freeName(ws.rowId, module.title),
        x: spot.x,
        y: spot.y,
        width,
        height,
        opacity: change.opacity ?? 100,
        layer: sql.countSources.get(ws.rowId).n, // новый источник — поверх остальных
        visible: change.visible ?? true,
        locked: change.locked ?? false,
        mediaId: change.media?.id ?? null,
        settings,
        state: module.initialState ? module.initialState(settings) : {},
      });
      return { source: sourceView(sql.source.get(publicId, ws.rowId)), order: orderOf(ws.rowId) };
    });
  }

  function updateSource({ userId, workspaceId, origin, sourceId, patch } = {}) {
    const ws = enter({ userId, workspaceId });
    countCommand(userId, ws);

    return commit(ws, { userId, origin }, () => {
      const row = findSource(ws, sourceId);
      const module = sourceType(row.type);
      const change = readChange(patch, module, ws);

      const before = sourceView(row);
      /* Защита от сдвига действует и на сервере: пока она включена, положение и размер
         не меняются — даже если у другого модератора открыта страница, где источник
         ещё выглядит свободным. Правка, в которой человек сам переключает защиту, проходит
         целиком: страница склеивает несколько его действий подряд в одну правку
         («подвинул и включил защиту», «снял защиту, подвинул, вернул»), и порядок
         действий внутри неё серверу уже не виден. */
      if (before.locked && !own(change, 'locked') && GEOMETRY.some((key) => own(change, key) && change[key] !== before[key])) {
        throw new AppError('source_locked', 409);
      }

      const settings = change.settings ? { ...before.settings, ...change.settings } : before.settings;
      let state = before.state ?? {};
      if (module?.stateAfterChange && change.settings) state = module.stateAfterChange(before.settings, settings, state);

      const after = {
        ...before,
        name: change.name ?? before.name,
        x: change.x ?? before.x,
        y: change.y ?? before.y,
        width: change.width ?? before.width,
        height: change.height ?? before.height,
        opacity: change.opacity ?? before.opacity,
        visible: change.visible ?? before.visible,
        locked: change.locked ?? before.locked,
        settings,
      };
      if (module?.media) after.file = own(change, 'media') ? change.media?.public_id ?? null : before.file;
      if (module?.readState) after.state = state;

      if (same(before, after)) return { source: before, unchanged: true };

      const mediaId = own(change, 'media') ? change.media?.id ?? null : row.media_id;
      sql.updateSource.run(
        after.name, after.x, after.y, after.width, after.height, after.opacity,
        after.visible ? 1 : 0, after.locked ? 1 : 0, mediaId,
        // У источника незнакомого типа (модуль убрали) настройки не трогаем: их некому проверить
        module ? JSON.stringify(settings) : row.settings,
        module?.readState ? JSON.stringify(state) : row.state,
        row.id
      );
      return { source: sourceView(sql.sourceById.get(row.id)) };
    });
  }

  function removeSource({ userId, workspaceId, origin, sourceId } = {}) {
    const ws = enter({ userId, workspaceId });
    countCommand(userId, ws);

    return commit(ws, { userId, origin }, () => {
      const row = findSource(ws, sourceId);
      sql.deleteSource.run(row.id);
      writeOrder(sql.sources.all(ws.rowId).map((item) => item.id));
      return { removed: row.public_id, order: orderOf(ws.rowId) };
    });
  }

  function duplicateSource({ userId, workspaceId, origin, sourceId } = {}) {
    const ws = enter({ userId, workspaceId });
    countCommand(userId, ws);

    return commit(ws, { userId, origin }, () => {
      const row = findSource(ws, sourceId);
      assertRoomForSource(ws.rowId);
      const module = sourceType(row.type);
      const settings = module ? readSettings(module.fields, parseJson(row.settings)) : parseJson(row.settings);

      const rows = sql.sources.all(ws.rowId);
      const spot = freeSpot(ws.rowId, Math.min(POSITION_MAX, row.x + COPY_SHIFT), Math.min(POSITION_MAX, row.y + COPY_SHIFT));
      const publicId = insertSource(ws, {
        type: row.type,
        name: copyName(ws.rowId, row.name),
        x: spot.x,
        y: spot.y,
        width: row.width,
        height: row.height,
        opacity: row.opacity,
        layer: rows.length,
        visible: row.visible === 1,
        locked: false, // копию сразу двигают на место
        mediaId: row.media_id,
        settings,
        // Копия таймера начинает свой счёт заново
        state: module?.initialState ? module.initialState(settings) : {},
      });

      // Копия встаёт сразу над оригиналом
      const copy = sql.source.get(publicId, ws.rowId);
      const order = rows.map((item) => item.id);
      order.splice(order.indexOf(row.id) + 1, 0, copy.id);
      writeOrder(order);
      return { source: sourceView(sql.sourceById.get(copy.id)), order: orderOf(ws.rowId) };
    });
  }

  // index — новое место источника в порядке слоёв: 0 — в самом низу
  function moveSource({ userId, workspaceId, origin, sourceId, index } = {}) {
    const ws = enter({ userId, workspaceId });
    countCommand(userId, ws);

    return commit(ws, { userId, origin }, () => {
      const row = findSource(ws, sourceId);
      if (typeof index !== 'number' || !Number.isFinite(index)) {
        throw new AppError('source_field_invalid', 400, { field: 'index' });
      }
      const order = sql.sources.all(ws.rowId).map((item) => item.id);
      const from = order.indexOf(row.id);
      const to = Math.min(order.length - 1, Math.max(0, Math.round(index)));
      if (from === to) return { order: orderOf(ws.rowId), unchanged: true };
      order.splice(from, 1);
      order.splice(to, 0, row.id);
      writeOrder(order);
      return { order: orderOf(ws.rowId) };
    });
  }

  /* Команда источнику (таймеру: пуск, пауза, сброс). Новое состояние вычисляет модуль
     типа, время берётся по часам сервера. Страница состояние прислать не может —
     только попросить о действии. */
  function commandSource({ userId, workspaceId, origin, sourceId, action } = {}) {
    const ws = enter({ userId, workspaceId });
    countCommand(userId, ws);

    return commit(ws, { userId, origin }, () => {
      const row = findSource(ws, sourceId);
      const module = sourceType(row.type);
      if (!module?.command) throw new AppError('source_no_commands', 409);

      const before = sourceView(row);
      // Команды бывают не у всякого источника этого типа: таймеру в режиме часов управлять нечем
      if (module.hasCommands && !module.hasCommands(before.settings)) throw new AppError('source_no_commands', 409);
      const state = typeof action === 'string' ? module.command(before.settings, before.state, action, now()) : null;
      if (!state) throw new AppError('source_command_unknown', 400, { field: 'action' });
      if (same(state, before.state)) return { source: before, unchanged: true };

      sql.setState.run(JSON.stringify(state), row.id);
      return { source: sourceView(sql.sourceById.get(row.id)) };
    });
  }

  /* ---------- Файлы ---------- */

  // Название файла — только для показа человеку; на диске файл лежит под случайным номером
  function cleanFileName(raw) {
    let text = typeof raw === 'string' ? raw : '';
    try {
      text = decodeURIComponent(text);
    } catch {
      text = '';
    }
    const name = cleanLine(text.split(/[\\/]/).pop() || '');
    return [...name].slice(0, FILE_NAME_MAX).join('') || 'Без названия';
  }

  function assertRoomForFile(workspaceRowId, bytes) {
    const used = sql.usage.get(workspaceRowId);
    if (used.files >= rules.filesPerWorkspace) {
      throw new AppError('files_limit', 409, { limit: rules.filesPerWorkspace });
    }
    if (used.bytes + bytes > rules.storageBytesPerWorkspace) {
      throw new AppError('storage_limit', 409, { limitBytes: rules.storageBytesPerWorkspace });
    }
    if (sql.totalBytes.get().bytes + bytes > rules.storageBytesTotal) {
      throw new AppError('server_storage_full', 507);
    }
  }

  /* Загрузка файла. stream — тело запроса как есть: файл не помещается в память
     целиком, а пишется на диск по мере прихода. Что это за файл, решается по его
     содержимому (см. storage.js); имя и заявленный тип не учитываются. */
  async function upload({ userId, workspaceId, origin, stream, fileName, declaredBytes } = {}) {
    // Посторонний получает отказ сразу: его файл сервер даже не читает
    const ws = enter({ userId, workspaceId });

    const key = `upload:${userId}`;
    const declared = Number(declaredBytes);
    try {
      assertNotTooOften(key, rules.uploadsPerUser);
      if (Number.isFinite(declared) && declared > largestFile) {
        throw new AppError('file_too_large', 413, { limitBytes: largestFile });
      }
      // Места уже нет — незачем принимать файл, чтобы потом его выбросить
      assertRoomForFile(ws.rowId, Number.isFinite(declared) && declared > 0 ? declared : 1);
      if ((uploading.get(userId) || 0) >= rules.uploadsAtOncePerUser || uploadingTotal >= rules.uploadsAtOnce) {
        throw new AppError('server_busy', 503);
      }
    } catch (err) {
      await storage.skip(stream, drainLimit);
      throw err;
    }

    limiter.hit(key, rules.uploadsPerUser);
    uploading.set(userId, (uploading.get(userId) || 0) + 1);
    uploadingTotal += 1;
    try {
      const received = await storage.receive(stream, {
        limitFor: (kind) => rules.fileBytes[kind],
        drainLimit,
        imageMaxSide: rules.imageMaxSide,
        imageMaxPixels: rules.imageMaxPixels,
      });
      try {
        // Пока файл загружался, человека могли убрать из команды, а место — занять
        const again = enter({ userId, workspaceId });
        return commit(again, { userId, origin }, () => {
          assertRoomForFile(again.rowId, received.bytes);
          let fileId;
          for (let attempt = 1; ; attempt += 1) {
            fileId = newLinkToken(FILE_ID_LENGTH);
            try {
              sql.insertMedia.run(
                fileId, again.rowId, userId, received.kind, received.mime, received.bytes,
                received.width, received.height, cleanFileName(fileName), now()
              );
              break;
            } catch (err) {
              if (!isUniqueViolation(err) || attempt >= 5) throw err;
            }
          }
          storage.keep(received.tmpPath, again.publicId, fileId);
          return { file: mediaView(sql.mediaFile.get(fileId, again.rowId)), usage: usageOf(again.rowId) };
        });
      } catch (err) {
        storage.discard(received.tmpPath);
        throw err;
      }
    } finally {
      uploadingTotal -= 1;
      const left = (uploading.get(userId) || 1) - 1;
      if (left > 0) uploading.set(userId, left);
      else uploading.delete(userId);
    }
  }

  function removeMedia({ userId, workspaceId, origin, fileId } = {}) {
    const ws = enter({ userId, workspaceId });
    countCommand(userId, ws);

    const answer = commit(ws, { userId, origin }, () => {
      const file = findMedia(ws, fileId);
      // Файл, который показывается на сцене, не удаляется: сначала его убирают из источников
      if (file.used_by > 0) throw new AppError('media_in_use', 409, { count: file.used_by });
      sql.deleteMedia.run(file.id);
      return { removed: file.public_id, usage: usageOf(ws.rowId) };
    });
    storage.remove(ws.publicId, answer.removed);
    return answer;
  }

  // Где лежит файл и как его отдавать. Тип — тот, что определён по содержимому при загрузке
  function openMedia({ userId, workspaceId, fileId } = {}) {
    const ws = enter({ userId, workspaceId });
    const file = findMedia(ws, fileId);
    return { ...storage.locate(ws.publicId, file.public_id), mime: file.mime, size: file.size_bytes };
  }

  /* ---------- Оверлей (по ссылке, без входа) ----------
     Сюда попадает только то, без чего сцену не нарисовать. Скрытые источники,
     названия источников и файлов, имена людей, пределы площадки и её номер
     по ссылке оверлея не уходят. */

  function enterOverlay({ token } = {}) {
    return workspaces.enterOverlay({ token });
  }

  /* Настройки, которые сейчас ни на что не влияют, в эфир тоже не уходят: вместо них —
     значения по умолчанию. Виджет, который показывает шкалу цели, хранит ещё и текст
     бегущей строки, и код своего блока — заготовки на потом; пока они не на сцене,
     по ссылке оверлея их не узнать. «Не влияет» — это то же условие, по которому поле
     скрыто в панели свойств (when в описании поля). */
  function onAirSettings(fields, settings) {
    const result = {};
    for (const [key, field] of Object.entries(fields)) {
      result[key] = isShown(field, settings) ? settings[key] : field.default;
    }
    return result;
  }

  function overlaySourceView(row) {
    const shown = sourceView(row);
    // Название и защита от сдвига нужны только редактору
    delete shown.name;
    delete shown.locked;
    const module = sourceType(row.type);
    if (module) shown.settings = onAirSettings(module.fields, shown.settings);
    return shown;
  }

  function overlayScene({ token } = {}) {
    const ws = enterOverlay({ token });
    const scene = sql.scene.get(ws.rowId);
    return {
      scene: { width: scene.scene_width, height: scene.scene_height, version: scene.scene_version },
      sources: sql.visibleSources.all(ws.rowId).map(overlaySourceView), // снизу вверх
      // Часы сервера: по ним оверлей считает таймеры — так же, как редактор
      serverTime: now(),
    };
  }

  /* Файл для оверлея. Отдаётся, только пока он в эфире: файл из библиотеки и файл
     скрытого источника по ссылке оверлея получить нельзя, даже зная его номер. */
  function openOverlayMedia({ token, fileId } = {}) {
    const ws = enterOverlay({ token });
    const file = isLinkToken(fileId, FILE_ID_LENGTH) ? sql.mediaOnAir.get(fileId, ws.rowId) : null;
    if (!file) throw new AppError('media_not_found', 404);
    return { ...storage.locate(ws.publicId, file.public_id), mime: file.mime, size: file.size_bytes };
  }

  /* ---------- Служебное (не от имени человека) ---------- */

  // Площадку удалили: записи о файлах ушли вместе с ней, остаются сами файлы
  function forgetWorkspace(workspacePublicId) {
    storage.removeWorkspace(workspacePublicId);
  }

  // Раз в час: устаревшие счётчики и файлы, о которых база не знает
  function cleanup() {
    limiter.sweep();
    return storage.sweep({
      hasWorkspace: (workspaceId) => Boolean(sql.workspaceExists.get(workspaceId)),
      hasFile: (workspaceId, fileId) => Boolean(sql.fileExists.get(fileId, workspaceId)),
    });
  }

  /* Остановка сервера: соединения уже закрыты, и оборванным загрузкам нужно мгновение,
     чтобы убрать за собой недокачанные файлы. Ждём их, но недолго. */
  async function settle(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (uploadingTotal > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  return {
    get,
    createSource,
    updateSource,
    removeSource,
    duplicateSource,
    moveSource,
    commandSource,
    upload,
    removeMedia,
    openMedia,
    overlayScene,
    openOverlayMedia,
    forgetWorkspace,
    cleanup,
    settle,
    uploadIdleMs: rules.uploadIdleMs,
  };
}
