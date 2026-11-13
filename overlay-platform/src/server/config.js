import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '../..');

/* Настройки из файла .env рядом с package.json (образец — .env.example).
   Файла может не быть: тогда действуют значения по умолчанию. То, что уже
   задано в окружении при запуске, файл не перекрывает. */
export function loadEnvFile() {
  const envFile = process.env.ENV_FILE || path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
}

function resolveDataPath(envVal, defaultRelPath) {
  const raw = (envVal || '').trim();
  if (!raw) return path.resolve(PROJECT_ROOT, defaultRelPath);
  if (raw === ':memory:') return ':memory:';
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

/* Каким промежуточным серверам верить, когда они сообщают адрес посетителя.
   По умолчанию — только программе на этой же машине (Caddy или Nginx перед
   приложением). Посторонний не сможет подделать свой адрес заголовком. */
function parseTrustProxy(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return 'loopback';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/* Настройка с перечнем допустимых значений. Опечатка останавливает запуск:
   молча подставить значение по умолчанию там, где человек хотел, например,
   закрыть регистрацию, было бы хуже, чем не запуститься. */
function parseChoice(raw, allowed, fallback, name) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return fallback;
  if (!allowed.includes(value)) {
    throw new Error(`Некорректное значение ${name}: «${raw}». Допустимо: ${allowed.join(', ')}`);
  }
  return value;
}

/* Целое число в заданных границах. Как и с перечнями, опечатка останавливает запуск. */
function parseWholeNumber(raw, { min, max, fallback, name }) {
  const value = String(raw ?? '').trim();
  if (!value) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Некорректное значение ${name}: «${raw}». Нужно целое число от ${min} до ${max}`);
  }
  return number;
}

// Пустое значение (HOST= без адреса) означает то же, что отсутствие настройки
function envValue(name) {
  const value = String(process.env[name] ?? '').trim();
  return value === '' ? undefined : value;
}

export function loadConfig(overrides = {}) {
  const rawPort = overrides.port ?? envValue('PORT') ?? 3000;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Некорректный порт сервера: ${rawPort}`);
  }

  return {
    host: overrides.host ?? envValue('HOST') ?? '0.0.0.0',
    port,
    dbPath: overrides.dbPath ?? resolveDataPath(process.env.DB_PATH, 'data/overlay.db'),
    uploadsDir: overrides.uploadsDir ?? resolveDataPath(process.env.UPLOADS_DIR, 'data/uploads'),
    trustProxy: overrides.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY),
    // Кто может создавать аккаунты: open — любой посетитель, closed — никто
    registration: parseChoice(
      overrides.registration ?? process.env.REGISTRATION, ['open', 'closed'], 'open', 'REGISTRATION'
    ),
    // standard — обычная работа; embedded — предпросмотр внутри чужой страницы (см. auth/cookies.js)
    sessionCookieMode: parseChoice(
      overrides.sessionCookieMode ?? process.env.SESSION_COOKIE_MODE,
      ['standard', 'embedded'], 'standard', 'SESSION_COOKIE_MODE'
    ),
    // Сколько места на диске могут занять все загруженные файлы вместе, в мегабайтах
    uploadsTotalLimitMb: parseWholeNumber(
      overrides.uploadsTotalLimitMb ?? process.env.UPLOADS_TOTAL_LIMIT_MB,
      { min: 1, max: 1024 * 1024, fallback: 5120, name: 'UPLOADS_TOTAL_LIMIT_MB' }
    ),
    publicDir: path.resolve(PROJECT_ROOT, 'public'),
    fontsDir: path.resolve(PROJECT_ROOT, 'node_modules/@fontsource'),
  };
}
