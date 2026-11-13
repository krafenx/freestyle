import { isSessionToken } from './tokens.js';

/* Cookie сеанса.

   Обычный режим (standard):
     HttpOnly      — скрипты страницы прочитать ключ не могут;
     SameSite=Lax  — чужой сайт не может действовать от имени вошедшего человека
                     и не может показать его кабинет у себя во встроенном окне;
     Secure        — добавляется, когда сайт открыт по https; тогда же cookie
                     получает имя с приставкой __Host-, и подложить её с
                     соседнего поддомена невозможно.

   Режим предпросмотра (embedded): сайт показывается внутри чужой страницы
   по https — так устроен предпросмотр в среде разработки. Браузер отдаёт туда
   cookie только с пометками SameSite=None; Secure; Partitioned. Для рабочей
   установки этот режим не нужен. */

const SECURE_NAME = '__Host-ks_session';
const PLAIN_NAME = 'ks_session';

export function parseCookies(header) {
  const jar = new Map();
  if (typeof header !== 'string' || !header) return jar;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || jar.has(name)) continue; // при повторах верим первому значению
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    jar.set(name, value);
  }
  return jar;
}

export function serializeCookie(name, value, { maxAgeSeconds, secure, sameSite = 'Lax', partitioned = false } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`];
  if (Number.isFinite(maxAgeSeconds)) {
    const seconds = Math.max(0, Math.floor(maxAgeSeconds));
    parts.push(`Max-Age=${seconds}`);
    if (seconds === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  if (secure) parts.push('Secure');
  if (partitioned) parts.push('Partitioned');
  return parts.join('; ');
}

export function createSessionCookies({ mode = 'standard' } = {}) {
  const embedded = mode === 'embedded';

  const isSecure = (req) => embedded || Boolean(req.secure);

  function attributes(req, maxAgeSeconds) {
    const secure = isSecure(req);
    return {
      name: secure ? SECURE_NAME : PLAIN_NAME,
      options: {
        maxAgeSeconds,
        secure,
        sameSite: embedded ? 'None' : 'Lax',
        partitioned: embedded,
      },
    };
  }

  return {
    /* Ключ сеанса из запроса. По https принимается только защищённое имя:
       обычное могло быть подложено с соседнего адреса. */
    read(req) {
      const jar = parseCookies(req.headers.cookie);
      const value = jar.get(SECURE_NAME) ?? (isSecure(req) ? undefined : jar.get(PLAIN_NAME));
      return isSessionToken(value) ? value : null;
    },

    issue(req, res, token, maxAgeSeconds) {
      const { name, options } = attributes(req, maxAgeSeconds);
      res.append('Set-Cookie', serializeCookie(name, token, options));
    },

    clear(req, res) {
      const { name, options } = attributes(req, 0);
      res.append('Set-Cookie', serializeCookie(name, '', options));
    },
  };
}
