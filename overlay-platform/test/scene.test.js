import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createServerClock } from '../public/js/scene/clock.js';
import { FIELD_KINDS, checkValue, defaultsOf, isShown, readSettings } from '../public/js/scene/schema.js';
import { ACCEPTED_FORMATS, ACCEPT_ATTRIBUTE, HEAD_BYTES, formatName, readJpegSize, sniffFile } from '../public/js/scene/sniff.js';
import { SOURCE_LIST, sourceType } from '../public/js/scene/sources/index.js';
import {
  TIMER_MAX_SECONDS, applyTimerCommand, formatClock, formatDuration, initialTimerState, readTimerState,
  timerPhase, timerText, timerValue,
} from '../public/js/scene/timer.js';
import { createAccounts } from '../src/server/auth/accounts.js';
import { safeNextPath } from '../src/server/auth/http.js';
import { isLinkToken, newLinkToken } from '../src/server/auth/tokens.js';
import { openDatabase } from '../src/server/db/database.js';
import { DEFAULT_SCENE_LIMITS } from '../src/server/scene/scene.js';
import {
  FAST, GOOD_PASSWORD, LATEST_MIGRATION, MINUTE, PLATFORM_STAGE, PROJECT_DIR, SCHEMA_VERSION,
  addModerator, addSource, createVisitor, createWorkspace, newStage, openSocket, patchSource, png, pngChunk,
  refusal, registerUser, sceneOf, startServer, uploadFile, waitFor, within,
} from './helpers.js';

/* Этап 5: сцена и редактор. Проверяется настоящий сервер с настоящей базой и
   настоящей папкой файлов: источники семи типов, слои, файлы, таймеры и — главное —
   права: со сценой работают владелец и модераторы, и больше никто. */

const HOUR = 60 * MINUTE;
const KB = 1024;
const MB = 1024 * KB;
const PUBLIC_ID = /^[0-9a-hjkmnp-tv-z]{12}$/; // номер площадки, источника или файла
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEVEN_TYPES = ['text', 'image', 'gif', 'video', 'shape', 'timer', 'widget'];

/* ---------- Файлы для загрузки ----------
   Сервер решает, что это за файл, по его содержимому. Поэтому проверочные файлы
   собираются по байтам: настоящие заголовки настоящих форматов. Картинка PNG нужна
   и проверкам оверлея — она лежит в helpers.js. */

// JPEG: начало файла и блок с размерами. frame: false — блока с размерами нет
function jpeg(width = 6, height = 5, { frame = true } = {}) {
  const parts = [
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ];
  if (frame) {
    parts.push(Buffer.from([
      0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255,
      0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]));
  }
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/* JPEG «как из фотоаппарата»: перед размерами лежат служебные блоки — сведения о съёмке
   с уменьшенной копией (десятки килобайт), цветовой профиль, таблицы. Размеры оказываются
   далеко за первыми байтами файла, и серверу приходится их искать. */
function cameraJpeg(width = 4032, height = 3024, { progressive = false, exifBytes = 60_000 } = {}) {
  const segment = (marker, body) => {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([head, body]);
  };
  const frame = Buffer.from([0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.alloc(exifBytes, 0xff)])), // внутри — байты, похожие на начала блоков
    segment(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.alloc(3000, 0x41)])),
    Buffer.from([0xff, 0xff, 0xff]), // заполнитель между блоками
    segment(0xdb, Buffer.alloc(65, 1)),
    segment(0xc4, Buffer.alloc(30, 2)), // таблица: её номер соседствует с номерами блоков размеров
    segment(progressive ? 0xc2 : 0xc0, frame),
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.alloc(500, 0x55),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function gif(width = 8, height = 7) {
  const bytes = Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

// WebP бывает трёх видов; у каждого размеры записаны по-своему
function webp(width = 10, height = 9, flavour = 'VP8X') {
  let chunk;
  if (flavour === 'VP8X') {
    chunk = Buffer.alloc(18);
    chunk.write('VP8X', 0, 'latin1');
    chunk.writeUInt32LE(10, 4);
    chunk.writeUIntLE(width - 1, 12, 3);
    chunk.writeUIntLE(height - 1, 15, 3);
  } else if (flavour === 'VP8L') {
    chunk = Buffer.alloc(13);
    chunk.write('VP8L', 0, 'latin1');
    chunk.writeUInt32LE(5, 4);
    chunk[8] = 0x2f;
    chunk.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 9);
  } else {
    chunk = Buffer.alloc(18);
    chunk.write('VP8 ', 0, 'latin1');
    chunk.writeUInt32LE(10, 4);
    chunk.set([0x9d, 0x01, 0x2a], 11);
    chunk.writeUInt16LE(width, 14);
    chunk.writeUInt16LE(height, 16);
  }
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + chunk.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, chunk]);
}

// Семейство MP4: файл называет свою «марку» и совместимые с ней
function mp4({ major = 'isom', brands = ['isom', 'iso2', 'avc1', 'mp41'] } = {}) {
  const box = Buffer.alloc(16 + brands.length * 4);
  box.writeUInt32BE(box.length, 0);
  box.write('ftyp', 4, 'latin1');
  box.write(major, 8, 'latin1');
  box.writeUInt32BE(0x200, 12);
  brands.forEach((brand, i) => box.write(brand, 16 + i * 4, 'latin1'));
  return Buffer.concat([box, Buffer.from('0000000866726565', 'hex'), Buffer.alloc(72)]);
}

// WebM и MKV — один контейнер; отличаются только тем, как файл себя назвал
function ebml(docType = 'webm') {
  const name = Buffer.from(docType, 'latin1');
  const body = Buffer.concat([
    Buffer.from([0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08]),
    Buffer.from([0x42, 0x82, 0x80 | name.length]), name,
    Buffer.from([0x42, 0x87, 0x81, 0x04, 0x42, 0x85, 0x81, 0x02]),
  ]);
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | body.length]), body, Buffer.from([0x18, 0x53, 0x80, 0x67]), Buffer.alloc(72)]);
}

const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');

// Файл ровно такого размера: к содержимому дописываются нули (размер сервер считает по байтам)
const sized = (bytes, size) => {
  assert.ok(size >= bytes.length, 'файл уже длиннее нужного размера');
  return Buffer.concat([bytes, Buffer.alloc(size - bytes.length)]);
};

/* ---------- Площадка, команда, сцена ----------
   Создание площадки, источников и файлов — в helpers.js: оно нужно и проверкам оверлея. */

const call = (visitor, method, url, body) => {
  if (method === 'GET') return visitor.get(url);
  if (method === 'PATCH') return visitor.patch(url, body);
  if (method === 'UPLOAD') return visitor.upload(url, body, { name: 'попытка.png' });
  return visitor.post(url, body);
};

// Всё, что лежит в папке загрузок: относительный путь и размер каждого файла
function filesOnDisk(dir) {
  const found = [];
  (function walk(folder, prefix) {
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else found.push(`${prefix}${entry.name}:${fs.statSync(full).size}`);
    }
  })(dir, '');
  return found.sort();
}

const uploadsDir = (ctx) => path.join(ctx.tmpDir, 'uploads');

// Сцены всех площадок и все файлы целиком: после чужих попыток это должно остаться прежним
const sceneState = (ctx) => JSON.stringify({
  workspaces: ctx.db.prepare('SELECT id, name, scene_width, scene_height, scene_version FROM workspaces ORDER BY id').all(),
  sources: ctx.db.prepare('SELECT * FROM sources ORDER BY id').all(),
  media: ctx.db.prepare('SELECT * FROM media_files ORDER BY id').all(),
  disk: filesOnDisk(uploadsDir(ctx)),
});

/* Загрузка «по частям», как её ведёт браузер при медленной связи: размер заранее
   не объявлен, а между частями можно сделать паузу или оборвать соединение. */
function slowUpload(ctx, visitor, workspaceId, { headers = {} } = {}) {
  const target = new URL(`/api/workspaces/${workspaceId}/scene/media`, ctx.baseUrl);
  const req = http.request({
    host: target.hostname,
    port: target.port,
    path: target.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('медленный.png'),
      Cookie: [...visitor.jar].map(([name, value]) => `${name}=${value}`).join('; '),
      ...headers,
    },
  });
  const answer = new Promise((resolve) => {
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          // ответ не в формате JSON
        }
        resolve({ status: res.statusCode, data, text, headers: res.headers });
      });
    });
    // Оборванное соединение — тоже исход: ответа не будет
    req.on('error', (err) => resolve({ status: 0, data: null, text: String(err?.code || err) }));
  });
  const write = (bytes) => new Promise((resolve) => req.write(bytes, resolve));
  return { req, answer, write, finish: (bytes) => { req.end(bytes); return answer; } };
}

/* Запрос «как есть», без добавок: встроенный fetch к запросу с If-None-Match сам дописывает
   «не бери из памяти», и сервер честно отдаёт файл заново. Браузер так не делает. */
