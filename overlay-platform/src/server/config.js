import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '../..');

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

export function loadConfig(overrides = {}) {
  const port = Number(overrides.port ?? process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Некорректный порт сервера: ${overrides.port ?? process.env.PORT}`);
  }

  return {
    host: overrides.host ?? process.env.HOST ?? '0.0.0.0',
    port,
    dbPath: overrides.dbPath ?? resolveDataPath(process.env.DB_PATH, 'data/overlay.db'),
    uploadsDir: overrides.uploadsDir ?? resolveDataPath(process.env.UPLOADS_DIR, 'data/uploads'),
    trustProxy: overrides.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY),
    publicDir: path.resolve(PROJECT_ROOT, 'public'),
    fontsDir: path.resolve(PROJECT_ROOT, 'node_modules/@fontsource'),
  };
}
