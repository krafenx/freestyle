import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createOverlayServer } from '../src/server/app.js';

/* Общие помощники проверок: настоящий сервер на временной базе, «посетитель»
   со своими cookie и запуск платформы отдельной программой. */

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
      await server.stop();
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

  async function call(method, url, { body, headers = {} } = {}) {
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
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });

    const setCookies = res.headers.getSetCookie();
    for (const line of setCookies) {
      const pair = line.split(';')[0];
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (value === '' || /Max-Age=0\b/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }

    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // ответ не в формате JSON (страница или перенаправление)
    }
    return { status: res.status, data, text, headers: res.headers, setCookies };
  }

  return {
    jar,
    get: (url, options) => call('GET', url, options),
    post: (url, body = {}, options = {}) => call('POST', url, { body, ...options }),
    patch: (url, body = {}, options = {}) => call('PATCH', url, { body, ...options }),
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
const SETTING_NAMES = ['HOST', 'PORT', 'DB_PATH', 'UPLOADS_DIR', 'TRUST_PROXY', 'REGISTRATION', 'SESSION_COOKIE_MODE'];

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