function plainGet(ctx, visitor, url, headers = {}) {
  const target = new URL(url, ctx.baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: { Cookie: [...visitor.jar].map(([name, value]) => `${name}=${value}`).join('; '), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

/* ========================================================================== */

describe('Этап 5 — сцена и источники', () => {
  let ctx;
  before(async () => { ctx = await startServer(); });
  after(async () => { await ctx.stop(); });

  it('у новой площадки пустая сцена 1920 × 1080; ответ содержит пределы и время сервера', async () => {
    const { visitor, workspace } = await newStage(ctx, { name: 'Ночной эфир' });
    const before = Date.now();
    const res = await visitor.get(`/api/workspaces/${workspace.id}/scene`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(res.data.serverTime >= before && res.data.serverTime <= Date.now(), 'время сервера — в миллисекундах, сейчас');
    assert.deepEqual(res.data, {
      ok: true,
      workspace: { id: workspace.id, name: 'Ночной эфир', role: 'owner' },
      scene: { width: 1920, height: 1080, version: 0 },
      sources: [],
      media: [],
      usage: { files: 0, storageBytes: 0 },
      limits: { sources: 100, files: 200, storageBytes: 200 * MB, fileBytes: { image: 10 * MB, gif: 20 * MB, video: 50 * MB } },
      serverTime: res.data.serverTime,
    });
    // Пределы в ответе — те самые, по которым сервер отказывает
    assert.equal(DEFAULT_SCENE_LIMITS.sourcesPerScene, 100);
    assert.equal(DEFAULT_SCENE_LIMITS.storageBytesTotal, 5 * 1024 * MB);
  });

  it('типов источников семь; каждый появляется по центру сцены со своим размером и настройками по умолчанию', async () => {
    assert.deepEqual(SOURCE_LIST.map((module) => module.type), SEVEN_TYPES);
    const { visitor, id, api } = await newStage(ctx);

    const created = [];
    for (const [index, type] of SEVEN_TYPES.entries()) {
      const module = sourceType(type);
      const res = await visitor.post(`${api}/sources`, { type });
      assert.equal(res.status, 201, `${type}: ${res.text}`);
      const { source, order, version } = res.data;
      assert.deepEqual(Object.keys(res.data).sort(), ['ok', 'order', 'source', 'version']);
      assert.equal(version, index + 1, 'каждое изменение сцены — плюс одна версия');
      assert.match(source.id, PUBLIC_ID);

      const expected = {
        id: source.id,
        type,
        name: module.title,
        x: Math.round((1920 - module.size.width) / 2),
        y: Math.round((1080 - module.size.height) / 2),
        width: module.size.width,
        height: module.size.height,
        opacity: 100,
        visible: true,
        locked: false,
        settings: defaultsOf(module.fields),
      };
      // Файл есть только у картинки, GIF и видео; ход — только у таймера
      if (['image', 'gif', 'video'].includes(type)) expected.file = null;
      if (type === 'timer') expected.state = { running: false, base: 300_000, since: 0 };
      assert.deepEqual(source, expected, type);

      created.push(source.id);
      assert.deepEqual(order, created, 'новый источник ложится поверх остальных');
    }

    const scene = await sceneOf(visitor, id);
    assert.equal(scene.scene.version, 7);
    assert.deepEqual(scene.sources.map((source) => source.id), created, 'список — снизу вверх');
    assert.deepEqual(scene.sources.map((source) => source.name), ['Текст', 'Картинка', 'GIF', 'Видео', 'Фигура', 'Таймер', 'Виджет']);

    // В базе слои идут подряд, без пропусков
    const layers = ctx.db.prepare(`
      SELECT s.layer FROM sources s JOIN workspaces w ON w.id = s.workspace_id WHERE w.public_id = ? ORDER BY s.layer
    `).all(id).map((row) => row.layer);
    assert.deepEqual(layers, [0, 1, 2, 3, 4, 5, 6]);
  });

  it('второй такой же источник получает своё название и встаёт чуть в стороне, а не точно поверх первого', async () => {
    const { visitor, id } = await newStage(ctx);
    const first = await addSource(visitor, id, 'text');
    const second = await addSource(visitor, id, 'text');
    const third = await addSource(visitor, id, 'text');
    assert.deepEqual([first.name, second.name, third.name], ['Текст', 'Текст 2', 'Текст 3']);
    assert.deepEqual([[first.x, first.y], [second.x, second.y], [third.x, third.y]], [[600, 450], [624, 474], [648, 498]]);

    // Освободившееся название занимается снова; регистр букв не важен
    assert.equal((await patchSource(visitor, id, second.id, { name: 'ТЕКСТ 4' })).status, 200);
    assert.equal((await addSource(visitor, id, 'text')).name, 'Текст 2');
    assert.equal((await addSource(visitor, id, 'text')).name, 'Текст 5');

    // Место, названное явно, сервер не «поправляет» — даже если там уже кто-то стоит
    const exact = await addSource(visitor, id, 'text', { x: 600, y: 450 });
    assert.deepEqual([exact.x, exact.y], [600, 450]);
    // Источник другого размера встаёт по своему центру: его угол ни с кем не совпал
    const timer = await addSource(visitor, id, 'timer');
    assert.deepEqual([timer.x, timer.y], [740, 455]);
  });

  it('источник можно создать сразу с названием, местом, размером и настройками; остальное берётся по умолчанию', async () => {
    const { visitor, id } = await newStage(ctx);
    const source = await addSource(visitor, id, 'shape', {
      name: '  Подложка   под чат ',
      x: -40.4,
      y: 1000.5,
      width: 300.6,
      height: 8,
      opacity: 35,
      visible: false,
      locked: true,
      settings: { fill: 'gradient', color: '#FFAA00', angle: 90 },
    });
    assert.equal(source.name, 'Подложка под чат');
    assert.deepEqual([source.x, source.y, source.width, source.height], [-40, 1001, 301, 8], 'дробные числа округляются');
    assert.deepEqual([source.opacity, source.visible, source.locked], [35, false, true]);
    assert.deepEqual(source.settings, { ...defaultsOf(sourceType('shape').fields), fill: 'gradient', color: '#ffaa00', angle: 90 });

    for (const [body, error, field] of [
      [{ type: 'hologram' }, 'source_type_unknown', 'type'],
      [{}, 'source_type_unknown', 'type'],
      [{ type: ['text'] }, 'source_type_unknown', 'type'],
      [{ type: 'constructor' }, 'source_type_unknown', 'type'],
      [{ type: '__proto__' }, 'source_type_unknown', 'type'],
      [{ type: 'text', props: 'текст' }, 'source_field_invalid', ''],
      [{ type: 'text', props: [] }, 'source_field_invalid', ''],
      [{ type: 'text', props: null }, 'source_field_invalid', ''],
      [{ type: 'text', props: { id: 'свой-номер' } }, 'source_field_invalid', 'id'],
      [{ type: 'text', props: { type: 'video' } }, 'source_field_invalid', 'type'],
      [{ type: 'text', props: { layer: 0 } }, 'source_field_invalid', 'layer'],
      [{ type: 'text', props: { width: 7 } }, 'source_geometry_invalid', 'width'],
      [{ type: 'text', props: { settings: { text: 5 } } }, 'source_setting_invalid', 'settings.text'],
    ]) {
      refusal(await visitor.post(`/api/workspaces/${id}/scene/sources`, body), 400, error, { field });
    }
    const scene = await sceneOf(visitor, id);
    assert.equal(scene.sources.length, 1, 'отказанные попытки ничего не создали');
    assert.equal(scene.scene.version, 1);
  });

  it('правка меняет только присланное; настройки дополняются, а не заменяются', async () => {
    const { visitor, id } = await newStage(ctx);
    const text = await addSource(visitor, id, 'text');
    const defaults = defaultsOf(sourceType('text').fields);

    const moved = await patchSource(visitor, id, text.id, { x: 12.4, y: -7.6 });
    assert.equal(moved.status, 200);
    assert.deepEqual(Object.keys(moved.data).sort(), ['ok', 'source', 'version']);
    assert.equal(moved.data.version, 2);
    assert.deepEqual(moved.data.source, { ...text, x: 12, y: -8 });

    const styled = await patchSource(visitor, id, text.id, { settings: { text: 'Начинаем через пять минут', size: 96 } });
    assert.deepEqual(styled.data.source.settings, { ...defaults, text: 'Начинаем через пять минут', size: 96 });
    const recoloured = await patchSource(visitor, id, text.id, { settings: { color: '#A31313' } });
    assert.deepEqual(
      recoloured.data.source.settings,
      { ...defaults, text: 'Начинаем через пять минут', size: 96, color: '#a31313' },
      'прежние настройки остались на месте'
    );

    const all = await patchSource(visitor, id, text.id, {
      name: 'Заголовок', x: 100, y: 200, width: 900, height: 120, opacity: 80, visible: false, locked: true,
    });
    assert.equal(all.status, 200);
    assert.deepEqual(all.data.source, {
      ...text, name: 'Заголовок', x: 100, y: 200, width: 900, height: 120, opacity: 80, visible: false, locked: true,
      settings: recoloured.data.source.settings,
    });
    assert.deepEqual((await sceneOf(visitor, id)).sources, [all.data.source], 'сохранено именно то, что ответил сервер');
  });

  it('название: обязательно, до 40 знаков, приводится к аккуратному виду и остаётся текстом', async () => {
    const { visitor, id } = await newStage(ctx);
    const source = await addSource(visitor, id, 'text');
    const rename = (name) => patchSource(visitor, id, source.id, { name });

    assert.equal((await rename('  Заголовок \u200b  эфира\n')).data.source.name, 'Заголовок эфира');
    const markup = '<img src=x onerror=alert(1)>';
    assert.equal((await rename(markup)).data.source.name, markup, 'разметка в названии — просто буквы');
    assert.equal((await rename('я'.repeat(40))).status, 200);
    assert.equal((await rename('🎬'.repeat(40))).status, 200, 'смайлик считается одним знаком');

    refusal(await rename('я'.repeat(41)), 400, 'source_name_too_long', { field: 'name' });
    for (const empty of ['', '   ', '\u200b\u200b', '\n\t']) {
      refusal(await rename(empty), 400, 'source_name_required', { field: 'name' });
    }
    for (const wrong of [null, 42, ['Название'], { a: 1 }, true]) {
      refusal(await rename(wrong), 400, 'source_name_required', { field: 'name' });
    }
    assert.equal((await sceneOf(visitor, id)).sources[0].name, '🎬'.repeat(40));

    // Одинаковые названия не запрещены: человек сам решает, как называть слои
    const twin = await addSource(visitor, id, 'text', { name: '🎬'.repeat(40) });
    assert.equal(twin.name, '🎬'.repeat(40));
  });

  it('положение и размер: только числа в допустимых пределах', async () => {
    const { visitor, id } = await newStage(ctx);
    const source = await addSource(visitor, id, 'shape');
    const patch = (body) => patchSource(visitor, id, source.id, body);

    // Края допустимого
    for (const body of [
      { x: -8192, y: 8192 }, { x: 8192, y: -8192 }, { width: 8, height: 8192 }, { width: 8192, height: 8 }, { opacity: 0 }, { opacity: 100 },
    ]) {
      assert.equal((await patch(body)).status, 200, JSON.stringify(body));
    }
    const kept = (await sceneOf(visitor, id)).sources[0];

    const bad = [
      [{ x: -8193 }, 'source_geometry_invalid', 'x'],
      [{ x: 8193 }, 'source_geometry_invalid', 'x'],
      [{ y: 1e9 }, 'source_geometry_invalid', 'y'],
      [{ width: 7 }, 'source_geometry_invalid', 'width'],
      [{ width: 0 }, 'source_geometry_invalid', 'width'],
      [{ width: -100 }, 'source_geometry_invalid', 'width'],
      [{ height: 8193 }, 'source_geometry_invalid', 'height'],
      [{ x: '100' }, 'source_geometry_invalid', 'x'],
      [{ y: null }, 'source_geometry_invalid', 'y'],
      [{ width: [300] }, 'source_geometry_invalid', 'width'],
      [{ height: true }, 'source_geometry_invalid', 'height'],
      [{ opacity: -1 }, 'source_field_invalid', 'opacity'],
      [{ opacity: 101 }, 'source_field_invalid', 'opacity'],
      [{ opacity: '50' }, 'source_field_invalid', 'opacity'],
      [{ visible: 'да' }, 'source_field_invalid', 'visible'],
      [{ visible: 1 }, 'source_field_invalid', 'visible'],
      [{ locked: null }, 'source_field_invalid', 'locked'],
      // Незнакомое поле — отказ, а не молчаливый пропуск: иначе страница решила бы, что всё сохранено
      [{ rotation: 45 }, 'source_field_invalid', 'rotation'],
      [{ id: newLinkToken(12) }, 'source_field_invalid', 'id'],
      [{ type: 'text' }, 'source_field_invalid', 'type'],
      [{ layer: 3 }, 'source_field_invalid', 'layer'],
      [{ workspace_id: 1 }, 'source_field_invalid', 'workspace_id'],
      [{ state: { running: true } }, 'source_field_invalid', 'state'],
      // Одно негодное поле отменяет всю правку целиком
      [{ x: 10, width: 5 }, 'source_geometry_invalid', 'width'],
      // Фигуре файл не нужен
      [{ file: null }, 'source_field_invalid', 'file'],
    ];
    for (const [body, error, field] of bad) refusal(await patch(body), 400, error, { field });

    const after = await sceneOf(visitor, id);
    assert.deepEqual(after.sources[0], kept, 'отказанные правки ничего не изменили');
    assert.equal(after.scene.version, 7, 'и версию сцены не тронули');
  });

  it('настройки проверяются по описанию типа: негодное значение — отказ с названием поля', async () => {
    const { visitor, id } = await newStage(ctx);
    const text = await addSource(visitor, id, 'text');
    const shape = await addSource(visitor, id, 'shape');
    const widget = await addSource(visitor, id, 'widget');
    const set = (source, settings) => patchSource(visitor, id, source.id, { settings });
    const invalid = async (source, settings, field) =>
      refusal(await set(source, settings), 400, 'source_setting_invalid', { field: field ? `settings.${field}` : 'settings' });

    // Текст: до 500 знаков и 20 строк; переносы сохраняются, управляющие знаки убираются
    const kept = await set(text, { text: 'Первая\r\nвторая\tстрока\u0007' });
    assert.equal(kept.data.source.settings.text, 'Первая\nвторая строка');
    assert.equal((await set(text, { text: 'я'.repeat(500) })).status, 200);
    assert.equal((await set(text, { text: Array(20).fill('строка').join('\n') })).status, 200);
    assert.equal((await set(text, { text: '' })).status, 200, 'пустой текст допустим');
    await invalid(text, { text: 'я'.repeat(501) }, 'text');
    await invalid(text, { text: Array(21).fill('с').join('\n') }, 'text');
    await invalid(text, { text: 42 }, 'text');
    await invalid(text, { text: null }, 'text');

    // Что бы человек ни написал, это хранится и возвращается как текст — буква в букву
    const markup = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    assert.equal((await set(text, { text: markup })).data.source.settings.text, markup);

    // Числа, выбор из списка, цвет, да / нет
    assert.equal((await set(text, { size: 8 })).status, 200);
    assert.equal((await set(text, { size: 400 })).status, 200);
    assert.equal((await set(text, { size: 71.6 })).data.source.settings.size, 72);
    await invalid(text, { size: 7 }, 'size');
    await invalid(text, { size: 401 }, 'size');
    await invalid(text, { size: '72' }, 'size');
    await invalid(text, { font: 'comic' }, 'font');
    await invalid(text, { font: ['heading'] }, 'font');
    await invalid(text, { align: 'justify' }, 'align');
    await invalid(text, { bold: 'true' }, 'bold');
    await invalid(text, { bold: 1 }, 'bold');
    assert.equal((await set(shape, { color: '#ABCDEF' })).data.source.settings.color, '#abcdef');
    for (const color of ['red', '#fff', '#12345g', 'rgb(1,2,3)', '#1234567', 'url(https://evil.example/x)', 123456, null]) {
      await invalid(shape, { color }, 'color');
    }

    // Чужая и незнакомая настройка
    await invalid(text, { fill: 'solid' }, 'fill');
    await invalid(shape, { text: 'привет' }, 'text');
    await invalid(text, { __proto__: { size: 99 }, constructor: 1 }, 'constructor');
    for (const wrong of ['size=99', 42, null, [['size', 99]], true]) await invalid(text, wrong, '');

    // Одна негодная настройка отменяет все, что пришли вместе с ней
    const before = (await sceneOf(visitor, id)).sources[0].settings;
    await invalid(text, { italic: true, size: 9999 }, 'size');
    assert.deepEqual((await sceneOf(visitor, id)).sources[0].settings, before);

    // Свой блок: код хранится как есть, до 20 000 знаков. Опасное из него убирается при показе, в рамке
    const code = '<style>b{color:red}</style><b onclick="x()">Блок</b><script>alert(1)</script>';
    const block = await set(widget, { kind: 'html', html: code });
    assert.equal(block.data.source.settings.html, code);
    assert.equal((await set(widget, { html: 'я'.repeat(20_000) })).status, 200);
    await invalid(widget, { html: 'я'.repeat(20_001) }, 'html');
    await invalid(widget, { html: ['<b>'] }, 'html');
    await invalid(widget, { kind: 'chat' }, 'kind');
    await invalid(widget, { goalTarget: 0 }, 'goalTarget');
    assert.equal((await set(widget, { goalTitle: 'Одна\nстрока' })).data.source.settings.goalTitle, 'Одна строка', 'короткое поле — всегда одна строка');
  });

  it('правка, которая ничего не меняет, версию сцены не трогает', async () => {
    const { visitor, id } = await newStage(ctx);
    const source = await addSource(visitor, id, 'text', { x: 10, y: 20 });
    const same = [
      { x: 10 }, { x: 10.2, y: 19.8 }, { name: 'Текст' }, { name: '  Текст ' }, { opacity: 100, visible: true, locked: false },
      { settings: { text: 'Новый текст' } }, { settings: {} }, {},
    ];
    for (const body of same) {
      const res = await patchSource(visitor, id, source.id, body);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(res.data.version, 1, `версия выросла после правки ${JSON.stringify(body)}`);
      assert.deepEqual(res.data.source, source);
    }
    assert.equal((await sceneOf(visitor, id)).scene.version, 1);
  });

  it('защита от сдвига действует на сервере: защищённый источник не двигается и не меняет размер', async () => {
    const { visitor, id } = await newStage(ctx);
    const source = await addSource(visitor, id, 'shape', { x: 100, y: 100, width: 300, height: 200, locked: true });
    const patch = (body) => patchSource(visitor, id, source.id, body);

    for (const body of [{ x: 101 }, { y: 0 }, { width: 301 }, { height: 8 }, { x: 5, y: 5, width: 50, height: 50 }, { name: 'Сдвинут', x: 0 }]) {
      refusal(await patch(body), 409, 'source_locked');
    }
    let now = (await sceneOf(visitor, id)).sources[0];
    assert.deepEqual(now, source, 'ничего не изменилось — в том числе название из отказанной правки');

    // Всё, кроме положения и размера, менять можно
    assert.equal((await patch({ name: 'Фон', opacity: 50, visible: false, settings: { color: '#112233' } })).status, 200);
    // Те же самые числа сдвигом не считаются: страница присылает их вместе с другими полями
    assert.equal((await patch({ x: 100, y: 100, width: 300, height: 200, opacity: 60 })).status, 200);

    // Правка, в которой человек сам переключает защиту, проходит целиком
    const unlocked = await patch({ locked: false, x: 400, y: 300 });
    assert.equal(unlocked.status, 200);
    assert.deepEqual([unlocked.data.source.locked, unlocked.data.source.x, unlocked.data.source.y], [false, 400, 300]);
    const relocked = await patch({ locked: true, width: 640 });
    assert.deepEqual([relocked.data.source.locked, relocked.data.source.width], [true, 640]);
    // «Снял защиту, подвинул, вернул» — страница склеивает это в одну правку
    const through = await patch({ locked: true, x: 0, y: 0 });
    assert.equal(through.status, 200);
    now = through.data.source;
    assert.deepEqual([now.locked, now.x, now.y], [true, 0, 0]);
    refusal(await patch({ x: 1 }), 409, 'source_locked');

    // Защита не мешает ни удалить источник, ни переложить слой, ни сделать копию
    const base = `/api/workspaces/${id}/scene/sources/${source.id}`;
    assert.equal((await visitor.post(`${base}/duplicate`)).status, 201);
    assert.equal((await visitor.post(`${base}/move`, { index: 1 })).status, 200);
    assert.equal((await visitor.post(`${base}/delete`)).status, 200);
  });

  it('удаление убирает источник и смыкает слои; повторное удаление — «не найдено»', async () => {
    const { visitor, id, api } = await newStage(ctx);
    const ids = [];
    for (const type of ['text', 'shape', 'timer', 'widget']) ids.push((await addSource(visitor, id, type)).id);

    const removed = await visitor.post(`${api}/sources/${ids[1]}/delete`);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.data, { ok: true, removed: ids[1], order: [ids[0], ids[2], ids[3]], version: 5 });

    refusal(await visitor.post(`${api}/sources/${ids[1]}/delete`), 404, 'source_not_found');
    refusal(await patchSource(visitor, id, ids[1], { x: 1 }), 404, 'source_not_found');
    refusal(await visitor.post(`${api}/sources/${ids[1]}/duplicate`), 404, 'source_not_found');
    refusal(await visitor.post(`${api}/sources/${ids[1]}/move`, { index: 0 }), 404, 'source_not_found');
    refusal(await visitor.post(`${api}/sources/${ids[1]}/command`, { action: 'start' }), 404, 'source_not_found');

    const scene = await sceneOf(visitor, id);
    assert.deepEqual(scene.sources.map((source) => source.id), [ids[0], ids[2], ids[3]]);
    assert.equal(scene.scene.version, 5, 'отказы версию не меняют');
    const layers = ctx.db.prepare(`
      SELECT s.layer FROM sources s JOIN workspaces w ON w.id = s.workspace_id WHERE w.public_id = ? ORDER BY s.layer
    `).all(id).map((row) => row.layer);
    assert.deepEqual(layers, [0, 1, 2]);
  });

  it('копия ложится сразу над оригиналом, чуть в стороне, с теми же настройками и без защиты от сдвига', async () => {
    const { visitor, id, api } = await newStage(ctx);
    const bottom = await addSource(visitor, id, 'shape', { x: 50, y: 60, width: 333, height: 222, opacity: 70, visible: false, locked: true, settings: { fill: 'none' } });
    const top = await addSource(visitor, id, 'text');

    const res = await visitor.post(`${api}/sources/${bottom.id}/duplicate`);
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.data).sort(), ['ok', 'order', 'source', 'version']);
    const copy = res.data.source;
    assert.notEqual(copy.id, bottom.id);
    assert.deepEqual(copy, { ...bottom, id: copy.id, name: 'Фигура — копия', x: 74, y: 84, locked: false });
    assert.deepEqual(res.data.order, [bottom.id, copy.id, top.id]);

    // Вторая копия того же источника не встаёт точно на первую и называется по-своему
    const second = (await visitor.post(`${api}/sources/${bottom.id}/duplicate`)).data;
    assert.deepEqual([second.source.name, second.source.x, second.source.y], ['Фигура — копия 2', 98, 108]);
    assert.deepEqual(second.order, [bottom.id, second.source.id, copy.id, top.id]);

    // Длинное название копии укладывается в те же 40 знаков
    const long = await addSource(visitor, id, 'text', { name: 'я'.repeat(40) });
    const longCopy = (await visitor.post(`${api}/sources/${long.id}/duplicate`)).data.source;
    assert.equal(longCopy.name, `${'я'.repeat(28)} — копия`);
    assert.ok([...longCopy.name].length <= 40);

    // У края допустимого копия не «улетает» дальше предела
    const edge = await addSource(visitor, id, 'text', { x: 8192, y: 8180 });
    const edgeCopy = (await visitor.post(`${api}/sources/${edge.id}/duplicate`)).data.source;
    assert.deepEqual([edgeCopy.x, edgeCopy.y], [8192, 8192]);
  });

  it('порядок слоёв: источник переставляется на указанное место, остальные сдвигаются', async () => {
    const { visitor, id, api } = await newStage(ctx);
    const [a, b, c, d] = [
      (await addSource(visitor, id, 'text')).id, (await addSource(visitor, id, 'shape')).id,
      (await addSource(visitor, id, 'timer')).id, (await addSource(visitor, id, 'widget')).id,
    ];
    const move = (sourceId, index) => visitor.post(`${api}/sources/${sourceId}/move`, { index });

    const up = await move(a, 2);
    assert.deepEqual(up.data, { ok: true, order: [b, c, a, d], version: 5 });
    assert.deepEqual((await move(d, 0)).data.order, [d, b, c, a]);
    // Место за краем списка — это просто самый верх или самый низ
    assert.deepEqual((await move(d, 99)).data.order, [b, c, a, d]);
    assert.deepEqual((await move(d, -5)).data.order, [d, b, c, a]);
    assert.deepEqual((await move(b, 1.4)).data.order, [d, b, c, a]);

    // Источник уже на этом месте — менять нечего, версия прежняя
    const still = await move(d, 0);
    assert.deepEqual(still.data, { ok: true, order: [d, b, c, a], version: 8 });

    for (const index of ['1', null, undefined, [1], {}, true]) {
      refusal(await visitor.post(`${api}/sources/${a}/move`, index === undefined ? {} : { index }), 400, 'source_field_invalid', { field: 'index' });
    }
    const scene = await sceneOf(visitor, id);
    assert.deepEqual(scene.sources.map((source) => source.id), [d, b, c, a]);
    assert.equal(scene.scene.version, 8);
  });

  it('источник чужой площадки не отличается от несуществующего и остаётся нетронутым', async () => {
    const mine = await newStage(ctx);
    const theirs = await newStage(ctx, { displayName: 'Другой стример' });
    const foreign = await addSource(theirs.visitor, theirs.id, 'timer');
    const snapshot = sceneState(ctx);

    const missing = newLinkToken(12);
    const attempts = (sourceId) => [
      ['PATCH', `${mine.api}/sources/${sourceId}`, { x: 1 }],
      ['POST', `${mine.api}/sources/${sourceId}/delete`, {}],
      ['POST', `${mine.api}/sources/${sourceId}/duplicate`, {}],
      ['POST', `${mine.api}/sources/${sourceId}/move`, { index: 0 }],
      ['POST', `${mine.api}/sources/${sourceId}/command`, { action: 'start' }],
    ];
    const real = attempts(foreign.id);
    const ghost = attempts(missing);
    for (let i = 0; i < real.length; i += 1) {
      const res = await call(mine.visitor, ...real[i]);
      refusal(res, 404, 'source_not_found');
      assert.equal((await call(mine.visitor, ...ghost[i])).text, res.text, 'ответ тот же, что для номера, которого нет');
    }
    // Номер, не похожий на номер, — тоже просто «не найдено»
    for (const junk of ['1', 'abc', `${foreign.id}x`, foreign.id.toUpperCase(), '%00', "' OR 1=1 --", '../', '../../workspaces']) {
      refusal(await mine.visitor.patch(`${mine.api}/sources/${encodeURIComponent(junk)}`, { x: 1 }), 404, 'source_not_found');
    }
    assert.equal(sceneState(ctx), snapshot);
  });

  it('команды редактора — только JSON и не длиннее 256 КБ', async () => {
    const { visitor, id, api } = await newStage(ctx);
    const source = await addSource(visitor, id, 'widget');

    const broken = await visitor.patch(`${api}/sources/${source.id}`, '{"x": 1', { headers: { 'Content-Type': 'application/json' } });
    refusal(broken, 400, 'invalid_json');
    const form = await visitor.post(`${api}/sources`, 'type=text', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    refusal(form, 415, 'json_required');
    const plain = await visitor.post(`${api}/sources`, '{"type":"text"}', { headers: { 'Content-Type': 'text/plain' } });
    refusal(plain, 415, 'json_required');

    // Самая длинная команда — свой блок на 20 000 знаков — проходит с большим запасом
    const longest = { settings: { kind: 'html', html: '🎬'.repeat(20_000) } };
    assert.ok(Buffer.byteLength(JSON.stringify(longest)) < 256 * KB);
    assert.equal((await patchSource(visitor, id, source.id, longest)).status, 200);
    refusal(await patchSource(visitor, id, source.id, { name: 'я'.repeat(150 * KB) }), 413, 'payload_too_large');

    const scene = await sceneOf(visitor, id);
    assert.equal(scene.sources.length, 1);
    assert.equal(scene.scene.version, 2);
  });

  it('номера строк базы не попадают ни в один ответ о сцене', async () => {
    const { visitor, id, api } = await newStage(ctx);
    const image = await addSource(visitor, id, 'image');
    const file = await uploadFile(visitor, id, png(), 'картинка.png');
    const answers = [
      (await patchSource(visitor, id, image.id, { file: file.id })).data,
      (await visitor.post(`${api}/sources/${image.id}/duplicate`)).data,
      await sceneOf(visitor, id),
    ];
    let seen = 0;
    (function walk(value, trail) {
      if (Array.isArray(value)) return value.forEach((item, i) => walk(item, `${trail}[${i}]`));
      if (value && typeof value === 'object') return Object.entries(value).forEach(([key, item]) => walk(item, `${trail}.${key}`));
      if (/(^|\.)(id|file|removed)$|\.order\[\d+\]$/i.test(trail) && value !== null) {
        assert.match(String(value), PUBLIC_ID, `${trail}: наружу ушёл не случайный номер`);
        seen += 1;
      }
      return undefined;
    })(answers, 'ответ');
    assert.ok(seen >= 10, `проверено номеров: ${seen}`);
    for (const key of ['media_id', 'workspace_id', 'layer', 'uploaded_by']) {
      assert.doesNotMatch(JSON.stringify(answers), new RegExp(`"${key}"`), `в ответе есть внутреннее поле ${key}`);
    }
  });
});

/* ========================================================================== */

describe('Этап 5 — пределы сцены и частота команд', () => {
  it('на сцене не больше заданного числа источников: ни новый, ни копия сверх предела не появляются', async () => {
    const ctx = await startServer({ sceneLimits: { sourcesPerScene: 3 } });
    try {
      const { visitor, id, api } = await newStage(ctx);
      assert.equal((await sceneOf(visitor, id)).limits.sources, 3, 'страница узнаёт предел от сервера');
      const ids = [];
      for (const type of ['text', 'shape', 'timer']) ids.push((await addSource(visitor, id, type)).id);

      refusal(await visitor.post(`${api}/sources`, { type: 'widget' }), 409, 'sources_limit', { limit: 3 });
      refusal(await visitor.post(`${api}/sources/${ids[0]}/duplicate`), 409, 'sources_limit', { limit: 3 });
      let scene = await sceneOf(visitor, id);
      assert.equal(scene.sources.length, 3);
      assert.equal(scene.scene.version, 3);

      // Предел — у каждой сцены свой
      const other = await createWorkspace(visitor);
      assert.equal((await visitor.post(`/api/workspaces/${other.id}/scene/sources`, { type: 'text' })).status, 201);

      // Освободили место — можно добавлять снова
      assert.equal((await visitor.post(`${api}/sources/${ids[2]}/delete`)).status, 200);
      assert.equal((await visitor.post(`${api}/sources/${ids[0]}/duplicate`)).status, 201);
      scene = await sceneOf(visitor, id);
      assert.equal(scene.sources.length, 3);
    } finally {
      await ctx.stop();
    }
  });

  it('слишком частые команды сервер отклоняет и говорит, сколько ждать; чтение сцены в счёт не идёт', async () => {
    let clock = Date.now();
    const ctx = await startServer({ now: () => clock, sceneLimits: { commandsPerUser: { limit: 6, windowMs: MINUTE } } });
    try {
      const { visitor, id, api } = await newStage(ctx);
      const moderator = await addModerator(ctx.baseUrl, visitor, id);
      const source = await addSource(visitor, id, 'text'); // 1-я команда

      // В счёт идёт каждая команда: удачная, пустая и отклонённая
      assert.equal((await patchSource(visitor, id, source.id, { x: 1 })).status, 200); // 2
      assert.equal((await patchSource(visitor, id, source.id, { x: 1 })).status, 200); // 3 — ничего не изменила
      assert.equal((await patchSource(visitor, id, source.id, { width: 1 })).status, 400); // 4
      assert.equal((await visitor.post(`${api}/sources/${newLinkToken(12)}/delete`)).status, 404); // 5
      assert.equal((await visitor.post(`${api}/sources/${source.id}/move`, { index: 0 })).status, 200); // 6

      const blocked = [
        await patchSource(visitor, id, source.id, { x: 500 }),
        await visitor.post(`${api}/sources`, { type: 'text' }),
        await visitor.post(`${api}/sources/${source.id}/duplicate`),
        await visitor.post(`${api}/sources/${source.id}/command`, { action: 'start' }),
        await visitor.post(`${api}/sources/${source.id}/delete`),
        await visitor.post(`${api}/media/${newLinkToken(12)}/delete`),
      ];
      for (const res of blocked) {
        refusal(res, 429, 'too_many_requests', { retryAfterSeconds: 60 });
        assert.equal(res.headers.get('retry-after'), '60');
      }
      // Чтение сцены не ограничено: страница перечитывает её после каждого сигнала
      for (let i = 0; i < 10; i += 1) assert.equal((await visitor.get(api)).status, 200);
      const scene = await sceneOf(visitor, id);
      assert.deepEqual([scene.sources.length, scene.sources[0].x, scene.scene.version], [1, 1, 2]);

      // Счёт у каждого свой, и у каждой площадки свой
      assert.equal((await patchSource(moderator.visitor, id, source.id, { x: 2 })).status, 200);
      const other = await createWorkspace(visitor);
      assert.equal((await visitor.post(`/api/workspaces/${other.id}/scene/sources`, { type: 'text' })).status, 201);

      clock += 30 * 1000;
      refusal(await patchSource(visitor, id, source.id, { x: 3 }), 429, 'too_many_requests', { retryAfterSeconds: 30 });
      clock += 30 * 1000;
      assert.equal((await patchSource(visitor, id, source.id, { x: 3 })).status, 200, 'минута прошла — команды снова принимаются');
    } finally {
      await ctx.stop();
    }
  });

  it('рабочие пределы достаточно велики, чтобы человек в них не упирался', () => {
    assert.deepEqual(DEFAULT_SCENE_LIMITS.commandsPerUser, { limit: 600, windowMs: MINUTE });
    assert.deepEqual(DEFAULT_SCENE_LIMITS.uploadsPerUser, { limit: 60, windowMs: 10 * MINUTE });
    assert.deepEqual(
      [DEFAULT_SCENE_LIMITS.uploadsAtOncePerUser, DEFAULT_SCENE_LIMITS.uploadsAtOnce, DEFAULT_SCENE_LIMITS.filesPerWorkspace],
      [2, 8, 200]
    );
    assert.deepEqual([DEFAULT_SCENE_LIMITS.imageMaxSide, DEFAULT_SCENE_LIMITS.imageMaxPixels], [8192, 40_000_000]);
  });
});

/* ========================================================================== */

describe('Этап 5 — права: владелец, модератор, посторонний, гость', () => {
  let ctx;
  let owner;
  let moderator;
  let stranger;

  /* Площадка с готовой сценой: два источника для правок, таймер для команд, источник
     «на удаление», картинка на сцене и файл, который никем не занят. */
  async function buildStage(name) {
    const workspace = await createWorkspace(owner.visitor, name);
    const id = workspace.id;
    const text = await addSource(owner.visitor, id, 'text');
    const timer = await addSource(owner.visitor, id, 'timer');
    const victim = await addSource(owner.visitor, id, 'shape');
    const file = await uploadFile(owner.visitor, id, png(16, 9), 'рамка.png');
    const picture = await addSource(owner.visitor, id, 'image', { file: file.id });
    const spare = await uploadFile(owner.visitor, id, gif(), 'лишний.gif');
    const invite = await owner.visitor.post(`/api/workspaces/${id}/invites`, {});
    await moderator.visitor.post(`/api/invites/${invite.data.token}/accept`);
    return { id, text: text.id, timer: timer.id, victim: victim.id, picture: picture.id, file: file.id, spare: spare.id };
  }

  // Все действия со сценой. «Удалить источник» и «удалить файл» идут последними
  const actions = (id, stage) => [
    ['GET', `/api/workspaces/${id}/scene`],
    ['POST', `/api/workspaces/${id}/scene/sources`, { type: 'text' }],
    ['PATCH', `/api/workspaces/${id}/scene/sources/${stage.text}`, { x: 5, name: 'Захвачено' }],
    ['POST', `/api/workspaces/${id}/scene/sources/${stage.text}/duplicate`, {}],
    ['POST', `/api/workspaces/${id}/scene/sources/${stage.text}/move`, { index: 0 }],
    ['POST', `/api/workspaces/${id}/scene/sources/${stage.timer}/command`, { action: 'start' }],
    ['PATCH', `/api/workspaces/${id}/scene/sources/${stage.picture}`, { file: null }],
    ['UPLOAD', `/api/workspaces/${id}/scene/media`, png()],
    ['POST', `/api/workspaces/${id}/scene/sources/${stage.victim}/delete`, {}],
    ['POST', `/api/workspaces/${id}/scene/media/${stage.spare}/delete`, {}],
  ];
  const ANSWERS = [200, 201, 200, 201, 200, 200, 200, 201, 200, 200];

  before(async () => {
    ctx = await startServer();
    owner = await registerUser(ctx.baseUrl, { displayName: 'Владелец' });
    moderator = await registerUser(ctx.baseUrl, { displayName: 'Модератор' });
    stranger = await registerUser(ctx.baseUrl, { displayName: 'Посторонний' });
  });
  after(async () => { await ctx.stop(); });

  it('гость получает отказ на любое действие со сценой, и ничего не меняется', async () => {
    const stage = await buildStage('Сцена для гостя');
    const snapshot = sceneState(ctx);
    const guest = createVisitor(ctx.baseUrl);

    for (const [method, url, body] of actions(stage.id, stage)) {
      const res = await call(guest, method, url, body);
      refusal(res, 401, 'unauthorized');
    }
    // Сам файл гостю не отдаётся — и по ответу не понять, есть ли он
    const file = await guest.get(`/media/${stage.id}/${stage.file}`);
    refusal(file, 404, 'workspace_not_found');
    assert.equal((await guest.get(`/media/${newLinkToken(12)}/${newLinkToken(12)}`)).text, file.text);

    assert.equal(sceneState(ctx), snapshot);
  });

  it('посторонний получает «площадка не найдена» — точно так же, как для площадки, которой нет', async () => {
    const stage = await buildStage('Сцена для постороннего');
    const snapshot = sceneState(ctx);
    const missingId = newLinkToken(12);
    const real = actions(stage.id, stage);
    const ghost = actions(missingId, stage);

    for (let i = 0; i < real.length; i += 1) {
      const res = await call(stranger.visitor, ...real[i]);
      refusal(res, 404, 'workspace_not_found');
      // По ответу нельзя понять, существует ли площадка
      const same = await call(stranger.visitor, ...ghost[i]);
      assert.equal(same.status, res.status);
      assert.equal(same.text, res.text);
    }

    const file = await stranger.visitor.get(`/media/${stage.id}/${stage.file}`);
    refusal(file, 404, 'workspace_not_found');
    for (const url of [`/media/${stage.id}/${newLinkToken(12)}`, `/media/${missingId}/${stage.file}`]) {
      assert.equal((await stranger.visitor.get(url)).text, file.text, 'существующий файл неотличим от несуществующего');
    }
    // Файл постороннего сервер не сохранил даже временно
    assert.equal(sceneState(ctx), snapshot, 'чужие попытки ничего не изменили');
  });

  it('посторонний не может выдать себя за участника: кто просит, сервер берёт только из сеанса входа', async () => {
    const stage = await buildStage('Сцена для самозванца');
    const snapshot = sceneState(ctx);
    const ownerRow = ctx.db.prepare('SELECT id FROM users WHERE username_key = ?').get(owner.username.toLowerCase()).id;
    const pretend = { userId: ownerRow, user_id: ownerRow, ownerId: ownerRow, role: 'owner', workspaceId: stage.id, auth: { userId: ownerRow } };

    for (const [method, url, body] of actions(stage.id, stage)) {
      if (method === 'GET' || method === 'UPLOAD') continue;
      const res = await call(stranger.visitor, method, `${url}?userId=${ownerRow}&role=owner`, { ...body, ...pretend });
      refusal(res, 404, 'workspace_not_found');
    }
    const asHeaders = { 'X-User-Id': String(ownerRow), 'X-Role': 'owner', 'X-Client-Id': 'tab000000001' };
    refusal(await stranger.visitor.get(`/api/workspaces/${stage.id}/scene`, { headers: asHeaders }), 404, 'workspace_not_found');
    refusal(
      await stranger.visitor.upload(`/api/workspaces/${stage.id}/scene/media`, png(), { headers: asHeaders }),
      404, 'workspace_not_found'
    );
    assert.equal(sceneState(ctx), snapshot);

    // А участник, приписав себе чужой номер, действует всё равно от своего имени
    const uploaded = await moderator.visitor.post(`/api/workspaces/${stage.id}/scene/sources`, { type: 'text', ...pretend });
    assert.equal(uploaded.status, 201);
    const file = await moderator.visitor.upload(`/api/workspaces/${stage.id}/scene/media`, png(), { headers: asHeaders });
    assert.equal(file.data.file.uploadedBy, 'Модератор');
  });

  it('модератор работает со сценой наравне с владельцем: каждое действие даёт тот же результат', async () => {
    const forOwner = await buildStage('Сцена: действует владелец');
    const forModerator = await buildStage('Сцена: действует модератор');
    const asOwner = actions(forOwner.id, forOwner);
    const asModerator = actions(forModerator.id, forModerator);
    assert.equal(asOwner.length, ANSWERS.length);

    // Ответы сравниваются по форме: случайные номера и время у двух площадок свои
    const shape = (value) => {
      if (Array.isArray(value)) return value.map(shape);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)]));
      return typeof value;
    };
    for (let i = 0; i < asOwner.length; i += 1) {
      const mine = await call(owner.visitor, ...asOwner[i]);
      const theirs = await call(moderator.visitor, ...asModerator[i]);
      const what = `${asOwner[i][0]} ${asOwner[i][1].replace(forOwner.id, '…')}`;
      assert.equal(mine.status, ANSWERS[i], `${what} от владельца: ${mine.text}`);
      assert.equal(theirs.status, ANSWERS[i], `${what} от модератора: ${theirs.text}`);
      assert.deepEqual(shape(theirs.data), shape(mine.data), what);
      if (mine.data.version !== undefined) assert.equal(theirs.data.version, mine.data.version, what);
    }

    const ownerScene = await sceneOf(owner.visitor, forOwner.id);
    const moderatorScene = await sceneOf(moderator.visitor, forModerator.id);
    assert.equal(ownerScene.workspace.role, 'owner');
    assert.equal(moderatorScene.workspace.role, 'moderator');
    // Итог на двух сценах одинаковый — с точностью до номеров и времени
    const plain = (scene) => scene.sources.map(({ id, file, state, ...rest }) => ({ ...rest, hasFile: Boolean(file), running: state?.running }));
    assert.deepEqual(plain(moderatorScene), plain(ownerScene));
    assert.equal(moderatorScene.sources.length, 5);
    assert.deepEqual(moderatorScene.usage, ownerScene.usage);
    assert.deepEqual(moderatorScene.media.map((item) => item.uploadedBy), ['Модератор', 'Владелец']);

    // Сами файлы модератору тоже отдаются
    assert.equal((await moderator.visitor.get(`/media/${forModerator.id}/${forModerator.file}`)).status, 200);
    // А вот площадкой он по-прежнему не управляет: права этапа 4 не расширились
    refusal(await moderator.visitor.patch(`/api/workspaces/${forModerator.id}`, { name: 'Моя' }), 403, 'owner_only');
  });

  it('модератор, которого убрали из команды, теряет сцену и файлы сразу', async () => {
    const stage = await buildStage('Сцена бывшего модератора');
    assert.equal((await moderator.visitor.get(`/api/workspaces/${stage.id}/scene`)).status, 200);
    const removed = await owner.visitor.post(`/api/workspaces/${stage.id}/members/remove`, { username: moderator.username });
    assert.equal(removed.status, 200);

    const snapshot = sceneState(ctx);
    for (const [method, url, body] of actions(stage.id, stage)) {
      refusal(await call(moderator.visitor, method, url, body), 404, 'workspace_not_found');
    }
    refusal(await moderator.visitor.get(`/media/${stage.id}/${stage.file}`), 404, 'workspace_not_found');
    assert.equal(sceneState(ctx), snapshot);

    // Другие площадки, где он остался в команде, работают как прежде
    const other = await buildStage('Сцена, где он остался');
    assert.equal((await moderator.visitor.get(`/api/workspaces/${other.id}/scene`)).status, 200);
    // Сам вышел из команды — то же самое
    assert.equal((await moderator.visitor.post(`/api/workspaces/${other.id}/leave`)).status, 200);
    refusal(await moderator.visitor.get(`/api/workspaces/${other.id}/scene`), 404, 'workspace_not_found');
    refusal(await moderator.visitor.get(`/media/${other.id}/${other.file}`), 404, 'workspace_not_found');
  });

  it('после выхода из аккаунта сцена и файлы недоступны, даже если страница осталась открытой', async () => {
    const stage = await buildStage('Сцена после выхода');
    const second = createVisitor(ctx.baseUrl);
    assert.equal((await second.post('/api/auth/login', { username: owner.username, password: owner.password })).status, 200);
    assert.equal((await second.get(`/media/${stage.id}/${stage.file}`)).status, 200);
    const staleCookie = new Map(second.jar);

    assert.equal((await second.post('/api/auth/logout')).status, 200);
    // Страница, которая «помнит» прежний ключ входа
    for (const [name, value] of staleCookie) second.jar.set(name, value);
    const snapshot = sceneState(ctx);
    for (const [method, url, body] of actions(stage.id, stage)) {
      refusal(await call(second, method, url, body), 401, 'unauthorized');
      for (const [name, value] of staleCookie) second.jar.set(name, value);
    }
    refusal(await second.get(`/media/${stage.id}/${stage.file}`), 404, 'workspace_not_found');
    assert.equal(sceneState(ctx), snapshot);
    // Другой вход того же человека продолжает работать
    assert.equal((await owner.visitor.get(`/api/workspaces/${stage.id}/scene`)).status, 200);
  });

  it('чужой сайт не может менять сцену от имени вошедшего человека', async () => {
    const stage = await buildStage('Сцена и чужой сайт');
    const snapshot = sceneState(ctx);
    const changing = actions(stage.id, stage).filter(([method]) => method !== 'GET');
    assert.equal(changing.length, 9);

    for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'https://evil.example' }]) {
      for (const [method, url, body] of changing) {
        const res = method === 'UPLOAD'
          ? await owner.visitor.upload(url, body, { headers })
          : method === 'PATCH' ? await owner.visitor.patch(url, body, { headers }) : await owner.visitor.post(url, body, { headers });
        refusal(res, 403, 'cross_site_request');
      }
    }
    // Файл с чужого сайта — в том виде, в каком его шлёт обычная форма, — не принимается и «своим» запросом
    const form = await owner.visitor.post(`/api/workspaces/${stage.id}/scene/media`, undefined, {
      raw: png(), headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
    });
    refusal(form, 415, 'file_required');
    assert.equal(sceneState(ctx), snapshot);

    // Ответы о сцене и сами файлы чужому сайту не разрешено читать
    const scene = await owner.visitor.get(`/api/workspaces/${stage.id}/scene`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(scene.headers.get('access-control-allow-origin'), null);
    const file = await owner.visitor.get(`/media/${stage.id}/${stage.file}`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(file.headers.get('access-control-allow-origin'), null);
    assert.equal(file.headers.get('cross-origin-resource-policy'), 'same-origin');
  });

  it('проверка прав не размазана по адресам: каждое действие со сценой первым делом входит в площадку', () => {
    const read = (file) => fs.readFileSync(path.join(PROJECT_DIR, 'src/server/scene', file), 'utf8');
    const routes = read('http.js');
    const rules = read('scene.js');

    // Адреса только передают, кто просит и что просит
    const found = [...routes.matchAll(/(sceneRouter|mediaRouter)\.(get|post|patch|put|delete)\(\s*'([^']+)'([\s\S]*?)\n  \}?\);/g)];
    assert.equal(found.length, 10, `найдено адресов: ${found.length}`);
    for (const [, router, method, route, body] of found) {
      assert.match(body, /from\(req\)/, `${router} ${method.toUpperCase()} ${route}: не передано, кто просит`);
    }
    assert.match(
      routes,
      /const from = \(req\) => \(\{ userId: req\.auth\?\.userId, workspaceId: req\.params\.id, origin: req\.get\('x-client-id'\) \}\);/
    );
    assert.doesNotMatch(routes, /fields\(req\)\.(userId|ownerId|role|workspaceId)|req\.(body|query)\.(userId|role)/);
    assert.doesNotMatch(routes, /\brole\b|owner|moderator|requireMember|roleOf/, 'в адресах сцены не должно быть своих проверок прав');
    // Вход обязателен для всего раздела разом; у загрузки файла — отдельно, до чтения файла
    assert.match(routes, /sceneRouter\.use\(auth\.sessionWithBody\(COMMAND_BODY_LIMIT\), auth\.requireAuth\);/);
    assert.match(routes, /'\/media',\s*auth\.identify,[\s\S]*?auth\.requireAuth,[\s\S]*?scene\.upload\(/);
    // Служебные действия (уборка, остановка) с адресов не вызываются
    assert.doesNotMatch(routes, /forgetWorkspace|cleanup|settle/);

    // Каждое действие от имени человека начинается со входа в площадку
    const exported = rules.slice(rules.lastIndexOf('\n  return {')).match(/\b[a-zA-Z]+\b(?=,|\n)/g).filter((name) => name !== 'return');
    assert.deepEqual(exported, [
      'get', 'createSource', 'updateSource', 'removeSource', 'duplicateSource', 'moveSource', 'commandSource',
      'upload', 'removeMedia', 'openMedia', 'overlayScene', 'openOverlayMedia', 'forgetWorkspace', 'cleanup', 'settle', 'uploadIdleMs',
    ]);
    for (const name of exported.slice(0, 10)) {
      const opening = new RegExp(
        `\\n  (?:async )?function ${name}\\(\\{ userId, workspaceId[^)]*\\} = \\{\\}\\) \\{\\n(?:    //[^\\n]*\\n)*    const ws = enter\\(\\{ userId, workspaceId \\}\\);`
      );
      assert.match(rules, opening, `${name}: действие не начинается со входа в площадку`);
    }
    // Вход один — тот же, что у страницы площадки; своих правил «кто есть кто» у сцены нет
    assert.match(rules, /function enter\(\{ userId, workspaceId \} = \{\}\) \{\n    return workspaces\.enter\(\{ userId, workspaceId \}\);\n  \}/);
    assert.doesNotMatch(rules, /workspace_members|owner_id|role\s*[!=]==|'owner'|'moderator'/);
    // Загрузка длится долго: перед сохранением права проверяются ещё раз
    assert.match(rules, /const again = enter\(\{ userId, workspaceId \}\);/);

    /* С этапа 6 у сцены есть второй вход — для оверлея: не человек, а ссылка оверлея.
       Правило то же: оба действия оверлея первой строкой входят в площадку, а действует ли
       ссылка, решают площадки. Что именно видно по ссылке, проверяется в overlay.test.js. */
    for (const name of ['overlayScene', 'openOverlayMedia']) {
      const opening = new RegExp(`\\n  function ${name}\\(\\{ token[^)]*\\} = \\{\\}\\) \\{\\n    const ws = enterOverlay\\(\\{ token \\}\\);`);
      assert.match(rules, opening, `${name}: действие оверлея не начинается со входа по ссылке`);
    }
    assert.match(rules, /function enterOverlay\(\{ token \} = \{\}\) \{\n    return workspaces\.enterOverlay\(\{ token \}\);\n  \}/);
    // По ссылке оверлея сцену только читают: кроме этих двух действий, по ней не входит ни одно
    // (три упоминания — сам вход и два действия)
    assert.equal(rules.match(/enterOverlay\(\{ token \}\)/g).length, 3);
  });
});

