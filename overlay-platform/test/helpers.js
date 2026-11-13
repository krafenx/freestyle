import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import { createOverlayServer } from '../src/server/app.js';

/* Общие помощники проверок: настоящий сервер на временной базе, «посетитель»
   со своими cookie, площадка со сценой и запуск платформы отдельной программой. */

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NODE_FLAGS = ['--no-warnings=ExperimentalWarning'];

// В проверках пароль преобразуется в облегчённом режиме, иначе сотня регистраций шла бы минуту.
// Рабочие параметры проверяются отдельно, в последнем блоке.
export const FAST = { N: 1024, r: 8, p: 1 };
export const MINUTE = 60 * 1000;
export const DAY = 24 * 60 * MINUTE;
export const NO_LIMITS = Object.fromEntries(
  [
    'attemptsPerClientAndName', 'attemptsPerClient', 'attemptsPerName',
    'registrationsPerClient', 'registrationTriesPerClient', 'passwordChecksPerUser',
  ].map((name) => [name, { limit: 100000, windowMs: MINUTE }])
);

/* Что должно быть у платформы к этому этапу: сколько обновлений структуры базы применено,
   как называется последнее и какой этап сообщает сервер. Меняется раз за этап — здесь. */
export const SCHEMA_VERSION = 6;
export const LATEST_MIGRATION = '006_live_edits';
export const PLATFORM_STAGE = 7;

export const CODE_PATTERN = /^[A-HJKMNP-TV-Z2-9]{5}(?:-[A-HJKMNP-TV-Z2-9]{5}){3}$/;
export const GOOD_PASSWORD = 'длинный надёжный пароль 42';

export async function startServer(options = {}) {
  const tmpDir = options.tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'krafen-auth-test-'));
  const server = createOverlayServer({
    host: '127.0.0.1',
    port: 0,
    dbPath: path.join(tmpDir, 'auth-test.db'),
    uploadsDir: path.join(tmpDir, 'uploads'),
    passwordCost: FAST,
    authLimits: NO_LIMITS,
    ...options,
  });
  const { port } = await server.start();
  return {
    server,
    tmpDir,
    baseUrl: `http://127.0.0.1:${port}`,
    db: server.db.raw,
    async stop({ keepFiles = false } = {}) {
      // Незавершённым запросам (проверка упала посреди загрузки файла) — четверть секунды, не больше
      await server.stop({ graceMs: 250 });
      if (!keepFiles) fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/* Посетитель с собственным «браузером»: помнит cookie между запросами.
   Сервер по умолчанию верит заголовкам X-Forwarded-* только от программы на
   этой же машине — проверки как раз идут с неё, поэтому так можно изобразить
   посетителей с разных адресов и заход по https. */
export function createVisitor(baseUrl, { ip, https = false } = {}) {
  const jar = new Map();

  // body — данные, которые уйдут как JSON; raw — готовые байты (так загружаются файлы)
  async function call(method, url, { body, raw, headers = {} } = {}) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        ...(ip ? { 'X-Forwarded-For': ip } : {}),
        ...(https ? { 'X-Forwarded-Proto': 'https' } : {}),
        ...headers,
      },
      body: raw !== undefined ? raw : body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });

    const setCookies = res.headers.getSetCookie();
    for (const line of setCookies) {
      const pair = line.split(';')[0];
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (value === '' || /Max-Age=0\b/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8');
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // ответ не в формате JSON (страница или перенаправление)
    }
    return { status: res.status, data, text, bytes, headers: res.headers, setCookies };
  }

  return {
    jar,
    get: (url, options) => call('GET', url, options),
    post: (url, body = {}, options = {}) => call('POST', url, { body, ...options }),
    patch: (url, body = {}, options = {}) => call('PATCH', url, { body, ...options }),
    // Загрузка файла: тело запроса — сами байты, название файла — в заголовке
    upload: (url, bytes, { name = 'file.bin', headers = {} } = {}) =>
      call('POST', url, {
        raw: bytes,
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), ...headers },
      }),
    async isSignedIn() {
      return (await call('GET', '/api/auth/session')).data.authenticated;
    },
  };
}

let nameCounter = 0;
export const uniqueName = (prefix = 'user') => `${prefix}_${(nameCounter += 1)}`;

export async function registerUser(baseUrl, overrides = {}, visitorOptions = {}) {
  const visitor = createVisitor(baseUrl, visitorOptions);
  const username = overrides.username || uniqueName();
  const password = overrides.password || GOOD_PASSWORD;
  const res = await visitor.post('/api/auth/register', { username, password, ...overrides });
  assert.equal(res.status, 201, `регистрация ${username} не удалась: ${res.text}`);
  return { visitor, username, password, recoveryCode: res.data.recoveryCode, res };
}

/* ---------- Площадка, команда, сцена ----------
   Нужны проверкам сцены (scene.test.js) и оверлея (overlay.test.js). */

let workspaceCounter = 0;