/* ========================================================================== */

describe('Этап 5 — файлы: что принимается и как хранится', () => {
  let ctx;
  before(async () => { ctx = await startServer(); });
  after(async () => { await ctx.stop(); });

  const incoming = () => filesOnDisk(path.join(uploadsDir(ctx), '.incoming'));

  it('принимаются PNG, JPEG, WebP, GIF, MP4 и WebM; сервер сам определяет вид и размеры', async () => {
    const { visitor, id, api } = await newStage(ctx, { displayName: 'Стример' });
    const samples = [
      ['рамка.png', png(4, 3), { kind: 'image', mime: 'image/png', width: 4, height: 3 }],
      ['фото.jpg', jpeg(6, 5), { kind: 'image', mime: 'image/jpeg', width: 6, height: 5 }],
      ['фон.webp', webp(10, 9, 'VP8X'), { kind: 'image', mime: 'image/webp', width: 10, height: 9 }],
      ['фон-без-потерь.webp', webp(10, 9, 'VP8L'), { kind: 'image', mime: 'image/webp', width: 10, height: 9 }],
      ['фон-сжатый.webp', webp(10, 9, 'VP8 '), { kind: 'image', mime: 'image/webp', width: 10, height: 9 }],
      ['стикер.gif', gif(8, 7), { kind: 'gif', mime: 'image/gif', width: 8, height: 7 }],
      ['заставка.mp4', mp4(), { kind: 'video', mime: 'video/mp4', width: null, height: null }],
      ['переход.webm', ebml('webm'), { kind: 'video', mime: 'video/webm', width: null, height: null }],
    ];

    let total = 0;
    const stored = [];
    for (const [index, [name, bytes, expected]] of samples.entries()) {
      const res = await visitor.upload(`${api}/media`, bytes, { name });
      assert.equal(res.status, 201, `${name}: ${res.text}`);
      total += bytes.length;
      const { file } = res.data;
      assert.match(file.id, PUBLIC_ID);
      assert.match(file.createdAt, ISO_DATE);
      assert.deepEqual(file, {
        id: file.id, ...expected, size: bytes.length, name, uploadedBy: 'Стример', createdAt: file.createdAt, usedBy: 0,
      });
      assert.deepEqual(res.data, { ok: true, file, usage: { files: index + 1, storageBytes: total }, version: index + 1 });

      // На диске файл лежит под случайным номером, без имени и расширения, байт в байт
      const onDisk = path.join(uploadsDir(ctx), id, file.id);
      assert.deepEqual(fs.readFileSync(onDisk), bytes);
      stored.push(file);
    }
    assert.deepEqual(incoming(), [], 'временных файлов не осталось');
    assert.deepEqual(fs.readdirSync(path.join(uploadsDir(ctx), id)).sort(), stored.map((file) => file.id).sort());

    const scene = await sceneOf(visitor, id);
    assert.deepEqual(scene.media, [...stored].reverse(), 'в списке сначала новые');
    assert.deepEqual(scene.usage, { files: 8, storageBytes: total });
    assert.equal(scene.scene.version, 8);
  });

  it('фотография с телефона или фотоаппарата принимается: размеры JPEG ищутся среди служебных блоков', async () => {
    const { visitor, id, api } = await newStage(ctx);
    const photo = cameraJpeg(4032, 3024);
    assert.ok(photo.length > 60_000, 'размеры лежат далеко за началом файла');
    const samples = [
      ['IMG_0001.JPG', photo, [4032, 3024]],
      ['progressive.jpeg', cameraJpeg(1920, 1080, { progressive: true }), [1920, 1080]],
      ['tiny.jpg', jpeg(1, 1), [1, 1]],
      ['no-exif.jpg', cameraJpeg(640, 480, { exifBytes: 10 }), [640, 480]],
    ];
    for (const [name, bytes, [width, height]] of samples) {
      const res = await visitor.upload(`${api}/media`, bytes, { name });
      assert.equal(res.status, 201, `${name}: ${res.text}`);
      assert.deepEqual(
        [res.data.file.kind, res.data.file.mime, res.data.file.width, res.data.file.height, res.data.file.size],
        ['image', 'image/jpeg', width, height, bytes.length],
        name
      );
      // Файл сохранён целиком, байт в байт, и отдаётся как JPEG
      assert.deepEqual(fs.readFileSync(path.join(uploadsDir(ctx), id, res.data.file.id)), bytes);
      const served = await visitor.get(`/media/${id}/${res.data.file.id}`);
      assert.equal(served.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(served.bytes, bytes);
    }
    // То же, когда файл приходит по кусочкам
    const slow = slowUpload(ctx, visitor, id);
    for (let offset = 0; offset < 50_000; offset += 10_000) await slow.write(photo.subarray(offset, offset + 10_000));
    const accepted = await slow.finish(photo.subarray(50_000));
    assert.equal(accepted.status, 201, accepted.text);
    assert.deepEqual([accepted.data.file.width, accepted.data.file.height], [4032, 3024]);
    assert.deepEqual(fs.readFileSync(path.join(uploadsDir(ctx), id, accepted.data.file.id)), photo);

    // Слишком большая или оборванная фотография — отказ, и ничего не сохранено
    refusal(await visitor.upload(`${api}/media`, cameraJpeg(9000, 6000)), 400, 'image_too_big', { limit: 8192, megapixels: 40 });
    refusal(await visitor.upload(`${api}/media`, cameraJpeg(8000, 6000)), 400, 'image_too_big', { limit: 8192, megapixels: 40 });
    refusal(await visitor.upload(`${api}/media`, photo.subarray(0, 30_000)), 400, 'image_unreadable');
    refusal(await visitor.upload(`${api}/media`, cameraJpeg(0, 3024)), 400, 'image_unreadable');
    assert.equal((await sceneOf(visitor, id)).usage.files, 5);
    assert.equal(filesOnDisk(path.join(uploadsDir(ctx), id)).length, 5);
    assert.deepEqual(incoming(), []);
  });

  it('поиск размеров JPEG: находит их в любом настоящем файле и не зависает на испорченном', async () => {
    const reads = [];
    const sizeOf = (bytes) => {
      reads.length = 0;
      return readJpegSize(async (offset, length) => {
        reads.push(length);
        return bytes.subarray(offset, offset + length);
      });
    };
    assert.deepEqual(await sizeOf(jpeg(6, 5)), { width: 6, height: 5 });
    assert.deepEqual(await sizeOf(cameraJpeg(4032, 3024)), { width: 4032, height: 3024 });
    // Файл не читается целиком: только заголовки блоков — несколько байт на каждый
    assert.ok(reads.length <= 12 && Math.max(...reads) <= 5, `чтений: ${reads.length}`);
    assert.deepEqual(await sizeOf(cameraJpeg(1280, 720, { progressive: true })), { width: 1280, height: 720 });
    assert.deepEqual(await sizeOf(cameraJpeg(65535, 65535)), { width: 65535, height: 65535 });

    // Все виды блока размеров — и ни одного «похожего» блока, который размеров не содержит
    for (let marker = 0xc0; marker <= 0xcf; marker += 1) {
      const bytes = Buffer.from([0xff, 0xd8, 0xff, marker, 0x00, 0x08, 0x08, 0x00, 0x09, 0x00, 0x0a, 0x03, 0xff, 0xd9]);
      const expected = [0xc4, 0xc8, 0xcc].includes(marker) ? null : { width: 10, height: 9 };
      assert.deepEqual(await sizeOf(bytes), expected, `блок 0x${marker.toString(16)}`);
    }

    // Испорченное: ответ «не знаю», без ошибок и без бесконечного поиска
    assert.equal(await sizeOf(jpeg(6, 5, { frame: false })), null, 'размеров нет вовсе');
    assert.equal(await sizeOf(Buffer.from([0xff, 0xd8])), null);
    assert.equal(await sizeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x00, 0x00])), null, 'блок с невозможной длиной');
    assert.equal(await sizeOf(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00])), null, 'после начала — не блок');
    assert.equal(await sizeOf(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00])), null, 'блок размеров оборван');
    assert.equal(await sizeOf(cameraJpeg(100, 100).subarray(0, 40_000)), null, 'файл оборван на служебном блоке');
    assert.equal(await sizeOf(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(100_000, 0xff)])), null, 'сплошной заполнитель');
    assert.ok(reads.length <= 1000, `поиск ограничен: ${reads.length} чтений`);
    // Блоки нулевой полезной длины без конца
    const endless = Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array.from({ length: 5000 }, () => Buffer.from([0xff, 0xe0, 0x00, 0x02]))]);
    assert.equal(await sizeOf(endless), null);
    assert.ok(reads.length <= 1000);
    // Чтение не удалось или вернуло не то
    for (const broken of [async () => null, async () => undefined, async () => Buffer.alloc(0), async () => Buffer.alloc(3)]) {
      assert.equal(await readJpegSize(broken), null);
    }
    await assert.rejects(readJpegSize(async () => { throw new Error('диск недоступен'); }), /диск недоступен/);
  });

  it('вид файла решает содержимое, а не название: SVG, страницы, программы и чужие форматы не принимаются', async () => {
    const { visitor, id, api } = await newStage(ctx);
    const riff = (kind) => Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00', 'latin1'), Buffer.from(kind, 'latin1'), Buffer.alloc(64)]);
    const refused = [
      ['логотип.svg', SVG],
      ['логотип.png', SVG], // переименованный SVG
      ['логотип.gif', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ['страница.png', Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>')],
      ['скрипт.jpg', Buffer.from('alert(document.cookie)//'.padEnd(200, ' '))],
      ['заметки.txt', Buffer.from('Просто текст. '.repeat(20))],
      ['документ.pdf', Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n'.padEnd(200, ' '), 'latin1')],
      ['архив.zip', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)])],
      ['программа.exe', Buffer.concat([Buffer.from('MZ\x90\x00', 'latin1'), Buffer.alloc(100)])],
      ['картинка.bmp', Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(100)])],
      ['значок.ico', Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(100)])],
      ['песня.mp3', Buffer.concat([Buffer.from('ID3\x03\x00', 'latin1'), Buffer.alloc(100)])],
      ['звук.wav', riff('WAVE')],
      ['ролик.avi', riff('AVI ')],
      ['неведомый.webp', riff('WEBP')], // назвался WebP, но внутри не то
      // Контейнер RIFF другого вида, в который вложен блок, похожий на начало WebP
      ['почти.webp', Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00AVI VP8X\x0a\x00\x00\x00', 'latin1'), Buffer.alloc(64)])],
      ['ролик.mov', mp4({ major: 'qt  ', brands: ['qt  '] })],
      ['фото.heic', mp4({ major: 'heic', brands: ['mif1', 'heic'] })],
      ['фото.avif', mp4({ major: 'avif', brands: ['avif', 'mif1', 'miaf'] })],
      ['звук.m4a', mp4({ major: 'M4A ', brands: ['M4A ', 'mp42', 'isom'] })],
      ['ролик.3gp', mp4({ major: '3gp4', brands: ['3gp4'] })],
      ['ролик.mkv', ebml('matroska')],
      ['ролик.webm', ebml('webx')], // тот же контейнер, но назвал себя не webm
      ['ролик2.webm', ebml('WEBM')],
      ['обрывок.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      ['подделка.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<script>alert(1)</script>'.padEnd(100, ' '))])],
      ['обрывок.gif', Buffer.from('GIF89a')],
      ['один-байт.png', Buffer.from([0x89])],
    ];
    for (const [name, bytes] of refused) {
      refusal(await visitor.upload(`${api}/media`, bytes, { name }), 415, 'file_type_not_allowed');
    }
    refusal(await visitor.upload(`${api}/media`, Buffer.alloc(0), { name: 'пустой.png' }), 400, 'file_empty');

    let scene = await sceneOf(visitor, id);
    assert.deepEqual([scene.media.length, scene.usage.files, scene.scene.version], [0, 0, 0]);
    assert.deepEqual(filesOnDisk(path.join(uploadsDir(ctx), id)), [], 'от отказанных файлов на диске ничего не осталось');
    assert.deepEqual(incoming(), []);

    // И наоборот: настоящая картинка принимается с любым названием — оно лишь подпись
    for (const name of ['кот.svg', 'кот.exe', 'кот.html', 'кот']) {
      const file = await uploadFile(visitor, id, png(), name);
      assert.deepEqual([file.kind, file.mime, file.name], ['image', 'image/png', name]);
    }
    scene = await sceneOf(visitor, id);
    assert.equal(scene.usage.files, 4);
  });

  it('список принимаемого на странице совпадает с тем, что принимает сервер', () => {
    assert.deepEqual([...ACCEPTED_FORMATS], ['PNG', 'JPEG', 'WebP', 'GIF', 'MP4', 'WebM']);
    assert.equal(ACCEPT_ATTRIBUTE, 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm');
    assert.doesNotMatch(ACCEPT_ATTRIBUTE, /svg|\*/);
    assert.equal(HEAD_BYTES, 64);

    const recognised = [png(), jpeg(), webp(), webp(3, 3, 'VP8L'), webp(3, 3, 'VP8 '), gif(), mp4(), ebml('webm')].map((bytes) => sniffFile(bytes));
    assert.deepEqual(recognised.map((found) => found.format), ['PNG', 'JPEG', 'WebP', 'WebP', 'WebP', 'GIF', 'MP4', 'WebM']);
    assert.deepEqual(new Set(recognised.map((found) => found.mime)), new Set(ACCEPT_ATTRIBUTE.split(',')));
    // Подпись файла в списке называет формат так же, как подсказки: «WebP», а не «WEBP»
    for (const found of recognised) assert.equal(formatName(found.mime), found.format);
    assert.deepEqual(ACCEPT_ATTRIBUTE.split(',').map(formatName), [...ACCEPTED_FORMATS]);
    for (const unknown of ['image/svg+xml', 'text/html', '', undefined, null, 'toString', 'constructor', 'IMAGE/PNG']) {
      assert.equal(formatName(unknown), '');
    }
    // Странице достаточно первых 64 байт — тех же, по которым решает сервер
    for (const bytes of [png(300, 200), gif(), mp4(), ebml('webm')]) {
      assert.deepEqual(sniffFile(bytes.subarray(0, HEAD_BYTES)), sniffFile(bytes));
    }
    for (const junk of [null, undefined, '', 'GIF89a', 42, {}, [], Buffer.alloc(0), Buffer.alloc(64), SVG]) {
      assert.equal(sniffFile(junk), null);
    }
  });

  it('файл присылает только наша страница и только как файл: другие виды запроса не принимаются', async () => {
    const { visitor, id, api } = await newStage(ctx);
    const bytes = png();
    const multipart = Buffer.concat([
      Buffer.from('--x\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n'),
      bytes, Buffer.from('\r\n--x--\r\n'),
    ]);
    const attempts = [
      [multipart, 'multipart/form-data; boundary=x'],
      [bytes, 'image/png'],
      [bytes, 'text/plain'],
      [bytes, 'application/x-www-form-urlencoded'],
      [Buffer.from(JSON.stringify({ file: bytes.toString('base64') })), 'application/json'],
      [bytes, 'application/octet-streamx'],
    ];
    for (const [body, type] of attempts) {
      const res = await visitor.post(`${api}/media`, undefined, { raw: body, headers: { 'Content-Type': type } });
      refusal(res, 415, 'file_required');
    }
    const untyped = await fetch(`${ctx.baseUrl}${api}/media`, {
      method: 'POST',
      headers: { Cookie: [...visitor.jar].map(([name, value]) => `${name}=${value}`).join('; ') },
      body: new Blob([bytes]),
    });
    assert.equal(untyped.status, 415);
    assert.deepEqual(await untyped.json(), { ok: false, error: 'file_required' });

    // Дописанная кодировка не мешает: тип тот же
    const typed = await visitor.post(`${api}/media`, undefined, { raw: bytes, headers: { 'Content-Type': 'Application/Octet-Stream; charset=binary' } });
    assert.equal(typed.status, 201);
    assert.equal((await sceneOf(visitor, id)).usage.files, 1);
    assert.deepEqual(incoming(), []);
  });

  it('название файла — только подпись: путь отбрасывается, а на диск оно не попадает', async () => {
    const { visitor, id, api } = await newStage(ctx);
    const named = async (name, expected) => {
      const file = await uploadFile(visitor, id, png(), name);
      assert.equal(file.name, expected, `название «${name}»`);
    };
    await named('../../etc/passwd', 'passwd');
    await named('C:\\Users\\стример\\Desktop\\рамка.png', 'рамка.png');
    await named('/var/www/..\\..\\рамка.png', 'рамка.png');
    await named('  моя \u200b  рамка\n.png ', 'моя рамка .png');
    await named('<img src=x onerror=alert(1)>.png', '<img src=x onerror=alert(1)>.png');
    await named(`${'я'.repeat(200)}.png`, 'я'.repeat(80));
    await named(`${'🎬'.repeat(81)}`, '🎬'.repeat(80));
    await named('папка/', 'Без названия');
    await named('   ', 'Без названия');
    await named('', 'Без названия');

    // Название испорчено или не прислано — файл всё равно принимается
    const broken = await visitor.upload(`${api}/media`, png(), { headers: { 'X-File-Name': '%E0%A4%A' } });
    assert.equal(broken.data.file.name, 'Без названия');
    const nameless = await visitor.post(`${api}/media`, undefined, { raw: png(), headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(nameless.data.file.name, 'Без названия');

    // В папке площадки — только случайные номера
    const names = fs.readdirSync(path.join(uploadsDir(ctx), id));
    assert.equal(names.length, 12);
    for (const name of names) assert.match(name, PUBLIC_ID);
    assert.deepEqual(fs.readdirSync(uploadsDir(ctx)).filter((name) => name !== '.incoming' && !PUBLIC_ID.test(name)), []);
    assert.equal(fs.existsSync(path.join(ctx.tmpDir, 'etc')), false);
  });

  it('картинка крупнее 8192 точек по стороне или 40 мегапикселей не принимается; нечитаемая — тоже', async () => {
    const { visitor, id, api } = await newStage(ctx);
    // Только заголовок PNG с нужными размерами: сервер читает размеры, а не точки
    const pngHeader = (width, height) => {
      const header = Buffer.alloc(13);
      header.writeUInt32BE(width, 0);
      header.writeUInt32BE(height, 4);
      header[8] = 8;
      header[9] = 6;
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), pngChunk('IEND', Buffer.alloc(0))]);
    };
    const tooBig = { limit: 8192, megapixels: 40 };

    assert.equal((await visitor.upload(`${api}/media`, pngHeader(8192, 4000))).status, 201);
    assert.equal((await visitor.upload(`${api}/media`, pngHeader(6324, 6324))).status, 201, 'чуть меньше 40 мегапикселей');
    refusal(await visitor.upload(`${api}/media`, pngHeader(8193, 10)), 400, 'image_too_big', tooBig);
    refusal(await visitor.upload(`${api}/media`, pngHeader(10, 8193)), 400, 'image_too_big', tooBig);
    refusal(await visitor.upload(`${api}/media`, pngHeader(7000, 6000)), 400, 'image_too_big', tooBig);
    refusal(await visitor.upload(`${api}/media`, pngHeader(0xffffffff, 0xffffffff)), 400, 'image_too_big', tooBig);
    refusal(await visitor.upload(`${api}/media`, jpeg(8193, 100)), 400, 'image_too_big', tooBig);
    refusal(await visitor.upload(`${api}/media`, gif(9000, 2)), 400, 'image_too_big', tooBig);
    refusal(await visitor.upload(`${api}/media`, webp(16000, 16000)), 400, 'image_too_big', tooBig);

    refusal(await visitor.upload(`${api}/media`, pngHeader(0, 10)), 400, 'image_unreadable');
    refusal(await visitor.upload(`${api}/media`, gif(0, 0)), 400, 'image_unreadable');
    refusal(await visitor.upload(`${api}/media`, jpeg(0, 0, { frame: false })), 400, 'image_unreadable');
    refusal(await visitor.upload(`${api}/media`, Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 400, 'image_unreadable');

    assert.equal((await sceneOf(visitor, id)).usage.files, 2);
    assert.equal(filesOnDisk(path.join(uploadsDir(ctx), id)).length, 2);
    assert.deepEqual(incoming(), []);
  });

  it('файл назначается источнику своего вида; занятый файл не удаляется, а удаление источника файл не трогает', async () => {
    const { visitor, id, api } = await newStage(ctx);
    const other = await newStage(ctx, { displayName: 'Сосед' });
    const picture = await uploadFile(visitor, id, png(640, 360), 'рамка.png');
    const sticker = await uploadFile(visitor, id, gif(), 'стикер.gif');
    const clip = await uploadFile(visitor, id, ebml('webm'), 'переход.webm');
    const foreign = await uploadFile(other.visitor, other.id, png(), 'чужая.png');

    const image = await addSource(visitor, id, 'image');
    const assigned = await patchSource(visitor, id, image.id, { file: picture.id });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.data.source.file, picture.id);
    // Сразу при создании — тоже можно
    const animated = await addSource(visitor, id, 'gif', { file: sticker.id });
    const video = await addSource(visitor, id, 'video', { file: clip.id });
    assert.deepEqual([animated.file, video.file], [sticker.id, clip.id]);

    // Картинке нужна картинка, GIF — GIF, видео — видео
    for (const [source, file] of [[image, sticker], [image, clip], [animated, picture], [animated, clip], [video, picture], [video, sticker]]) {
      refusal(await patchSource(visitor, id, source.id, { file: file.id }), 400, 'media_kind_mismatch', { field: 'file' });
    }
    // Файл чужой площадки не отличается от несуществующего
    refusal(await patchSource(visitor, id, image.id, { file: foreign.id }), 404, 'media_not_found');
    refusal(await patchSource(visitor, id, image.id, { file: newLinkToken(12) }), 404, 'media_not_found');
    for (const junk of ['', 'рамка.png', 42, { id: picture.id }, [picture.id], true]) {
      refusal(await patchSource(visitor, id, image.id, { file: junk }), 404, 'media_not_found');
    }
    refusal(await visitor.post(`${api}/sources`, { type: 'image', props: { file: foreign.id } }), 404, 'media_not_found');
    // Источникам без файла он не назначается вовсе
    const text = await addSource(visitor, id, 'text');
    refusal(await patchSource(visitor, id, text.id, { file: picture.id }), 400, 'source_field_invalid', { field: 'file' });

    // Копия источника показывает тот же файл
    const copy = (await visitor.post(`${api}/sources/${image.id}/duplicate`)).data.source;
    assert.equal(copy.file, picture.id);
    let scene = await sceneOf(visitor, id);
    const usedBy = () => Object.fromEntries(scene.media.map((file) => [file.name, file.usedBy]));
    assert.deepEqual(usedBy(), { 'рамка.png': 2, 'стикер.gif': 1, 'переход.webm': 1 });

    // Файл, который показывается на сцене, удалить нельзя
    refusal(await visitor.post(`${api}/media/${picture.id}/delete`), 409, 'media_in_use', { count: 2 });
    assert.equal(fs.existsSync(path.join(uploadsDir(ctx), id, picture.id)), true);

    // Источник удалили или сменили ему файл — файл остаётся в списке площадки
    assert.equal((await visitor.post(`${api}/sources/${copy.id}/delete`)).status, 200);
    refusal(await visitor.post(`${api}/media/${picture.id}/delete`), 409, 'media_in_use', { count: 1 });
    const cleared = await patchSource(visitor, id, image.id, { file: null });
    assert.equal(cleared.data.source.file, null);
    scene = await sceneOf(visitor, id);
    assert.deepEqual(usedBy(), { 'рамка.png': 0, 'стикер.gif': 1, 'переход.webm': 1 });

    const versionBefore = scene.scene.version;
    const removed = await visitor.post(`${api}/media/${picture.id}/delete`);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.data, {
      ok: true, removed: picture.id, usage: { files: 2, storageBytes: sticker.size + clip.size }, version: versionBefore + 1,
    });
    assert.equal(fs.existsSync(path.join(uploadsDir(ctx), id, picture.id)), false, 'файл ушёл и с диска');
    refusal(await visitor.post(`${api}/media/${picture.id}/delete`), 404, 'media_not_found');
    refusal(await visitor.get(`/media/${id}/${picture.id}`), 404, 'media_not_found');
    refusal(await patchSource(visitor, id, image.id, { file: picture.id }), 404, 'media_not_found');

    // Чужой файл через свою площадку не удалить и не открыть
    refusal(await visitor.post(`${api}/media/${foreign.id}/delete`), 404, 'media_not_found');
    refusal(await visitor.get(`/media/${id}/${foreign.id}`), 404, 'media_not_found');
    assert.equal((await other.visitor.get(`/media/${other.id}/${foreign.id}`)).status, 200);
    for (const junk of ['1', 'abc', `${sticker.id}x`, '../', '.incoming']) {
      refusal(await visitor.post(`${api}/media/${encodeURIComponent(junk)}/delete`), 404, 'media_not_found');
    }
  });

  it('файл отдаётся только участнику и только как данные: браузеру запрещено в нём что-либо выполнять', async () => {
    const { visitor, id } = await newStage(ctx);
    // Файл-«перевёртыш»: начинается как GIF, а дальше — текст скрипта и страницы
    const polyglot = Buffer.concat([gif(2, 2), Buffer.from('/*<html><script>alert(document.domain)</script>*/=1;alert(1)')]);
    const samples = [
      [await uploadFile(visitor, id, png(32, 18), 'рамка.png'), png(32, 18), 'image/png'],
      [await uploadFile(visitor, id, polyglot, 'хитрый.html'), polyglot, 'image/gif'],
      [await uploadFile(visitor, id, sized(mp4(), 5000), 'ролик.mp4'), sized(mp4(), 5000), 'video/mp4'],
    ];
    for (const [file, bytes, mime] of samples) {
      const res = await visitor.get(`/media/${id}/${file.id}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.bytes, bytes, 'файл отдан байт в байт');
      // Тип — тот, что определён по содержимому при загрузке, и браузеру запрещено «угадывать» другой
      assert.equal(res.headers.get('content-type'), mime);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
      assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
      // Браузер хранит файл, но перед показом каждый раз спрашивает сервер — там проверяются права
      assert.equal(res.headers.get('cache-control'), 'private, no-cache');
      assert.equal(res.headers.get('content-length'), String(bytes.length));
      assert.equal(res.headers.get('content-disposition'), null);
      assert.equal(res.setCookies.length, 0);
    }

    // Видео браузер читает кусками, а неизменившийся файл не скачивает заново
    const [clip, clipBytes] = samples[2];
    const part = await visitor.get(`/media/${id}/${clip.id}`, { headers: { Range: 'bytes=100-299' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 100-299/${clipBytes.length}`);
    assert.deepEqual(part.bytes, clipBytes.subarray(100, 300));
    const first = await visitor.get(`/media/${id}/${clip.id}`);
    assert.ok(first.headers.get('etag'));
    const again = await plainGet(ctx, visitor, `/media/${id}/${clip.id}`, { 'If-None-Match': first.headers.get('etag') });
    assert.equal(again.status, 304);
    assert.equal(again.bytes.length, 0);
    const changed = await plainGet(ctx, visitor, `/media/${id}/${clip.id}`, { 'If-None-Match': '"another-version"' });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.bytes, clipBytes);

    // Адрес файла — не лазейка к другим файлам сервера
    for (const url of [
      `/media/${id}`, `/media/${id}/`, `/media/${id}/${clip.id}/extra`, `/media/${id}/..%2f..%2fauth-test.db`,
      `/media/${id}/.incoming`, `/media/.incoming/${clip.id}`, `/media/${id}/${clip.id}%00.png`, `/media/..%2f${id}/${clip.id}`,
      `/media/${id}/${clip.id.toUpperCase()}`,
    ]) {
      const res = await visitor.get(url);
      assert.equal(res.status, 404, url);
      assert.notDeepEqual(res.bytes, clipBytes);
    }
    // Папка загрузок не входит в раздаваемые файлы сайта: получить файл можно только по адресу /media
    for (const url of [`/uploads/${id}/${clip.id}`, `/data/uploads/${id}/${clip.id}`, `/${id}/${clip.id}`, '/data/auth-test.db']) {
      assert.equal((await visitor.get(url)).status, 404, url);
    }
    assert.equal(path.relative(ctx.server.config.publicDir, ctx.server.config.uploadsDir).startsWith('..'), true);
    // По адресу файла ничего нельзя изменить
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${ctx.baseUrl}/media/${id}/${clip.id}`, {
        method, headers: { Cookie: [...visitor.jar].map(([name, value]) => `${name}=${value}`).join('; ') },
      });
      assert.equal(res.status, 404, method);
      await res.arrayBuffer();
    }
    assert.equal((await visitor.get(`/media/${id}/${clip.id}`)).status, 200);
  });
});

/* ========================================================================== */

describe('Этап 5 — файлы: размеры, место и одновременные загрузки', () => {
  const incoming = (ctx) => filesOnDisk(path.join(uploadsDir(ctx), '.incoming'));

  it('у картинки, GIF и видео свой предел размера; считается то, что реально пришло', async () => {
    const ctx = await startServer({ sceneLimits: { fileBytes: { image: 2000, gif: 3000, video: 4000 } } });
    try {
      const { visitor, id, api } = await newStage(ctx);
      assert.deepEqual((await sceneOf(visitor, id)).limits.fileBytes, { image: 2000, gif: 3000, video: 4000 });

      // Ровно предел — можно, на байт больше — нельзя
      assert.equal((await visitor.upload(`${api}/media`, sized(png(), 2000))).status, 201);
      assert.equal((await visitor.upload(`${api}/media`, sized(jpeg(), 2000))).status, 201);
      assert.equal((await visitor.upload(`${api}/media`, sized(gif(), 3000))).status, 201);
      assert.equal((await visitor.upload(`${api}/media`, sized(mp4(), 4000))).status, 201);
      refusal(await visitor.upload(`${api}/media`, sized(png(), 2001)), 413, 'file_too_large', { kind: 'image', limitBytes: 2000 });
      refusal(await visitor.upload(`${api}/media`, sized(webp(), 3500)), 413, 'file_too_large', { kind: 'image', limitBytes: 2000 });
      refusal(await visitor.upload(`${api}/media`, sized(gif(), 3001)), 413, 'file_too_large', { kind: 'gif', limitBytes: 3000 });
      // Файл больше самого большого предела сервер отклоняет сразу, по объявленному размеру
      refusal(await visitor.upload(`${api}/media`, sized(mp4(), 4001)), 413, 'file_too_large', { limitBytes: 4000 });
      refusal(await visitor.upload(`${api}/media`, Buffer.alloc(100 * KB, 1)), 413, 'file_too_large', { limitBytes: 4000 });

      // Размер не объявлен (или объявлен неверно): сервер считает байты сам, по мере прихода
      for (const [bytes, extra] of [
        [sized(ebml('webm'), 4001), { kind: 'video', limitBytes: 4000 }],
        [sized(png(), 2001), { kind: 'image', limitBytes: 2000 }],
        [sized(gif(), 60 * KB), { kind: 'gif', limitBytes: 3000 }],
      ]) {
        const upload = slowUpload(ctx, visitor, id);
        await upload.write(bytes.subarray(0, 100));
        await upload.write(bytes.subarray(100, 1500));
        refusal(await upload.finish(bytes.subarray(1500)), 413, 'file_too_large', extra);
      }
      const exact = slowUpload(ctx, visitor, id);
      await exact.write(sized(ebml('webm'), 4000).subarray(0, 10));
      const accepted = await exact.finish(sized(ebml('webm'), 4000).subarray(10));
      assert.equal(accepted.status, 201, accepted.text);
      assert.equal(accepted.data.file.size, 4000);

      // Негодный файл без объявленного размера: ответ приходит, остаток дочитан впустую
      const junk = slowUpload(ctx, visitor, id);
      await junk.write(Buffer.alloc(300 * KB, 7));
      refusal(await junk.finish(Buffer.alloc(300 * KB, 7)), 415, 'file_type_not_allowed');

      const scene = await sceneOf(visitor, id);
      assert.deepEqual(scene.usage, { files: 5, storageBytes: 2000 + 2000 + 3000 + 4000 + 4000 });
      assert.equal(filesOnDisk(path.join(uploadsDir(ctx), id)).length, 5);
      assert.deepEqual(incoming(ctx), [], 'от отказанных файлов не осталось и временных');
    } finally {
      await ctx.stop();
    }
  });

  it('файл, который заведомо не принять, сервер не дочитывает до конца — и ничего не сохраняет', async () => {
    const ctx = await startServer({ sceneLimits: { fileBytes: { image: 2000, gif: 3000, video: 4000 } } });
    try {
      const { visitor, id } = await newStage(ctx);
      // Запас на дочитывание — самый большой предел плюс мегабайт. Дальше соединение закрывается
      const upload = slowUpload(ctx, visitor, id);
      const block = Buffer.alloc(256 * KB, 7);
      let sent = 0;
      const outcome = await Promise.race([
        upload.answer,
        (async () => {
          for (let i = 0; i < 64 && !upload.req.destroyed; i += 1) {
            await Promise.race([upload.write(block), upload.answer]);
            sent += block.length;
          }
          upload.req.end();
          return upload.answer;
        })(),
      ]);
      // Страница видит либо внятный отказ, либо обрыв связи — но не «принято»
      assert.ok([0, 413, 415].includes(outcome.status), `исход: ${outcome.status} ${outcome.text}`);
      assert.ok(sent <= 16 * MB);

      await waitFor(() => incoming(ctx).length === 0, 'временный файл убран');
      const scene = await sceneOf(visitor, id);
      assert.deepEqual(scene.usage, { files: 0, storageBytes: 0 });
      assert.deepEqual(filesOnDisk(path.join(uploadsDir(ctx), id)), []);
      // Сервер после этого работает как обычно, и место для загрузки у человека снова свободно
      assert.equal((await visitor.upload(`/api/workspaces/${id}/scene/media`, png())).status, 201);
    } finally {
      await ctx.stop();
    }
  });

  it('число файлов и место на площадке ограничены; общее место на сервере — тоже', async () => {
    const ctx = await startServer({
      sceneLimits: { filesPerWorkspace: 3, storageBytesPerWorkspace: 5000, storageBytesTotal: 8000 },
    });
    try {
      const owner = await registerUser(ctx.baseUrl);
      const first = await createWorkspace(owner.visitor);
      const second = await createWorkspace(owner.visitor);
      const media = (workspace) => `/api/workspaces/${workspace.id}/scene/media`;
      const scene = await sceneOf(owner.visitor, first.id);
      assert.deepEqual([scene.limits.files, scene.limits.storageBytes], [3, 5000]);

      const a = await uploadFile(owner.visitor, first.id, sized(png(), 2000));
      await uploadFile(owner.visitor, first.id, sized(gif(), 2000));
      // Не хватает одного байта
      refusal(await owner.visitor.upload(media(first), sized(png(), 1001)), 409, 'storage_limit', { limitBytes: 5000 });
      // То же, когда размер заранее не объявлен: файл принят целиком и только потом отклонён
      const undeclared = slowUpload(ctx, owner.visitor, first.id);
      await undeclared.write(sized(png(), 1001).subarray(0, 500));
      refusal(await undeclared.finish(sized(png(), 1001).subarray(500)), 409, 'storage_limit', { limitBytes: 5000 });
      assert.deepEqual(incoming(ctx), []);

      await uploadFile(owner.visitor, first.id, sized(png(), 1000)); // ровно 5000 из 5000
      refusal(await owner.visitor.upload(media(first), png()), 409, 'files_limit', { limit: 3 });
      const fourth = slowUpload(ctx, owner.visitor, first.id);
      refusal(await fourth.finish(png()), 409, 'files_limit', { limit: 3 });
      assert.deepEqual((await sceneOf(owner.visitor, first.id)).usage, { files: 3, storageBytes: 5000 });

      // У второй площадки свой счёт, но место на сервере общее: 5000 + 3000 = 8000
      await uploadFile(owner.visitor, second.id, sized(png(), 3000));
      refusal(await owner.visitor.upload(media(second), png()), 507, 'server_storage_full');
      assert.deepEqual((await sceneOf(owner.visitor, second.id)).usage, { files: 1, storageBytes: 3000 });

      // Удалили файл — место освободилось и на площадке, и на сервере
      assert.equal((await owner.visitor.post(`${media(first)}/${a.id}/delete`)).status, 200);
      assert.equal((await owner.visitor.upload(media(second), sized(png(), 2000))).status, 201);
      refusal(await owner.visitor.upload(media(first), png()), 507, 'server_storage_full');
      assert.equal(filesOnDisk(uploadsDir(ctx)).length, 4);
    } finally {
      await ctx.stop();
    }
  });

  it('одновременных загрузок — не больше заданного: у человека и на сервере в целом', async () => {
    const ctx = await startServer({ sceneLimits: { uploadsAtOncePerUser: 1, uploadsAtOnce: 2 } });
    try {
      const { visitor, id, api } = await newStage(ctx);
      const moderator = await addModerator(ctx.baseUrl, visitor, id);
      const third = await addModerator(ctx.baseUrl, visitor, id);
      const bytes = sized(png(), 4000);

      // Первая загрузка владельца идёт медленно
      const slow = slowUpload(ctx, visitor, id);
      await slow.write(bytes.subarray(0, 1000));
      await waitFor(() => incoming(ctx).length === 1, 'сервер начал принимать файл');
      refusal(await visitor.upload(`${api}/media`, png()), 503, 'server_busy');

      // Модератор загружает своё — это вторая загрузка на сервере, и она же последняя разрешённая
      const alsoSlow = slowUpload(ctx, moderator.visitor, id);
      await alsoSlow.write(bytes.subarray(0, 1000));
      await waitFor(() => incoming(ctx).length === 2, 'сервер принимает два файла сразу');
      refusal(await third.visitor.upload(`${api}/media`, png()), 503, 'server_busy');
      assert.equal((await sceneOf(visitor, id)).usage.files, 0, 'отказы ничего не сохранили');

      const [one, two] = await Promise.all([slow.finish(bytes.subarray(1000)), alsoSlow.finish(bytes.subarray(1000))]);
      assert.equal(one.status, 201, one.text);
      assert.equal(two.status, 201, two.text);
      assert.deepEqual(fs.readFileSync(path.join(uploadsDir(ctx), id, one.data.file.id)), bytes);

      // Места освободились — и после удачных загрузок, и после отказов
      assert.equal((await visitor.upload(`${api}/media`, png())).status, 201);
      assert.equal((await third.visitor.upload(`${api}/media`, png())).status, 201);
      refusal(await visitor.upload(`${api}/media`, SVG), 415, 'file_type_not_allowed');
      assert.equal((await visitor.upload(`${api}/media`, png())).status, 201);
      assert.equal((await sceneOf(visitor, id)).usage.files, 5);
      assert.deepEqual(incoming(ctx), []);
    } finally {
      await ctx.stop();
    }
  });

  it('оборванная загрузка не оставляет после себя ни записи, ни файла, ни занятого места', async () => {
    const ctx = await startServer({ sceneLimits: { uploadsAtOncePerUser: 1 } });
    try {
      const { visitor, id, api } = await newStage(ctx);
      const bytes = sized(png(), 50 * KB);

      const upload = slowUpload(ctx, visitor, id);
      await upload.write(bytes.subarray(0, 20 * KB));
      await waitFor(() => incoming(ctx).length === 1, 'сервер начал принимать файл');
      upload.req.destroy(); // связь пропала посреди файла
      assert.equal((await upload.answer).status, 0);

      await waitFor(() => incoming(ctx).length === 0, 'недокачанный файл убран');
      const scene = await sceneOf(visitor, id);
      assert.deepEqual([scene.media.length, scene.usage.files, scene.scene.version], [0, 0, 0]);
      assert.deepEqual(filesOnDisk(path.join(uploadsDir(ctx), id)), []);
      // Единственное место для загрузки у человека освободилось
      await waitFor(async () => (await visitor.upload(`${api}/media`, png())).status === 201, 'следующая загрузка принята');
    } finally {
      await ctx.stop();
    }
  });

  it('слишком частые загрузки сервер отклоняет; отказанные файлы тоже идут в счёт', async () => {
    let clock = Date.now();
    const ctx = await startServer({ now: () => clock, sceneLimits: { uploadsPerUser: { limit: 3, windowMs: 10 * MINUTE } } });
    try {
      const { visitor, id, api } = await newStage(ctx);
      const moderator = await addModerator(ctx.baseUrl, visitor, id);
      assert.equal((await visitor.upload(`${api}/media`, png())).status, 201);
      assert.equal((await visitor.upload(`${api}/media`, SVG)).status, 415);
      assert.equal((await visitor.upload(`${api}/media`, gif())).status, 201);

      const blocked = await visitor.upload(`${api}/media`, png());
      refusal(blocked, 429, 'too_many_requests', { retryAfterSeconds: 600 });
      assert.equal(blocked.headers.get('retry-after'), '600');
      // Счёт общий на все площадки человека, но у каждого человека свой
      const other = await createWorkspace(visitor);
      refusal(await visitor.upload(`/api/workspaces/${other.id}/scene/media`, png()), 429, 'too_many_requests', { retryAfterSeconds: 600 });
      assert.equal((await moderator.visitor.upload(`${api}/media`, png())).status, 201);
      // Остальная работа со сценой при этом не останавливается
      assert.equal((await visitor.post(`${api}/sources`, { type: 'text' })).status, 201);

      clock += 10 * MINUTE;
      assert.equal((await visitor.upload(`${api}/media`, png())).status, 201);
      assert.equal((await sceneOf(visitor, id)).usage.files, 4);
    } finally {
      await ctx.stop();
    }
  });

  it('пока файл загружался, человека убрали из команды — файл не сохраняется', async () => {
    const ctx = await startServer();
    try {
      const { visitor, id } = await newStage(ctx);
      const moderator = await addModerator(ctx.baseUrl, visitor, id);
      const bytes = sized(png(), 20 * KB);

      const upload = slowUpload(ctx, moderator.visitor, id);
      await upload.write(bytes.subarray(0, 5 * KB));
      await waitFor(() => incoming(ctx).length === 1, 'сервер начал принимать файл');
      assert.equal((await visitor.post(`/api/workspaces/${id}/members/remove`, { username: moderator.username })).status, 200);

      refusal(await upload.finish(bytes.subarray(5 * KB)), 404, 'workspace_not_found');
      const scene = await sceneOf(visitor, id);
      assert.deepEqual([scene.media.length, scene.usage.files, scene.scene.version], [0, 0, 0]);
      assert.deepEqual(filesOnDisk(uploadsDir(ctx)), []);
    } finally {
      await ctx.stop();
    }
  });

  it('замолчавшая загрузка обрывается сама: пропавшая связь не занимает место для загрузки', async () => {
    const ctx = await startServer({ sceneLimits: { uploadIdleMs: 250, uploadsAtOncePerUser: 1 } });
    try {
      const { visitor, id, api } = await newStage(ctx);
      const bytes = sized(png(), 6000);
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      // Медленно, но без долгих пауз — принимается, сколько бы ни длилось в сумме
      const steady = slowUpload(ctx, visitor, id);
      for (let offset = 0; offset < 5000; offset += 500) {
        await steady.write(bytes.subarray(offset, offset + 500));
        await pause(60);
      }
      const accepted = await steady.finish(bytes.subarray(5000));
      assert.equal(accepted.status, 201, accepted.text);
      assert.deepEqual(fs.readFileSync(path.join(uploadsDir(ctx), id, accepted.data.file.id)), bytes);

      // Связь пропала посреди файла: ни байта, ни обрыва. Сервер сам закрывает соединение
      const stalled = slowUpload(ctx, visitor, id);
      await stalled.write(bytes.subarray(0, 3000));
      await waitFor(() => incoming(ctx).length === 1, 'сервер начал принимать файл');
      const cut = await within(stalled.answer, 3000, 'сервер закрывает замолчавшее соединение');
      assert.equal(cut.status, 0);
      await waitFor(() => incoming(ctx).length === 0, 'недокачанный файл убран');
      // Единственное место для загрузки освободилось
      await waitFor(async () => (await visitor.upload(`${api}/media`, png())).status === 201, 'следующая загрузка принята');

      // То же с файлом, который сервер уже отклонил и лишь дочитывает
      const refusedAndStalled = slowUpload(ctx, visitor, id);
      await refusedAndStalled.write(Buffer.alloc(3000, 7));
      assert.equal((await within(refusedAndStalled.answer, 3000, 'сервер закрывает замолчавшее соединение')).status, 0);

      // Срок молчания действует только на время загрузки: после неё соединение служит дальше
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const viaAgent = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
          const target = new URL(url, ctx.baseUrl);
          const req = http.request({
            agent, method, host: target.hostname, port: target.port, path: target.pathname,
            headers: { Cookie: [...visitor.jar].map(([name, value]) => `${name}=${value}`).join('; '), ...headers },
          }, (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode, reused: req.reusedSocket }));
          });
          req.on('error', reject);
          req.end(body);
        });
        const first = await viaAgent('POST', `${api}/media`, png(), { 'Content-Type': 'application/octet-stream' });
        assert.equal(first.status, 201);
        await pause(600); // дольше срока молчания
        const second = await viaAgent('GET', api);
        assert.deepEqual(second, { status: 200, reused: true }, 'то же соединение живо и после срока молчания');
      } finally {
        agent.destroy();
      }

      assert.equal((await sceneOf(visitor, id)).usage.files, 3);
      assert.deepEqual(incoming(ctx), []);
    } finally {
      await ctx.stop();
    }
  });

  it('на загрузку отводится достаточно времени и для медленной связи', async () => {
    const ctx = await startServer();
    try {
      const { requestTimeout, headersTimeout } = ctx.server.httpServer;
      // Запрос целиком сервер ждёт полчаса — а не пять минут, как принято по умолчанию
      assert.equal(requestTimeout, 30 * MINUTE);
      // Самый большой файл успевает дойти при скорости 256 кбит/с (32 КБ в секунду)
      const slowestSeconds = DEFAULT_SCENE_LIMITS.fileBytes.video / (32 * KB);
      assert.ok(slowestSeconds * 1000 < requestTimeout, `нужно ${Math.round(slowestSeconds)} с`);
      // Заголовки запроса по-прежнему должны прийти быстро
      assert.ok(headersTimeout > 0 && headersTimeout <= MINUTE);
      // Молчание дольше минуты — потерянная связь
      assert.equal(DEFAULT_SCENE_LIMITS.uploadIdleMs, MINUTE);
      assert.equal(ctx.server.scene.uploadIdleMs, MINUTE);
    } finally {
      await ctx.stop();
    }
  });

  it('остановка сервера: начатое даёт закончить, но не ждёт без срока и не оставляет недокачанных файлов', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krafen-stop-'));
    let ctx = null;
    try {
      ctx = await startServer({ tmpDir });
      const { visitor, id } = await newStage(ctx);
      const bytes = sized(png(), 6000);

      // Одна загрузка вот-вот закончится, другая «зависла»
      const finishing = slowUpload(ctx, visitor, id);
      await finishing.write(bytes.subarray(0, 3000));
      const hanging = slowUpload(ctx, visitor, id);
      await hanging.write(bytes.subarray(0, 3000));
      await waitFor(() => incoming(ctx).length === 2, 'сервер принимает два файла');

      const stopping = ctx.server.stop({ graceMs: 400 });
      // Пока сервер останавливается, начатая загрузка успевает завершиться и сохраниться
      const done = await within(finishing.finish(bytes.subarray(3000)), 3000, 'начатая загрузка завершается');
      assert.equal(done.status, 201, done.text);
      await within(stopping, 4000, 'сервер останавливается, не дожидаясь «зависшей» загрузки');
      // К этому мгновению недокачанный файл уже убран: после остановки убирать его было бы некому
      assert.deepEqual(filesOnDisk(path.join(tmpDir, 'uploads', '.incoming')), []);
      assert.equal((await within(hanging.answer, 1000, 'оборванная загрузка получает исход')).status, 0, '«зависшая» загрузка оборвана');

      // Новые запросы уже не принимаются
      await assert.rejects(fetch(`${ctx.baseUrl}/api/health`));
      // Повторная остановка — не ошибка
      await ctx.server.stop();
      await ctx.stop({ keepFiles: true });

      // На диске — только сохранённый файл; в базе — запись о нём; недокачанного нет
      assert.deepEqual(filesOnDisk(path.join(tmpDir, 'uploads', '.incoming')), []);
      assert.deepEqual(fs.readdirSync(path.join(tmpDir, 'uploads', id)), [done.data.file.id]);
      const reopened = openDatabase(path.join(tmpDir, 'auth-test.db'));
      try {
        const rows = reopened.raw.prepare('SELECT public_id, size_bytes FROM media_files').all();
        assert.deepEqual(rows.map((row) => ({ ...row })), [{ public_id: done.data.file.id, size_bytes: 6000 }]);
      } finally {
        reopened.close();
      }
    } finally {
      // Если проверка упала раньше остановки, соединения закрываются принудительно
      ctx?.server.httpServer.closeAllConnections();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/* ========================================================================== */

describe('Этап 5 — таймер: ход хранит сервер', () => {
  let ctx;
  let clock;
  before(async () => {
    clock = Date.now();
    ctx = await startServer({ now: () => clock });
  });
  after(async () => { await ctx.stop(); });

  const command = (stage, sourceId, action) =>
    stage.visitor.post(`${stage.api}/sources/${sourceId}/command`, action === undefined ? {} : { action });
  const stateOf = async (stage, sourceId) => (await sceneOf(stage.visitor, stage.id)).sources.find((source) => source.id === sourceId).state;

  it('пуск, пауза, продолжение и сброс: время берётся по часам сервера', async () => {
    const stage = await newStage(ctx);
    const timer = await addSource(stage.visitor, stage.id, 'timer');
    assert.deepEqual(timer.state, { running: false, base: 300_000, since: 0 });
    assert.equal((await sceneOf(stage.visitor, stage.id)).serverTime, clock, 'страница получает время сервера вместе со сценой');

    const started = await command(stage, timer.id, 'start');
    assert.equal(started.status, 200);
    assert.deepEqual(Object.keys(started.data).sort(), ['ok', 'source', 'version']);
    assert.equal(started.data.version, 2);
    assert.deepEqual(started.data.source, { ...timer, state: { running: true, base: 300_000, since: clock } });
    const startedAt = clock;

    // Сервер ничего не «тикает»: хранится только то, от чего считать
    clock += 10_000;
    assert.deepEqual(await stateOf(stage, timer.id), { running: true, base: 300_000, since: startedAt });

    const paused = await command(stage, timer.id, 'pause');
    assert.deepEqual(paused.data.source.state, { running: false, base: 290_000, since: 0 });
    clock += 60_000; // на паузе время не идёт
    const resumed = await command(stage, timer.id, 'start');
    assert.deepEqual(resumed.data.source.state, { running: true, base: 290_000, since: clock });

    clock += 5_000;
    const reset = await command(stage, timer.id, 'reset');
    assert.deepEqual(reset.data.source.state, { running: false, base: 300_000, since: 0 });
    assert.equal(reset.data.version, 5);

    // Команда, которая ничего не меняет, версию не трогает
    for (const action of ['reset', 'pause']) {
      const idle = await command(stage, timer.id, action);
      assert.equal(idle.status, 200);
      assert.equal(idle.data.version, 5, action);
    }
    assert.equal((await command(stage, timer.id, 'start')).data.version, 6);
    clock += 1_000;
    const again = await command(stage, timer.id, 'start');
    assert.equal(again.data.version, 6, 'повторный «Пуск» идущему таймеру ничего не меняет');
    assert.deepEqual(again.data.source.state, { running: true, base: 300_000, since: clock - 1_000 });
  });

  it('отсчёт, дошедший до нуля, «Пуск» запускает заново с полного времени', async () => {
    const stage = await newStage(ctx);
    const timer = await addSource(stage.visitor, stage.id, 'timer', { settings: { duration: 30 } });
    assert.deepEqual(timer.state, { running: false, base: 30_000, since: 0 });

    const startedAt = clock;
    await command(stage, timer.id, 'start');
    clock += 31_000;
    // Останавливать его некому: в записи он всё ещё «идёт», а на экране — ноль
    const finished = await stateOf(stage, timer.id);
    assert.deepEqual(finished, { running: true, base: 30_000, since: startedAt });
    assert.equal(timerValue(timer.settings, finished, clock), 0);

    const restarted = await command(stage, timer.id, 'start');
    assert.deepEqual(restarted.data.source.state, { running: true, base: 30_000, since: clock });

    // То же после паузы на нуле
    clock += 45_000;
    assert.deepEqual((await command(stage, timer.id, 'pause')).data.source.state, { running: false, base: 0, since: 0 });
    assert.deepEqual((await command(stage, timer.id, 'start')).data.source.state, { running: true, base: 30_000, since: clock });
  });

  it('смена режима или времени отсчёта начинает счёт заново; оформление счёт не сбивает', async () => {
    const stage = await newStage(ctx);
    const timer = await addSource(stage.visitor, stage.id, 'timer');
    const set = (settings) => patchSource(stage.visitor, stage.id, timer.id, { settings });

    await command(stage, timer.id, 'start');
    const running = { running: true, base: 300_000, since: clock };
    clock += 20_000;
    // Цвет, шрифт, надпись «время вышло», положение — таймер идёт как шёл
    for (const settings of [{ color: '#ff0000' }, { size: 120, bold: true }, { endText: 'Поехали!' }, { duration: 300 }, { mode: 'countdown' }]) {
      assert.deepEqual((await set(settings)).data.source.state, running, JSON.stringify(settings));
    }
    assert.deepEqual((await patchSource(stage.visitor, stage.id, timer.id, { x: 10, name: 'До эфира' })).data.source.state, running);

    assert.deepEqual((await set({ duration: 90 })).data.source.state, { running: false, base: 90_000, since: 0 });
    await command(stage, timer.id, 'start');
    assert.deepEqual((await set({ mode: 'stopwatch' })).data.source.state, { running: false, base: 0, since: 0 });

    // Секундомер считает вверх
    await command(stage, timer.id, 'start');
    clock += 90_500;
    assert.deepEqual((await command(stage, timer.id, 'pause')).data.source.state, { running: false, base: 90_500, since: 0 });
    assert.deepEqual((await command(stage, timer.id, 'reset')).data.source.state, { running: false, base: 0, since: 0 });

    // Пределы времени отсчёта: от секунды до 99:59:59
    assert.equal(TIMER_MAX_SECONDS, 359_999);
    assert.equal((await set({ mode: 'countdown', duration: 1 })).status, 200);
    assert.equal((await set({ duration: 359_999 })).data.source.state.base, 359_999_000);
    for (const duration of [0, -5, 360_000, '300', null]) {
      refusal(await set({ duration }), 400, 'source_setting_invalid', { field: 'settings.duration' });
    }
  });

  it('часам управлять нечем; команды есть только у таймера, и только три', async () => {
    const stage = await newStage(ctx);
    const timer = await addSource(stage.visitor, stage.id, 'timer');
    const clockSource = await addSource(stage.visitor, stage.id, 'timer', { settings: { mode: 'clock', utcOffset: 300, showSeconds: false } });
    assert.deepEqual([clockSource.settings.mode, clockSource.settings.utcOffset, clockSource.settings.showSeconds], ['clock', 300, false]);

    for (const action of ['start', 'pause', 'reset', 'самоуничтожение']) {
      refusal(await command(stage, clockSource.id, action), 409, 'source_no_commands');
    }
    for (const type of ['text', 'image', 'gif', 'video', 'shape', 'widget']) {
      const source = await addSource(stage.visitor, stage.id, type);
      refusal(await command(stage, source.id, 'start'), 409, 'source_no_commands');
    }
    for (const action of ['stop', 'START', ' start', '', null, 5, true, ['start'], { action: 'start' }, '__proto__', 'constructor', 'toString', undefined]) {
      refusal(await command(stage, timer.id, action), 400, 'source_command_unknown', { field: 'action' });
    }
    // Часовой пояс — только из списка
    for (const utcOffset of [185, 1000, '180', null]) {
      refusal(
        await patchSource(stage.visitor, stage.id, clockSource.id, { settings: { utcOffset } }),
        400, 'source_setting_invalid', { field: 'settings.utcOffset' }
      );
    }
    assert.deepEqual(await stateOf(stage, timer.id), { running: false, base: 300_000, since: 0 });
    assert.equal((await sceneOf(stage.visitor, stage.id)).scene.version, 8);
  });

  it('страница не может прислать ход таймера — только попросить о действии', async () => {
    const stage = await newStage(ctx);
    const timer = await addSource(stage.visitor, stage.id, 'timer');
    const forged = { running: true, base: 1, since: 1 };

    refusal(await patchSource(stage.visitor, stage.id, timer.id, { state: forged }), 400, 'source_field_invalid', { field: 'state' });
    refusal(
      await stage.visitor.post(`${stage.api}/sources`, { type: 'timer', props: { state: forged } }),
      400, 'source_field_invalid', { field: 'state' }
    );
    refusal(await patchSource(stage.visitor, stage.id, timer.id, { settings: { state: forged } }), 400, 'source_setting_invalid', { field: 'settings.state' });
    // Лишнее в команде не учитывается: время — только серверное
    const started = await stage.visitor.post(`${stage.api}/sources/${timer.id}/command`, { action: 'start', now: 1, since: 1, state: forged });
    assert.deepEqual(started.data.source.state, { running: true, base: 300_000, since: clock });

    // Копия идущего таймера начинает свой счёт заново
    clock += 15_000;
    const copy = (await stage.visitor.post(`${stage.api}/sources/${timer.id}/duplicate`)).data.source;
    assert.deepEqual(copy.state, { running: false, base: 300_000, since: 0 });
    assert.deepEqual(copy.settings, timer.settings);
  });

  it('счёт таймера: одни и те же правила на сервере и на странице', () => {
    const countdown = { mode: 'countdown', duration: 300, endText: '', utcOffset: 180, showSeconds: true };
    const stopwatch = { ...countdown, mode: 'stopwatch' };
    const T = 1_700_000_000_000;

    assert.deepEqual(initialTimerState(countdown), { running: false, base: 300_000, since: 0 });
    assert.deepEqual(initialTimerState(stopwatch), { running: false, base: 0, since: 0 });

    // Обратный отсчёт: «00:01» держится всю последнюю секунду, ноль появляется ровно в ноль
    const running = { running: true, base: 300_000, since: T };
    assert.equal(timerText(countdown, running, T), '05:00');
    assert.equal(timerText(countdown, running, T + 1), '05:00');
    assert.equal(timerText(countdown, running, T + 1_000), '04:59');
    assert.equal(timerText(countdown, running, T + 299_001), '00:01');
    assert.equal(timerText(countdown, running, T + 300_000), '00:00');
    assert.equal(timerText(countdown, running, T + 999_000), '00:00', 'ниже нуля отсчёт не уходит');
    assert.equal(timerText({ ...countdown, endText: 'Начинаем!' }, running, T + 300_000), 'Начинаем!');
    assert.equal(timerText({ ...countdown, endText: 'Начинаем!' }, running, T + 299_999), '00:01');
    assert.deepEqual(
      [timerPhase(countdown, running, T + 1), timerPhase(countdown, running, T + 300_000), timerPhase(countdown, initialTimerState(countdown), T)],
      ['running', 'finished', 'idle']
    );
    // Часы устройства отстали от серверных — таймер не «прибавляет» время
    assert.equal(timerValue(countdown, running, T - 5_000), 300_000);

    // Секундомер считает вверх и останавливается на 99:59:59
    const watch = { running: true, base: 0, since: T };
    assert.equal(timerText(stopwatch, watch, T + 999), '00:00');
    assert.equal(timerText(stopwatch, watch, T + 61_000), '01:01');
    assert.equal(timerText(stopwatch, watch, T + 3_600_000), '1:00:00');
    assert.equal(timerText(stopwatch, watch, T + 10 ** 12), '99:59:59');
    assert.equal(timerPhase(stopwatch, watch, T + 10 ** 12), 'running');
    assert.deepEqual([formatDuration(0), formatDuration(59.9), formatDuration(3_599), formatDuration(36_000), formatDuration(-5)], ['00:00', '00:59', '59:59', '10:00:00', '00:00']);

    // Часы: время сервера плюс смещение пояса — одинаково у всех, кто смотрит
    const noon = Date.UTC(2026, 10, 12, 12, 0, 5);
    assert.equal(formatClock(noon, 0, true), '12:00:05');
    assert.equal(formatClock(noon, 180, false), '15:00');
    assert.equal(formatClock(noon, -570, true), '02:30:05');
    assert.equal(formatClock(noon, 765, true), '00:45:05');
    assert.equal(timerText({ ...countdown, mode: 'clock' }, running, noon), '15:00:05');

    // Команды: новое состояние или null, если такой команды нет
    assert.deepEqual(applyTimerCommand(countdown, initialTimerState(countdown), 'start', T), running);
    assert.equal(applyTimerCommand(countdown, running, 'start', T + 5), running, 'идущему таймеру «Пуск» ничего не меняет');
    assert.deepEqual(applyTimerCommand(countdown, running, 'pause', T + 1_500), { running: false, base: 298_500, since: 0 });
    assert.deepEqual(applyTimerCommand(countdown, running, 'reset', T + 1_500), initialTimerState(countdown));
    assert.deepEqual(applyTimerCommand(countdown, running, 'start', T + 300_000), { running: true, base: 300_000, since: T + 300_000 });
    for (const action of ['stop', '', null, undefined, 'toString']) assert.equal(applyTimerCommand(countdown, running, action, T), null);

    // Испорченная запись из базы превращается в исходное состояние, а не в ошибку
    for (const junk of [null, undefined, 'идёт', 42, [], {}, { running: 'yes', base: 1, since: 1 }, { running: true, base: NaN, since: 1 }, { running: true, base: 1 }]) {
      assert.deepEqual(readTimerState(countdown, junk), initialTimerState(countdown));
    }
    assert.deepEqual(readTimerState(countdown, { running: true, base: 10 ** 15, since: -5 }), { running: true, base: 359_999_000, since: 0 });
    assert.deepEqual(readTimerState(countdown, { running: false, base: -1, since: 7, extra: 'x' }), { running: false, base: 0, since: 7 });
  });
});

/* ========================================================================== */

describe('Этап 5 — версия сцены и сигнал открытым страницам', () => {
  let ctx;
  let stage;
  let moderator;
  before(async () => {
    ctx = await startServer();
    stage = await newStage(ctx);
    moderator = await addModerator(ctx.baseUrl, stage.visitor, stage.id, { displayName: 'Модератор' });
  });
  after(async () => { await ctx.stop(); });

  async function joinLive(visitor, workspaceId = stage.id) {
    const pass = await visitor.post(`/api/workspaces/${workspaceId}/live`);
    assert.equal(pass.status, 200, `пропуск не выдан: ${pass.text}`);
    const socket = await openSocket(`${ctx.baseUrl.replace('http:', 'ws:')}/ws?channel=workspace:${workspaceId}&ticket=${pass.data.ticket}`);
    const hello = await socket.next();
    assert.equal(hello.type, 'hello');
    return socket;
  }

  const TAB = 'tab7k2m9x4pq'; // метка страницы: по ней страница узнаёт в рассылке собственную правку
  const from = (tab) => ({ headers: { 'X-Client-Id': tab } });

  it('после каждой сохранённой правки страницы площадки получают номер версии и метку страницы-автора', async () => {
    const mine = await joinLive(stage.visitor);
    const secondTab = await joinLive(stage.visitor);
    const theirs = await joinLive(moderator.visitor);
    try {
      const created = await stage.visitor.post(`${stage.api}/sources`, { type: 'text' }, from(TAB));
      assert.equal(created.status, 201);
      const version = created.data.version;
      const signal = { type: 'workspace:changed', what: 'scene', version, origin: TAB };
      // mine — правку сделал сам этот человек (в этой или другой вкладке); какая именно вкладка — видно по метке
      assert.deepEqual(await mine.next(), { ...signal, mine: true });
      assert.deepEqual(await secondTab.next(), { ...signal, mine: true });
      assert.deepEqual(await theirs.next(), { ...signal, mine: false });

      // Сигнал данных не несёт: саму сцену страница перечитывает обычным запросом, где проверяются права
      assert.equal((await sceneOf(moderator.visitor, stage.id)).scene.version, version);

      // Правка модератора — без метки: её в сообщении просто нет
      const moved = await patchSource(moderator.visitor, stage.id, created.data.source.id, { x: 7 });
      const plain = { type: 'workspace:changed', what: 'scene', version: version + 1 };
      assert.deepEqual(await theirs.next(), { ...plain, mine: true });
      assert.deepEqual(await mine.next(), { ...plain, mine: false });
      assert.deepEqual(await secondTab.next(), { ...plain, mine: false });
      assert.equal(moved.data.version, version + 1);

      // Метка — не право и не секрет, но и не место для чужого текста: негодная в рассылку не попадает
      const junk = ['short', 'UPPERCASE123', 'с-кириллицей-12', 'a'.repeat(33), 'tab with space', '<script>alert(1)</script>', 'tab-with-dash'];
      for (const [index, tab] of junk.entries()) {
        const res = await stage.visitor.patch(
          `${stage.api}/sources/${created.data.source.id}`, { x: 100 + index }, { headers: { 'X-Client-Id': encodeURIComponent(tab) } }
        );
        assert.equal(res.status, 200, tab);
        assert.deepEqual(await theirs.next(), { type: 'workspace:changed', what: 'scene', version: version + 2 + index, mine: false }, tab);
        await mine.next();
        await secondTab.next();
      }
      for (const tab of ['abcdefgh', 'a'.repeat(32), '0123456789']) {
        await stage.visitor.patch(`${stage.api}/sources/${created.data.source.id}`, { y: tab.length }, from(tab));
        assert.equal((await theirs.next()).origin, tab);
        await mine.next();
        await secondTab.next();
      }
    } finally {
      await Promise.all([mine.close(), secondTab.close(), theirs.close()]);
    }
  });

  it('сигнал приходит после любого изменения сцены — и не приходит, если ничего не изменилось', async () => {
    const listener = await joinLive(moderator.visitor);
    try {
      const { visitor, api, id } = stage;
      const start = (await sceneOf(visitor, id)).scene.version;
      const versions = [];
      const expectSignal = async (res, what) => {
        assert.ok(res.status === 200 || res.status === 201, `${what}: ${res.text}`);
        const message = await listener.next();
        assert.deepEqual(message, { type: 'workspace:changed', what: 'scene', mine: false, version: res.data.version, origin: TAB }, what);
        versions.push(message.version);
        return res.data;
      };
      const silent = [];

      const timer = (await expectSignal(await visitor.post(`${api}/sources`, { type: 'timer' }, from(TAB)), 'новый источник')).source;
      const image = (await expectSignal(await visitor.post(`${api}/sources`, { type: 'image' }, from(TAB)), 'второй источник')).source;
      await expectSignal(await visitor.patch(`${api}/sources/${timer.id}`, { name: 'До эфира' }, from(TAB)), 'правка');
      silent.push(await visitor.patch(`${api}/sources/${timer.id}`, { name: 'До эфира' }, from(TAB))); // то же самое
      await expectSignal(await visitor.post(`${api}/sources/${timer.id}/move`, { index: 99 }, from(TAB)), 'порядок слоёв');
      silent.push(await visitor.post(`${api}/sources/${timer.id}/move`, { index: 99 }, from(TAB))); // уже наверху
      await expectSignal(await visitor.post(`${api}/sources/${timer.id}/command`, { action: 'start' }, from(TAB)), 'команда таймеру');
      silent.push(await visitor.post(`${api}/sources/${timer.id}/command`, { action: 'start' }, from(TAB))); // уже идёт
      const copy = (await expectSignal(await visitor.post(`${api}/sources/${timer.id}/duplicate`, {}, from(TAB)), 'копия')).source;
      const file = (await expectSignal(await visitor.upload(`${api}/media`, png(), from(TAB)), 'загрузка файла')).file;
      await expectSignal(await visitor.patch(`${api}/sources/${image.id}`, { file: file.id }, from(TAB)), 'файл назначен');
      await expectSignal(await visitor.patch(`${api}/sources/${image.id}`, { file: null }, from(TAB)), 'файл снят');
      await expectSignal(await visitor.post(`${api}/media/${file.id}/delete`, {}, from(TAB)), 'удаление файла');
      await expectSignal(await visitor.post(`${api}/sources/${copy.id}/delete`, {}, from(TAB)), 'удаление источника');

      // Отказы — тоже без сигнала
      const refused = [
        await visitor.patch(`${api}/sources/${timer.id}`, { width: 1 }, from(TAB)),
        await visitor.post(`${api}/sources/${copy.id}/delete`, {}, from(TAB)),
        await visitor.post(`${api}/sources`, { type: 'нет такого' }, from(TAB)),
        await visitor.upload(`${api}/media`, SVG, from(TAB)),
        await visitor.post(`${api}/media/${file.id}/delete`, {}, from(TAB)),
        await visitor.post(`${api}/sources/${image.id}/command`, { action: 'start' }, from(TAB)),
      ];
      assert.deepEqual(refused.map((res) => res.status), [400, 404, 400, 415, 404, 409]);
      for (const res of silent) assert.equal(res.status, 200);

      // Версия росла ровно на единицу за каждое изменение
      assert.deepEqual(versions, versions.map((_, index) => start + 1 + index));
      assert.equal(versions.length, 11);
      // Следующее сообщение — от следующей настоящей правки: «тихие» команды и отказы ничего не послали
      const last = await visitor.patch(`${api}/sources/${timer.id}`, { x: 1 }, from(TAB));
      assert.equal(last.data.version, start + 12);
      assert.equal((await listener.next()).version, start + 12);
      assert.equal(listener.inbox.length, 0);
      assert.equal((await sceneOf(visitor, id)).scene.version, start + 12);
    } finally {
      await listener.close();
    }
  });

  it('сигнал о сцене получают только страницы этой площадки', async () => {
    const neighbour = await newStage(ctx, { displayName: 'Сосед' });
    const theirs = await joinLive(neighbour.visitor, neighbour.id);
    const ours = await joinLive(moderator.visitor);
    try {
      await addSource(stage.visitor, stage.id, 'shape');
      assert.equal((await ours.next()).what, 'scene');
      await addSource(neighbour.visitor, neighbour.id, 'shape');
      // Соседу пришло одно сообщение — о его собственной сцене
      assert.deepEqual(await theirs.next(), { type: 'workspace:changed', what: 'scene', mine: true, version: 1 });
      assert.equal(theirs.inbox.length, 0);
      assert.equal(ours.inbox.length, 0);
    } finally {
      await Promise.all([theirs.close(), ours.close()]);
    }
  });
});

/* ========================================================================== */

describe('Этап 5 — удаление площадки, уборка и обновление с прошлого этапа', () => {
  it('вместе с площадкой исчезают её сцена и файлы — и из базы, и с диска; соседние площадки не задеты', async () => {
    const ctx = await startServer();
    try {
      const doomed = await newStage(ctx, { name: 'Площадка под снос' });
      const neighbour = await newStage(ctx, { displayName: 'Сосед' });
      for (const stage of [doomed, neighbour]) {
        const file = await uploadFile(stage.visitor, stage.id, png(), 'рамка.png');
        await addSource(stage.visitor, stage.id, 'image', { file: file.id });
        await addSource(stage.visitor, stage.id, 'timer');
        await uploadFile(stage.visitor, stage.id, sized(mp4(), 3000), 'ролик.mp4');
        stage.file = file.id;
      }
      const count = (table) => ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      assert.deepEqual([count('sources'), count('media_files')], [4, 4]);
      assert.equal(fs.existsSync(path.join(uploadsDir(ctx), doomed.id)), true);
      const neighbourBefore = await sceneOf(neighbour.visitor, neighbour.id);

      const removed = await doomed.visitor.post(`/api/workspaces/${doomed.id}/delete`, { confirmName: 'Площадка под снос' });
      assert.equal(removed.status, 200);

      assert.deepEqual([count('sources'), count('media_files')], [2, 2]);
      assert.equal(fs.existsSync(path.join(uploadsDir(ctx), doomed.id)), false, 'папка файлов площадки удалена');
      refusal(await doomed.visitor.get(doomed.api), 404, 'workspace_not_found');
      refusal(await doomed.visitor.get(`/media/${doomed.id}/${doomed.file}`), 404, 'workspace_not_found');

      const neighbourAfter = await sceneOf(neighbour.visitor, neighbour.id);
      assert.deepEqual({ ...neighbourAfter, serverTime: 0 }, { ...neighbourBefore, serverTime: 0 });
      assert.equal(filesOnDisk(path.join(uploadsDir(ctx), neighbour.id)).length, 2);
      assert.equal((await neighbour.visitor.get(`/media/${neighbour.id}/${neighbour.file}`)).status, 200);
    } finally {
      await ctx.stop();
    }
  });

  it('аккаунт владельца удалён — его сцены исчезают из базы; файл ушедшего модератора остаётся площадке', async () => {
    const ctx = await startServer();
    try {
      const stage = await newStage(ctx);
      const moderator = await addModerator(ctx.baseUrl, stage.visitor, stage.id, { displayName: 'Ушедший модератор' });
      const file = await uploadFile(moderator.visitor, stage.id, png(), 'от-модератора.png');
      await addSource(stage.visitor, stage.id, 'image', { file: file.id });
      const userRow = (username) => ctx.db.prepare('SELECT id FROM users WHERE username_key = ?').get(username.toLowerCase()).id;

      // Удаления аккаунта в интерфейсе пока нет; так оно выглядит на уровне базы
      ctx.db.prepare('DELETE FROM users WHERE id = ?').run(userRow(moderator.username));
      const scene = await sceneOf(stage.visitor, stage.id);
      assert.equal(scene.media.length, 1);
      assert.equal(scene.media[0].uploadedBy, null, 'файл остался, имя загрузившего — пусто');
      assert.equal(scene.sources[0].file, file.id);
      assert.equal((await stage.visitor.get(`/media/${stage.id}/${file.id}`)).status, 200);

      ctx.db.prepare('DELETE FROM users WHERE id = ?').run(userRow(stage.owner.username));
      const count = (table) => ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      assert.deepEqual([count('workspaces'), count('sources'), count('media_files')], [0, 0, 0]);
      // Сами файлы убирает ближайшая уборка: папка площадки, которой больше нет в базе
      assert.equal(fs.existsSync(path.join(uploadsDir(ctx), stage.id)), true);
      assert.equal(ctx.server.scene.cleanup(), 1);
      assert.equal(fs.existsSync(path.join(uploadsDir(ctx), stage.id)), false);
    } finally {
      await ctx.stop();
    }
  });

  it('уборка удаляет недокачанное и то, о чём база не знает, — и не трогает ни нужного, ни постороннего', async () => {
    let clock = Date.now();
    const ctx = await startServer({ now: () => clock });
    try {
      const stage = await newStage(ctx);
      const kept = await uploadFile(stage.visitor, stage.id, png(), 'нужный.png');
      const root = uploadsDir(ctx);
      const put = (relative, content = 'x') => {
        const full = path.join(root, relative);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        return full;
      };
      const ghostWorkspace = newLinkToken(12);
      const stale = put(`.incoming/${newLinkToken(26)}`); // недокачанный файл
      const orphan = put(`${stage.id}/${newLinkToken(12)}`); // файл, которого нет в базе
      const ghost = put(`${ghostWorkspace}/${newLinkToken(12)}`); // папка площадки, которой нет
      // Постороннее: не похоже на наши номера — значит, положил человек, и не нам это удалять
      const foreign = [put('README.txt'), put('backup/old.png'), put(`${stage.id}/notes.txt`), put(`${stage.id}/${kept.id}.bak`), put('.gitkeep', '')];

      // Свежее не трогается — оно может ещё загружаться. Папка несуществующей площадки уходит сразу
      assert.equal(ctx.server.scene.cleanup(), 1);
      assert.equal(fs.existsSync(ghost), false);
      assert.equal(fs.existsSync(path.join(root, ghostWorkspace)), false);
      assert.deepEqual([stale, orphan].map((file) => fs.existsSync(file)), [true, true]);

      clock += 59 * MINUTE;
      assert.equal(ctx.server.scene.cleanup(), 0, 'часа ещё не прошло');
      clock += 2 * MINUTE;
      assert.equal(ctx.server.scene.cleanup(), 2);
      assert.deepEqual([stale, orphan].map((file) => fs.existsSync(file)), [false, false]);

      for (const file of foreign) assert.equal(fs.existsSync(file), true, `${path.relative(root, file)} удалён уборкой`);
      assert.deepEqual(fs.readFileSync(path.join(root, stage.id, kept.id)), png());
      assert.equal((await stage.visitor.get(`/media/${stage.id}/${kept.id}`)).status, 200);
      assert.equal(ctx.server.scene.cleanup(), 0, 'повторная уборка ничего не находит');
      assert.equal((await sceneOf(stage.visitor, stage.id)).usage.files, 1);
    } finally {
      await ctx.stop();
    }
  });

  it('уборка проходит при каждом запуске сервера: мусор, оставшийся после сбоя, исчезает', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krafen-sweep-'));
    try {
      let ctx = await startServer({ tmpDir });
      const stage = await newStage(ctx);
      const kept = await uploadFile(stage.visitor, stage.id, png(), 'нужный.png');
      await ctx.stop({ keepFiles: true });

      // Сервер «упал», не успев убрать папку удалённой площадки
      const ghostDir = path.join(tmpDir, 'uploads', newLinkToken(12));
      fs.mkdirSync(ghostDir, { recursive: true });
      fs.writeFileSync(path.join(ghostDir, newLinkToken(12)), 'осиротевший файл');

      ctx = await startServer({ tmpDir });
      try {
        assert.equal(fs.existsSync(ghostDir), false);
        assert.equal(fs.existsSync(path.join(tmpDir, 'uploads', stage.id, kept.id)), true);
        // Сцена и файлы пережили перезапуск; вход человека — тоже (сервер поднялся на другом порту)
        const visitor = createVisitor(ctx.baseUrl);
        for (const [name, value] of stage.visitor.jar) visitor.jar.set(name, value);
        const scene = await sceneOf(visitor, stage.id);
        assert.deepEqual([scene.media.length, scene.media[0].id, scene.scene.version], [1, kept.id, 1]);
        assert.deepEqual((await visitor.get(`/media/${stage.id}/${kept.id}`)).bytes, png());
      } finally {
        await ctx.stop({ keepFiles: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('база этапа 4 достраивается при запуске: площадки и команды на месте, у каждой появляется пустая сцена', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krafen-upgrade-'));
    const dbPath = path.join(tmpDir, 'auth-test.db');
    try {
      // База в том виде, в каком её оставил этап 4: владелец, модератор и площадка
      const old = openDatabase(dbPath, { upToVersion: 3 });
      assert.equal(old.getHealth().schemaVersion, 3);
      const tableNames = () => old.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
      assert.equal(tableNames().includes('sources'), false);
      assert.equal(tableNames().includes('media_files'), false);
      const accounts = createAccounts({ db: old.raw, passwordCost: FAST });
      const streamer = await accounts.register({ username: 'old_streamer', displayName: 'Старожил', password: GOOD_PASSWORD, ip: '127.0.0.1' });
      const helper = await accounts.register({ username: 'old_helper', displayName: 'Помощник', password: GOOD_PASSWORD, ip: '127.0.0.1' });
      const userRow = (name) => old.raw.prepare('SELECT id FROM users WHERE username_key = ?').get(name).id;
      const workspaceId = newLinkToken(12);
      old.raw.prepare('INSERT INTO workspaces (public_id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(workspaceId, userRow('old_streamer'), 'Площадка старожила', Date.now(), Date.now());
      const workspaceRow = old.raw.prepare('SELECT id FROM workspaces WHERE public_id = ?').get(workspaceId).id;
      old.raw.prepare('INSERT INTO workspace_members (workspace_id, user_id, created_at) VALUES (?, ?, ?)')
        .run(workspaceRow, userRow('old_helper'), Date.now());
      old.close();

      const ctx = await startServer({ tmpDir });
      try {
        const health = (await createVisitor(ctx.baseUrl).get('/api/health')).data;
        assert.equal(health.db.schemaVersion, SCHEMA_VERSION);
        assert.equal(health.db.latestMigration, LATEST_MIGRATION);
        assert.equal(health.stage, PLATFORM_STAGE);

        // Прежние входы действуют: люди не заметили обновления
        const owner = createVisitor(ctx.baseUrl);
        owner.jar.set('ks_session', streamer.token);
        const moderator = createVisitor(ctx.baseUrl);
        moderator.jar.set('ks_session', helper.token);

        const scene = await sceneOf(owner, workspaceId);
        assert.deepEqual(scene.workspace, { id: workspaceId, name: 'Площадка старожила', role: 'owner' });
        assert.deepEqual(scene.scene, { width: 1920, height: 1080, version: 0 });
        assert.deepEqual([scene.sources, scene.media], [[], []]);
        assert.equal((await sceneOf(moderator, workspaceId)).workspace.role, 'moderator');

        // И сцена сразу рабочая — для обоих
        const text = await addSource(owner, workspaceId, 'text');
        assert.equal((await patchSource(moderator, workspaceId, text.id, { x: 1 })).status, 200);
        const file = await uploadFile(moderator, workspaceId, jpeg(), 'фото.jpg');
        assert.equal(file.uploadedBy, 'Помощник');
        assert.equal((await sceneOf(owner, workspaceId)).scene.version, 3);
        // Команда осталась прежней
        const team = (await owner.get(`/api/workspaces/${workspaceId}`)).data.members;
        assert.deepEqual(team.map((member) => [member.role, member.displayName]), [['owner', 'Старожил'], ['moderator', 'Помощник']]);
      } finally {
        await ctx.stop({ keepFiles: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/* ========================================================================== */

describe('Этап 5 — страницы, тексты и защита страницы редактора', () => {
  const publicDir = path.join(PROJECT_DIR, 'public');
  const read = (name) => fs.readFileSync(path.join(publicDir, name), 'utf8');
  const scriptsIn = (dir) =>
    fs.readdirSync(path.join(publicDir, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? scriptsIn(`${dir}/${entry.name}`) : entry.name.endsWith('.js') ? [`${dir}/${entry.name}`] : []
    );
  // Всё, что рисует сцену и редактор
  const sceneScripts = [...scriptsIn('js/scene'), ...scriptsIn('js/editor'), 'js/pages/editor.js'];

  let ctx;
  let stage;
  before(async () => {
    ctx = await startServer();
    stage = await newStage(ctx);
  });
  after(async () => { await ctx.stop(); });

  it('каждый отказ сервера о сцене и файлах имеет понятный текст на странице', async () => {
    const { describeError } = await import('../public/js/core/session.js');
    // Все отказы, которые умеет давать сервер сцены, — прямо из его кода
    const serverCodes = new Set();
    for (const file of ['scene.js', 'storage.js', 'http.js']) {
      const code = fs.readFileSync(path.join(PROJECT_DIR, 'src/server/scene', file), 'utf8');
      for (const match of code.matchAll(/'([a-z]+(?:_[a-z]+)+)'/g)) serverCodes.add(match[1]);
    }
    assert.deepEqual([...serverCodes].sort(), [
      'file_empty', 'file_required', 'file_too_large', 'file_type_not_allowed', 'files_limit', 'image_too_big', 'image_unreadable',
      'media_in_use', 'media_kind_mismatch', 'media_not_found', 'server_busy', 'server_storage_full', 'source_command_unknown',
      'source_field_invalid', 'source_geometry_invalid', 'source_locked', 'source_name_required', 'source_name_too_long',
      'source_no_commands', 'source_not_found', 'source_setting_invalid', 'source_type_unknown', 'sources_limit', 'storage_limit',
      'too_many_requests', 'upload_interrupted',
    ], 'список отказов сервера изменился — проверьте тексты на странице и документацию');
    // И те, что приходят от общих частей сервера: слишком длинная команда, устаревший вход, исчезнувшая площадка
    for (const shared of ['payload_too_large', 'unauthorized', 'workspace_not_found', 'cross_site_request']) serverCodes.add(shared);

    const fallback = describeError({ status: 400, data: { error: 'no_such_code' } });
    const numbers = { limit: 37, count: 37, retryAfterSeconds: 37, megapixels: 37, limitBytes: 37 * MB };
    const texts = new Map();
    for (const errorCode of serverCodes) {
      const text = describeError({ status: 409, data: { error: errorCode, ...numbers } });
      assert.notEqual(text, fallback, `для отказа «${errorCode}» на странице нет своего текста`);
      assert.match(text, /^[А-ЯЁ].*[.!]$/, `«${errorCode}»: ${text}`);
      assert.doesNotMatch(text, /undefined|NaN|null|\[object|[a-z]_[a-z]/, `«${errorCode}»: ${text}`);
      texts.set(errorCode, text);
    }
    assert.equal(new Set(texts.values()).size, texts.size, 'разные отказы объясняются разными словами');
    // Незнакомый или испорченный код отказа — общий текст, а не ошибка страницы
    for (const junk of ['toString', 'constructor', '__proto__', 'hasOwnProperty', '', null, undefined, 5, {}, ['unauthorized']]) {
      assert.equal(describeError({ status: 400, data: { error: junk } }), fallback, String(junk));
    }
    assert.equal(describeError({ status: 503, data: { error: 'valueOf' } }), describeError({ status: 500, data: {} }));
    for (const junk of [null, undefined, {}, { status: 400 }, { data: null }]) assert.equal(describeError(junk), fallback);

    // Число, которое прислал сервер, попадает в текст — и согласуется со словом
    for (const errorCode of ['sources_limit', 'files_limit', 'media_in_use', 'image_too_big', 'too_many_requests', 'storage_limit', 'file_too_large']) {
      assert.match(texts.get(errorCode), /37/, `«${errorCode}»: в тексте нет числа, которое прислал сервер`);
    }
    const say = (error, data) => describeError({ status: 409, data: { error, ...data } });
    assert.match(say('sources_limit', { limit: 1 }), /уже 1 источник /);
    assert.match(say('sources_limit', { limit: 100 }), /уже 100 источников /);
    assert.match(say('files_limit', { limit: 3 }), /уже 3 файла /);
    assert.match(say('files_limit', { limit: 200 }), /уже 200 файлов /);
    assert.match(say('media_in_use', { count: 1 }), /\(1 источник\)/);
    assert.match(say('media_in_use', { count: 2 }), /\(2 источника\)/);
    // Пределы размера — в привычных единицах, каким бы ни было число
    assert.match(say('file_too_large', { limitBytes: 10 * MB }), /не больше 10 МБ\./);
    assert.match(say('file_too_large', { limitBytes: 1.5 * MB }), /не больше 1,5 МБ\./);
    assert.match(say('file_too_large', { limitBytes: 4000 }), /не больше 3,9 КБ\./);
    assert.match(say('storage_limit', { limitBytes: 200 * MB }), /даётся 200 МБ\./);
    assert.match(say('image_too_big', { limit: 8192, megapixels: 40 }), /8192 точек .* 40 мегапикселей/);

    // Сами пределы сервера на странице читаются без дробей и «1024 КБ»
    const { formatBytes } = await import('../public/js/core/format.js');
    assert.deepEqual(
      [0, 999, 1024, 1536, 2000, 1023 * KB, MB - 1, MB, 10 * MB, 50 * MB, 200 * MB, 5 * 1024 * MB].map(formatBytes),
      ['0 Б', '999 Б', '1 КБ', '1,5 КБ', '2 КБ', '1023 КБ', '1 МБ', '1 МБ', '10 МБ', '50 МБ', '200 МБ', '5 ГБ']
    );
    for (const junk of [undefined, null, NaN, -5, 'много', {}]) assert.equal(formatBytes(junk), '0 Б');
  });

  it('страница редактора закрыта для гостей: ведёт на вход и после него возвращает обратно', async () => {
    const address = `/app/w/${stage.id}/editor`;
    const guest = createVisitor(ctx.baseUrl);
    const res = await guest.get(address);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(address)}`);
    assert.equal(safeNextPath(address), address);
    assert.doesNotMatch(res.text, /editor-bar|js\/pages\/editor/, 'гостю не отдаётся даже разметка редактора');

    const page = await stage.visitor.get(address);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.text, read('editor.html'));

    // Страница одна на всех: данных площадки в ней нет, доступ решают запросы сцены
    const outsider = await registerUser(ctx.baseUrl);
    assert.equal((await outsider.visitor.get(address)).text, page.text);
    assert.equal((await outsider.visitor.get(`/app/w/${newLinkToken(12)}/editor`)).text, page.text);
    assert.doesNotMatch(page.text, new RegExp(stage.id));

    // Заведомо неверные адреса — «не найдено»; напрямую как файл страница не отдаётся
    for (const wrong of [
      '/app/w/abc/editor', `/app/w/${stage.id}x/editor`, `/app/w/${stage.id.toUpperCase()}/editor`, `/app/w/${stage.id}/editor/extra`,
      `/app/w/${stage.id}/editor.html`, '/editor.html', '/editor', `/app/w/${stage.id}/scene`,
    ]) {
      assert.equal((await stage.visitor.get(wrong)).status, 404, wrong);
    }
    const signedIn = await stage.visitor.get(`/login?next=${encodeURIComponent(address)}`);
    assert.equal(signedIn.status, 302);
    assert.equal(signedIn.headers.get('location'), address);
  });

  it('в редактор ведут кабинет и страница площадки; из редактора — дорога обратно', () => {
    // Страница площадки: кнопка в разметке, адрес подставляет скрипт
    assert.match(read('workspace.html'), /<a class="btn-primary sm" id="editor-link" href="\/app">Открыть редактор<\/a>/);
    assert.match(read('js/pages/workspace.js'), /\$\('editor-link'\)\.setAttribute\('href', `\/app\/w\/\$\{encodeURIComponent\(workspaceId\)\}\/editor`\);/);
    // Кабинет: на карточке каждой площадки — редактор и команда
    const shell = read('js/pages/shell.js');
    assert.match(shell, /const address = `\/app\/w\/\$\{encodeURIComponent\(workspace\.id\)\}`;/);
    assert.match(shell, /el\('a', 'btn-primary sm', 'Редактор сцены'\);\n\s+editor\.href = `\$\{address\}\/editor`;/);
    assert.match(shell, /el\('a', 'btn-action', isOwner \? 'OBS и команда' : 'Команда'\);\n\s+teamPage\.href = address;/);
    // Редактор: ссылка «к площадке»
    assert.match(read('editor.html'), /id="back-link"/);
    assert.match(read('js/pages/editor.js'), /\$\('back-link'\)\.setAttribute\('href', `\/app\/w\/\$\{encodeURIComponent\(workspaceId\)\}`\);/);

    // Страницы больше не называют редактор «будущим» и не показывают прошлый этап
    for (const page of ['index.html', 'app.html', 'workspace.html', 'invite.html', 'editor.html']) {
      const html = read(page);
      assert.doesNotMatch(html, /этап(?:е|а)? 4|4 \/ 9|4 из 9|будущ\S* редактор|с появлением редактора|каркас\S* редактора/i, page);
    }
    // Какой этап страницы называют текущим — проверяется вместе с последним этапом (overlay.test.js)
    // Заготовки «скелета редактора» из прошлых этапов в кабинете больше нет
    assert.doesNotMatch(read('app.html'), /tab-editor|pane-editor|studio-skeleton|stage-placeholder/);
    for (const sheet of fs.readdirSync(path.join(publicDir, 'styles'))) {
      assert.doesNotMatch(read(`styles/${sheet}`), /studio-skeleton|studio-col|stage-placeholder|workspace-card-open/, sheet);
    }
  });

  it('прокруткой окна управляет только html: «прилипание» и запрет прокрутки под открытым окном работают', () => {
    /* Пока запрет прокрутки вбок стоял и у html, и у body, body был отдельной областью прокрутки —
       и молча не работали две вещи: сцена редактора и боковая панель кабинета не «прилипали»,
       а страница под открытым окном прокручивалась. Само поведение проверяется в браузере;
       здесь — что причина не вернулась. */
    const tokens = read('styles/tokens.css');
    const rule = (selector) => {
      const at = tokens.search(new RegExp(`(^|\\n)${selector} \\{`));
      assert.ok(at >= 0, `в tokens.css нет правила ${selector}`);
      return tokens.slice(at, tokens.indexOf('}', at));
    };
    assert.match(rule('html'), /overflow-x: hidden;\s+overflow-x: clip;/);
    // Место под полосу прокрутки занято всегда: страница не сдвигается вбок, когда полоса исчезает под окном
    assert.match(rule('html'), /scrollbar-gutter: stable;/);
    assert.doesNotMatch(rule('body'), /overflow/);
    assert.match(tokens, /\nhtml\.nav-open,\nhtml\.modal-open \{\n  overflow: hidden;\n\}/);
    for (const sheet of fs.readdirSync(path.join(publicDir, 'styles'))) {
      const css = read(`styles/${sheet}`);
      assert.doesNotMatch(css, /body\.(nav|modal)-open/, sheet);
      assert.doesNotMatch(css, /(^|\n|,)\s*body(\.[a-z-]+)*\s*\{[^}]*overflow/, `${sheet}: у body появилась своя прокрутка`);
    }
    // Класс ставится на html, а не на body
    const ui = read('js/core/ui.js');
    assert.equal((ui.match(/document\.documentElement\.classList\.(add|remove)\('(modal|nav)-open'\)/g) || []).length, 4);
    assert.doesNotMatch(ui, /document\.body\.classList\.\w+\('(modal|nav)-open'\)/);

    // Сцена остаётся на экране, пока под ней прокручивают слои и свойства; страница сообщает браузеру,
    // сколько места сверху занято, — чтобы поле, в которое перешли, не оказалось под сценой
    const editorCss = read('styles/editor.css');
    assert.match(editorCss, /@media \(max-width: 1180px\) and \(min-height: 540px\) \{\n  \.stage-col \{\n    position: sticky;\n    top: var\(--editor-nav\);/);
    assert.match(editorCss, /html\.stage-loose \.stage-col \{\n    position: relative;/);
    const editorPage = read('js/pages/editor.js');
    assert.match(editorPage, /root\.classList\.toggle\('stage-loose', /);
    assert.match(editorPage, /root\.style\.scrollPaddingTop = /);
  });

  it('страницам разрешено загружать только своё; вложенная рамка не может уйти на чужой сайт', async () => {
    const page = await stage.visitor.get(`/app/w/${stage.id}/editor`);
    const policy = Object.fromEntries(
      page.headers.get('content-security-policy').split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values])
    );
    assert.deepEqual(policy['default-src'], ["'self'"]);
    assert.deepEqual(policy['script-src'], ["'self'"], 'скрипты — только свои файлы: ни вставок в разметку, ни выполнения текста');
    assert.deepEqual(policy['frame-src'], ["'self'"]);
    assert.deepEqual(policy['object-src'], ["'none'"]);
    assert.deepEqual(policy['base-uri'], ["'self'"]);
    assert.deepEqual(policy['form-action'], ["'self'"]);
    assert.deepEqual(policy['font-src'], ["'self'"]);
    assert.deepEqual(policy['img-src'], ["'self'", 'data:', 'blob:']);
    assert.deepEqual(policy['media-src'], ["'self'", 'blob:']);
    assert.deepEqual(policy['connect-src'], ["'self'", 'ws:', 'wss:']);
    // Ни один раздел не открывает чужие адреса целиком
    for (const [name, values] of Object.entries(policy)) {
      for (const value of values) assert.doesNotMatch(value, /^\*$|^https?:$|unsafe-eval/, `${name}: ${value}`);
    }
    // Та же политика — у каждой страницы и у каждого ответа: её наследует рамка своего блока
    for (const url of ['/', '/app', `/app/w/${stage.id}`, '/styles/fonts.css', `/api/workspaces/${stage.id}/scene`]) {
      assert.equal((await stage.visitor.get(url)).headers.get('content-security-policy'), page.headers.get('content-security-policy'), url);
    }
  });

  it('свой блок показывается в рамке без скриптов; отдельного адреса для него на сервере нет', async () => {
    const widget = read('js/scene/sources/widget.js');
    // Рамка создаётся в одном месте, с пустой пометкой sandbox — самой строгой
    assert.equal([...widget.matchAll(/el\('iframe'/g)].length, 1);
    assert.match(widget, /frame\.setAttribute\('sandbox', ''\);/);
    assert.match(widget, /frame\.setAttribute\('referrerpolicy', 'no-referrer'\);/);
    assert.match(widget, /frame\.srcdoc = buildBlockPage\(html\);/);
    for (const script of scriptsIn('js')) {
      const code = read(script).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''); // пояснения не в счёт
      assert.doesNotMatch(code, /allow-(scripts|same-origin|forms|popups|modals|top-navigation|downloads)/, `${script}: рамке выдано разрешение`);
      if (script !== 'js/scene/sources/widget.js') {
        assert.doesNotMatch(code, /\(\s*['"`]i?frame['"`]|\.srcdoc\s*=|<iframe/i, `${script}: рамка создаётся не там, где её защита`);
      }
    }
    assert.doesNotMatch(read('editor.html'), /<iframe|<object|<embed/i);

    // Что убирается из кода блока до показа
    const block = read('js/scene/html-block.js');
    const listOf = (name) => {
      const found = block.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]+)\\]\\);`));
      assert.ok(found, `список ${name} не найден`);
      return found[1].match(/'[^']+'/g).map((item) => item.slice(1, -1));
    };
    const forbidden = listOf('FORBIDDEN');
    for (const tag of ['script', 'link', 'meta', 'base', 'iframe', 'frame', 'object', 'embed', 'template', 'noscript']) {
      assert.ok(forbidden.includes(tag), `<${tag}> должен убираться из своего блока`);
    }
    // Оформление и картинки — то, ради чего блок существует, — остаются
    for (const tag of ['style', 'img', 'svg', 'video', 'div', 'span']) assert.equal(forbidden.includes(tag), false, tag);
    assert.deepEqual(listOf('FORBIDDEN_ATTRIBUTES').sort(), ['action', 'autofocus', 'formaction', 'manifest', 'ping', 'srcdoc']);
    assert.deepEqual(listOf('LINK_HOLDERS'), ['a', 'area']);
    assert.match(block, /name\.startsWith\('on'\)/, 'обработчики событий (onclick, onerror…) убираются у любого элемента');
    assert.match(block, /SHOW_ELEMENT \| NodeFilter\.SHOW_COMMENT/);
    // Строка идёт в рамку, только если при повторном чтении в ней не нашлось запрещённого; иначе блок пуст
    assert.match(block, /\} else if \(removed === 0\) \{\n\s+return html;/);
    assert.match(block, /\n  return EMPTY_PAGE;\n\}\s*$/);
    assert.doesNotMatch(block, /\.(innerHTML|outerHTML)\s*=[^=]|insertAdjacentHTML|document\.write/);

    // Прежнего адреса «рамки виджета» нет: выполнять присланный код серверу негде
    for (const url of ['/widget-frame', '/widget-frame/', `/widget-frame?w=${stage.id}`, '/widget-frame.html', '/api/widget-frame']) {
      assert.equal((await stage.visitor.get(url)).status, 404, url);
    }
    assert.equal(fs.existsSync(path.join(PROJECT_DIR, 'src/server/scene/widget-frame.js')), false);
    for (const file of fs.readdirSync(path.join(PROJECT_DIR, 'src/server'), { recursive: true })) {
      if (!String(file).endsWith('.js')) continue;
      assert.doesNotMatch(fs.readFileSync(path.join(PROJECT_DIR, 'src/server', String(file)), 'utf8'), /allow-scripts|widget-frame/, String(file));
    }
  });

  it('шрифты платформы доступны рамке своего блока — и только шрифты', async () => {
    const guest = createVisitor(ctx.baseUrl);
    const css = await guest.get('/vendor/fonts/manrope/400.css');
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('access-control-allow-origin'), '*');
    const fontFile = css.text.match(/url\(\.\/(files\/[a-z0-9-]+\.woff2)\)/)[1];
    const font = await guest.get(`/vendor/fonts/manrope/${fontFile}`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('access-control-allow-origin'), '*');
    assert.equal(font.headers.get('set-cookie'), null);

    // Остальному чужие страницы по-прежнему не разрешены
    for (const url of ['/styles/fonts.css', '/js/scene/view.js', '/', '/api/health', '/styles/scene.css']) {
      const res = await guest.get(url, { headers: { Origin: 'null' } });
      assert.equal(res.status, 200, url);
      assert.equal(res.headers.get('access-control-allow-origin'), null, url);
    }
    // Из папки шрифтов не отдаётся ничего, кроме описаний начертаний и самих шрифтов
    for (const url of ['/vendor/fonts/manrope/package.json', '/vendor/fonts/manrope/README.md', '/vendor/fonts/', '/vendor/fonts/manrope/files/']) {
      assert.equal((await guest.get(url)).status, 404, url);
    }
  });

  it('сцена и редактор вставляют чужие данные только как текст и только в безопасные места', () => {
    assert.ok(sceneScripts.length >= 20, `скриптов сцены и редактора: ${sceneScripts.length}`);
    // Признаки элементов, которые скрипты сцены и редактора вообще выставляют
    const SAFE_ATTRIBUTES = new Set([
      'viewBox', 'aria-hidden', 'class', 'd', 'sandbox', 'referrerpolicy', 'scrolling', 'title',
      'aria-pressed', 'aria-label', 'aria-current', 'aria-labelledby', 'role', 'autocapitalize', 'href',
    ]);
    let attributes = 0;
    let addresses = 0;
    for (const script of sceneScripts) {
      const code = read(script);
      assert.doesNotMatch(code, /\.(innerHTML|outerHTML)\s*=[^=]|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, script);
      assert.doesNotMatch(code, /cssText|setAttribute\(\s*['"]style['"]|\.style\s*=[^=]/, `${script}: оформление задаётся целой строкой`);
      assert.doesNotMatch(code, /javascript:|\.setAttribute\(\s*['"]on|\bon[a-z]+\s*=\s*['"`]/, `${script}: обработчик задан текстом`);
      assert.doesNotMatch(code, /set(?:Timeout|Interval)\(\s*['"`]/, `${script}: таймеру передан текст вместо функции`);
      // Название признака — всегда постоянная строка из короткого списка, а не данные
      for (const [, name] of code.matchAll(/\.setAttribute\(\s*([^,]+),/g)) {
        attributes += 1;
        assert.match(name, /^'[A-Za-z-]+'$/, `${script}: название признака взято из данных — ${name}`);
        assert.ok(SAFE_ATTRIBUTES.has(name.slice(1, -1)), `${script}: неожиданный признак ${name}`);
      }
      // Адреса картинок и видео — только файлы этой площадки на нашем сервере
      for (const [, target] of code.matchAll(/\.src\s*=\s*([^;]+);/g)) {
        addresses += 1;
        assert.match(target, /^(store\.mediaUrl\(file\.id\)|url)$/, `${script}: адрес файла собран в обход mediaUrl — ${target}`);
      }
      for (const [, target] of code.matchAll(/\.href\s*=\s*([^;=][^;]*);/g)) assert.fail(`${script}: ссылка собрана в скрипте — ${target}`);
    }
    assert.ok(attributes >= 20 && addresses >= 4);
    assert.match(read('js/editor/store.js'), /mediaUrl: \(id\) => `\/media\/\$\{encodeURIComponent\(workspaceId\)\}\/\$\{encodeURIComponent\(id\)\}`,/);
    assert.match(read('js/scene/sources/picture.js'), /const url = source\.file \? ctx\.mediaUrl\(source\.file\) : null;/);
    assert.match(read('js/scene/sources/video.js'), /const url = source\.file \? ctx\.mediaUrl\(source\.file\) : null;/);
    assert.match(read('js/pages/editor.js'), /readVideoSize\(store\.mediaUrl\(fileId\)\)/);

    // Тексты источников, названия слоёв и файлов попадают на страницу как текст
    for (const script of ['js/scene/dom.js', 'js/editor/layers.js', 'js/editor/library.js', 'js/editor/panel.js', 'js/scene/sources/widget.js']) {
      assert.match(read(script), /textContent/, `${script}: данные должны вставляться как текст`);
    }
    // Сцена рисуется одним и тем же кодом в редакторе и — с этапа 6 — в OBS: он не знает ни о редакторе, ни о кабинете
    for (const script of scriptsIn('js/scene')) {
      assert.doesNotMatch(read(script), /from '\.\.\/(?:\.\.\/)?(editor|pages|core)\//, `${script}: общий код сцены зависит от страниц`);
    }
  });
});

/* ========================================================================== */

describe('Этап 5 — общий код сцены: один и тот же в браузере и на сервере', () => {
  it('описания семи типов согласованы: настройки по умолчанию проходят собственную проверку', () => {
    assert.deepEqual(SOURCE_LIST.map((module) => module.type), SEVEN_TYPES);
    assert.deepEqual([...FIELD_KINDS].sort(), ['bool', 'choice', 'code', 'color', 'int', 'text']);

    const titles = new Set();
    for (const module of SOURCE_LIST) {
      const where = `тип «${module.type}»`;
      assert.equal(sourceType(module.type), module);
      assert.ok(typeof module.title === 'string' && module.title.length > 0 && [...module.title].length <= 40, where);
      assert.ok(typeof module.about === 'string' && module.about.length > 0, where);
      assert.ok(typeof module.icon === 'string' && /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/.test(module.icon), `${where}: значок — только контур`);
      assert.equal(typeof module.render, 'function', where);
      titles.add(module.title);

      // Размер новой заготовки укладывается в сцену и в общие пределы
      const { width, height } = module.size;
      assert.ok(Number.isInteger(width) && width >= 8 && width <= 1920, where);
      assert.ok(Number.isInteger(height) && height >= 8 && height <= 1080, where);

      const groups = new Set(module.groups.map((group) => group.id));
      assert.equal(groups.size, module.groups.length, `${where}: группы повторяются`);
      const defaults = defaultsOf(module.fields);
      assert.deepEqual(Object.keys(defaults), Object.keys(module.fields));
      const usedGroups = new Set();
      for (const [key, field] of Object.entries(module.fields)) {
        const name = `${where}, поле «${key}»`;
        assert.ok(FIELD_KINDS.includes(field.kind), `${name}: неизвестный вид поля`);
        assert.ok(typeof field.label === 'string' && field.label.length > 0, `${name}: нет подписи для панели`);
        assert.ok(groups.has(field.group), `${name}: группы «${field.group}» нет в списке групп`);
        usedGroups.add(field.group);
        // Значение по умолчанию — допустимое и уже в аккуратном виде
        assert.deepEqual(checkValue(field, field.default), { ok: true, value: field.default }, `${name}: значение по умолчанию не проходит проверку`);
        if (field.kind === 'int') {
          assert.ok(Number.isInteger(field.min) && Number.isInteger(field.max) && field.min < field.max, name);
          assert.equal(checkValue(field, field.min - 1).ok, false, name);
          assert.equal(checkValue(field, field.max + 1).ok, false, name);
        }
        if (field.kind === 'text' || field.kind === 'code') {
          assert.ok(Number.isInteger(field.max) && field.max >= 1 && field.max <= 20_000, name);
          assert.equal(checkValue(field, 'я'.repeat(field.max)).ok, true, name);
          assert.equal(checkValue(field, 'я'.repeat(field.max + 1)).ok, false, name);
        }
        if (field.kind === 'choice') {
          assert.ok(field.options.length >= 2, name);
          assert.equal(new Set(field.options.map((option) => option.value)).size, field.options.length, `${name}: варианты повторяются`);
          for (const option of field.options) assert.ok(typeof option.label === 'string' && option.label.length > 0, name);
          assert.equal(checkValue(field, 'нет такого варианта').ok, false, name);
        }
        // «Показывать ли поле» решается по настройкам и не падает ни на каких
        assert.equal(typeof isShown(field, defaults), 'boolean', name);
      }
      assert.deepEqual([...usedGroups].sort(), [...groups].sort(), `${where}: есть группа без полей`);
      // Настройки целиком помещаются в одну команду редактора (256 КБ) с большим запасом
      const heaviest = Object.fromEntries(Object.entries(module.fields).map(([key, field]) => [
        key, field.kind === 'text' || field.kind === 'code' ? '🎬'.repeat(field.max) : field.default,
      ]));
      assert.ok(Buffer.byteLength(JSON.stringify({ settings: heaviest })) < 200 * KB, `${where}: настройки не помещаются в одну команду`);
    }
    assert.equal(titles.size, 7, 'названия типов не повторяются');
    // Файл нужен ровно трём типам, команды есть ровно у одного
    assert.deepEqual(
      SOURCE_LIST.filter((module) => module.media).map((module) => [module.type, module.media.kinds, module.media.formats]),
      [['image', ['image'], 'PNG, JPEG или WebP'], ['gif', ['gif'], 'GIF'], ['video', ['video'], 'MP4 или WebM']]
    );
    assert.deepEqual(SOURCE_LIST.filter((module) => module.commands).map((module) => module.type), ['timer']);

    // Чужое или испорченное название типа — «такого нет», а не ошибка и не чужое свойство
    for (const junk of ['', 'Text', 'text ', 'toString', 'constructor', '__proto__', 'hasOwnProperty', null, undefined, 5, {}, ['text']]) {
      assert.equal(sourceType(junk), undefined, String(junk));
    }
    // Описания нельзя испортить из другого места программы
    assert.throws(() => { SOURCE_LIST.push({}); }, TypeError);
    assert.throws(() => { FIELD_KINDS.push('html'); }, TypeError);
  });

  it('проверка значений: каждое поле принимает только свой вид данных и приводит его к аккуратному виду', () => {
    const text = { kind: 'text', max: 10 };
    assert.deepEqual(checkValue(text, 'Привет'), { ok: true, value: 'Привет' });
    assert.deepEqual(checkValue(text, 'а\nб\r\nв\tг'), { ok: true, value: 'а б в г' }, 'в однострочном поле переносы становятся пробелами');
    assert.deepEqual(checkValue(text, 'a\u0000b\u0007c\u001b[0m'), { ok: true, value: 'abc[0m' }, 'управляющие символы убираются');
    assert.deepEqual(checkValue(text, 'e\u0301'), { ok: true, value: 'é' }, 'буква с отдельным ударением считается одним знаком');
    assert.equal(checkValue(text, '👨‍👩‍👧‍👦👍🏽').ok, true, 'составные смайлики остаются целыми');
    assert.deepEqual(checkValue(text, '<b>x</b>'), { ok: true, value: '<b>x</b>' }, 'разметка — просто знаки: её обезвреживает показ, а не хранение');
    assert.equal(checkValue(text, 'я'.repeat(11)).ok, false);
    assert.equal(checkValue(text, '🎬'.repeat(10)).ok, true, 'смайлик — один знак');

    const lines = { kind: 'text', max: 50, multiline: true, lines: 3 };
    assert.deepEqual(checkValue(lines, 'раз\r\nдва\u2028три'), { ok: true, value: 'раз\nдва\nтри' });
    assert.equal(checkValue(lines, '1\n2\n3\n4').ok, false, 'строк больше, чем разрешено');

    const code = { kind: 'code', max: 30 };
    assert.deepEqual(checkValue(code, '<div>\r\n\t<b>x</b>\u0000\r\n</div>'), { ok: true, value: '<div>\n\t<b>x</b>\n</div>' }, 'код блока хранится как есть');
    assert.equal(checkValue(code, 'x'.repeat(31)).ok, false);

    const int = { kind: 'int', min: -5, max: 5 };
    assert.deepEqual(checkValue(int, 3), { ok: true, value: 3 });
    assert.deepEqual(checkValue(int, 2.6), { ok: true, value: 3 }, 'дробное округляется');
    assert.deepEqual(checkValue(int, -5.4), { ok: true, value: -5 });
    for (const junk of [6, -6, 5.5, NaN, Infinity, -Infinity, '3', null, true, [3], {}]) assert.equal(checkValue(int, junk).ok, false, String(junk));

    const bool = { kind: 'bool' };
    assert.deepEqual([checkValue(bool, true), checkValue(bool, false)], [{ ok: true, value: true }, { ok: true, value: false }]);
    for (const junk of [0, 1, 'true', '', null, undefined, []]) assert.equal(checkValue(bool, junk).ok, false, String(junk));

    const choice = { kind: 'choice', options: [{ value: 'left', label: 'Слева' }, { value: 7, label: 'Семь' }] };
    assert.deepEqual([checkValue(choice, 'left').ok, checkValue(choice, 7).ok], [true, true]);
    for (const junk of ['Left', 'right', '7', null, undefined, {}, ['left'], 'label', 'toString']) assert.equal(checkValue(choice, junk).ok, false, String(junk));

    const color = { kind: 'color' };
    assert.deepEqual(checkValue(color, '#A31313'), { ok: true, value: '#a31313' });
    for (const junk of [
      'red', '#fff', '#12345', '#1234567', '#gggggg', 'a31313', ' #a31313', '#a31313 ', '#a31313;background:url(//evil.example)',
      'rgb(0,0,0)', 'url(https://evil.example/x.png)', 'var(--x)', 'expression(alert(1))', 0xa31313, null, ['#a31313'],
    ]) {
      assert.equal(checkValue(color, junk).ok, false, `цвет ${String(junk)}`);
    }

    // Неизвестный вид поля, пустое описание — отказ, а не ошибка
    for (const field of [{ kind: 'html' }, { kind: 'toString' }, { kind: 'constructor' }, {}, null, undefined]) {
      assert.deepEqual(checkValue(field, 'x'), { ok: false });
    }
  });

  it('настройки из базы читаются терпеливо: чего нет или что испорчено — берётся по умолчанию', () => {
    const fields = sourceType('text').fields;
    const defaults = defaultsOf(fields);
    for (const junk of [null, undefined, 'строка', 42, [], true, {}]) assert.deepEqual(readSettings(fields, junk), defaults);

    const stored = { ...defaults, text: 'Сохранённый текст', color: '#00ff00', size: 10 ** 9, bold: 'да', align: 'по диагонали', leftover: 'поле прошлой версии' };
    const read = readSettings(fields, stored);
    assert.deepEqual(read, { ...defaults, text: 'Сохранённый текст', color: '#00ff00' });
    assert.equal('leftover' in read, false, 'лишнее поле не переносится');
    // Подмена «родителя» в сохранённой записи ни на что не влияет
    const polluted = readSettings(fields, JSON.parse('{"__proto__": {"text": "x", "polluted": true}, "constructor": {"prototype": {"polluted": true}}}'));
    assert.deepEqual(polluted, defaults);
    assert.equal({}.polluted, undefined);

    // Поля панели показываются по настройкам: у часов нет длительности, у отсчёта — пояса
    const timer = sourceType('timer');
    const shown = (settings) => Object.entries(timer.fields).filter(([, field]) => isShown(field, settings)).map(([key]) => key);
    const base = defaultsOf(timer.fields);
    assert.ok(shown(base).includes('duration') && !shown(base).includes('utcOffset'));
    assert.ok(shown({ ...base, mode: 'clock' }).includes('utcOffset') && !shown({ ...base, mode: 'clock' }).includes('duration'));
    assert.ok(!shown({ ...base, mode: 'stopwatch' }).includes('duration') && !shown({ ...base, mode: 'stopwatch' }).includes('endText'));
    const widget = sourceType('widget');
    const widgetShown = (kind) => Object.entries(widget.fields).filter(([, field]) => isShown(field, { ...defaultsOf(widget.fields), kind })).map(([key]) => key);
    assert.deepEqual(widgetShown('html'), ['kind', 'html']);
    assert.deepEqual(widgetShown('goal'), ['kind', 'goalTitle', 'goalCurrent', 'goalTarget', 'goalUnit', 'accent', 'fontSize']);
    assert.equal(isShown({}, {}), true);
  });

  it('часы сервера на странице: цифры таймера не зависят от часов устройства', () => {
    let local = 1_000_000; // часы устройства
    let steady = 0; // «секундомер» устройства: его перевод часов не затрагивает
    const tick = (ms) => { local += ms; steady += ms; };
    const clock = createServerClock({ localNow: () => local, steady: () => steady });

    // Пока замеров нет — время устройства
    assert.equal(clock.now(), local);

    // Часы устройства отстают от сервера на 5 с; ответ шёл туда и обратно 100 мс
    assert.equal(clock.sample(local + 5_000 - 50, 100), true);
    assert.equal(clock.now(), local + 5_000);
    tick(1_000);
    assert.equal(clock.now(), local + 5_000, 'между замерами время идёт вместе с часами устройства');

    // Менее точный замер (медленный ответ) более точного не заменяет
    assert.equal(clock.sample(local + 5_000 + 300, 2_000), false);
    assert.equal(clock.now(), local + 5_000);
    // Более точный — заменяет
    assert.equal(clock.sample(local + 5_000 + 10 - 5, 10), true);
    assert.equal(clock.now(), local + 5_010);

    // Старый замер понемногу «дешевеет»: через час его заменит и не самый быстрый ответ
    assert.equal(clock.sample(local + 5_010 - 500, 1_000), false);
    tick(HOUR);
    assert.equal(clock.sample(local + 5_100 - 500, 1_000), true);
    assert.equal(clock.now(), local + 5_100);

    // Часы устройства перевели на час назад: разница скакнула — принимается даже медленный замер
    local -= HOUR;
    assert.equal(clock.sample(local + HOUR + 5_100 - 1_500, 3_000), true);
    assert.equal(clock.now(), local + HOUR + 5_100);

    // Испорченные замеры не принимаются и ничего не меняют
    const before = clock.now();
    for (const [serverTime, trip] of [[NaN, 10], [Infinity, 10], [local, NaN], [local, -1], [undefined, 10], ['сейчас', 10], [local, Infinity], [null, null]]) {
      assert.equal(clock.sample(serverTime, trip), false);
    }
    assert.equal(clock.now(), before);

    // Самый первый замер принимается любым: хуже, чем ничего, он быть не может
    const fresh = createServerClock({ localNow: () => local, steady: () => steady });
    assert.equal(fresh.sample(local - 20_000, 9_000), true);
    assert.equal(fresh.now(), local - 20_000 + 4_500);
    // У каждой страницы часы свои
    assert.notEqual(fresh.now(), clock.now());
    // Без подмены часов модуль работает на настоящих — и в браузере, и на сервере
    const real = createServerClock();
    assert.ok(Math.abs(real.now() - Date.now()) < 50);
  });

  it('номера площадок, источников и файлов — случайные 12 знаков; подобрать соседний нельзя', async () => {
    const ctx = await startServer();
    try {
      const { visitor, id } = await newStage(ctx);
      const ids = new Set([id]);
      for (const type of SEVEN_TYPES) ids.add((await addSource(visitor, id, type)).id);
      for (let i = 0; i < 5; i += 1) ids.add((await uploadFile(visitor, id, png())).id);
      assert.equal(ids.size, 13, 'номера не повторяются');
      for (const value of ids) {
        assert.match(value, PUBLIC_ID);
        assert.equal(isLinkToken(value, 12), true);
        assert.doesNotMatch(value, /^\d+$/, 'номер — не порядковое число');
      }
      // Номера не идут подряд: по одному нельзя вычислить следующий
      const sorted = [...ids].sort();
      for (let i = 1; i < sorted.length; i += 1) {
        const common = [...sorted[i]].findIndex((char, index) => char !== sorted[i - 1][index]);
        assert.ok(common < 8, `номера ${sorted[i - 1]} и ${sorted[i]} слишком похожи`);
      }
    } finally {
      await ctx.stop();
    }
  });
});