export async function createWorkspace(visitor, name = `Сцена ${(workspaceCounter += 1)}`) {
  const res = await visitor.post('/api/workspaces', { name });
  assert.equal(res.status, 201, `площадка «${name}» не создана: ${res.text}`);
  return res.data.workspace;
}

export async function addModerator(baseUrl, owner, workspaceId, overrides = {}) {
  const person = await registerUser(baseUrl, overrides);
  const invite = await owner.post(`/api/workspaces/${workspaceId}/invites`, {});
  assert.equal(invite.status, 201, `приглашение не создано: ${invite.text}`);
  const accepted = await person.visitor.post(`/api/invites/${invite.data.token}/accept`);
  assert.equal(accepted.status, 200, `приглашение не принято: ${accepted.text}`);
  return person;
}

// Новый владелец со своей площадкой: у каждой проверки своя сцена и свой счёт команд
export async function newStage(ctx, { displayName = 'Владелец', name } = {}) {
  const owner = await registerUser(ctx.baseUrl, { displayName });
  const workspace = await createWorkspace(owner.visitor, name);
  return { owner, visitor: owner.visitor, workspace, id: workspace.id, api: `/api/workspaces/${workspace.id}/scene` };
}

export const sceneOf = async (visitor, workspaceId) => {
  const res = await visitor.get(`/api/workspaces/${workspaceId}/scene`);
  assert.equal(res.status, 200, `сцена не открылась: ${res.text}`);
  return res.data;
};

export async function addSource(visitor, workspaceId, type, props) {
  const res = await visitor.post(`/api/workspaces/${workspaceId}/scene/sources`, props === undefined ? { type } : { type, props });
  assert.equal(res.status, 201, `источник «${type}» не создан: ${res.text}`);
  return res.data.source;
}

export async function uploadFile(visitor, workspaceId, bytes, name = 'file.bin') {
  const res = await visitor.upload(`/api/workspaces/${workspaceId}/scene/media`, bytes, { name });
  assert.equal(res.status, 201, `файл «${name}» не загружен: ${res.text}`);
  return res.data.file;
}

export const patchSource = (visitor, workspaceId, sourceId, patch) =>
  visitor.patch(`/api/workspaces/${workspaceId}/scene/sources/${sourceId}`, patch);

export const refusal = (res, status, error, extra = {}) => {
  assert.equal(res.status, status, `ожидался отказ ${status} «${error}», пришло: ${res.status} ${res.text}`);
  assert.deepEqual(res.data, { ok: false, error, ...extra });
};

/* Настоящая картинка PNG. Сервер решает, что это за файл, по его содержимому, поэтому
   проверочные файлы собираются по байтам (остальные форматы — в scene.test.js). */
export function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([head, body, crc]);
}

// Настоящая картинка PNG нужного размера: прозрачный прямоугольник
export function png(width = 4, height = 3) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // глубина цвета
  header[9] = 6; // RGBA
  const pixels = zlib.deflateSync(Buffer.alloc((width * 4 + 1) * height));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', pixels),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function waitFor(check, what, timeoutMs = 4000) {
  const startedAt = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - startedAt > timeoutMs) assert.fail(`не дождались: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

// Ждать не дольше заданного: «зависло» должно быть провалом проверки, а не её вечным ожиданием
export function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Не дождались за ${ms} мс: ${what}`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/* Подключение к живому каналу связи. next() — следующее сообщение сервера,
   closed — чем закончилось соединение (код закрытия), close() — закрыть самому. */
export function openSocket(url, { headers } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const inbox = [];
    const waiters = [];
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket: нет ответа за 4 секунды'));
    }, 4000);
    const closed = new Promise((res) => {
      ws.once('close', (code) => res({ code }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else inbox.push(msg);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on('open', () => {
      clearTimeout(timer);
      resolve({
        ws,
        closed,
        inbox,
        next() {
          if (inbox.length) return Promise.resolve(inbox.shift());
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('WebSocket: сообщение не пришло')), 4000);
            waiters.push((msg) => {
              clearTimeout(t);
              res(msg);
            });
          });
        },
        close() {
          if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
          return new Promise((res) => {
            ws.once('close', res);
            ws.close();
          });
        },
      });
    });
  });
}

/* Окружение для запуска отдельной программой. Настройки платформы из окружения
   самих проверок в него не попадают, а файл .env из папки проекта не читается:
   иначе проверка могла бы открыть рабочую базу вместо временной. */
const SETTING_NAMES = [
  'HOST', 'PORT', 'DB_PATH', 'UPLOADS_DIR', 'UPLOADS_TOTAL_LIMIT_MB', 'TRUST_PROXY', 'REGISTRATION', 'SESSION_COOKIE_MODE',
];

export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of SETTING_NAMES) delete env[name];
  return { ...env, ENV_FILE: path.join(os.tmpdir(), 'krafen-no-such-env-file'), ...extra };
}

export function runNode(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...NODE_FLAGS, ...args], { cwd: PROJECT_DIR, env: childEnv(env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
