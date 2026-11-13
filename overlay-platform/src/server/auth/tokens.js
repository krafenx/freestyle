import crypto from 'node:crypto';

/* Случайные значения для входа и восстановления доступа.

   Ключ сеанса — длинная случайная строка, которая лежит в cookie браузера.
   В базе хранится только её отпечаток (SHA-256): даже прочитав базу,
   чужим сеансом воспользоваться нельзя. Для случайных значений такой длины
   быстрый отпечаток надёжен — медленный нужен только для паролей. */

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url'); // 43 символа, 256 бит
}

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isSessionToken(value) {
  return typeof value === 'string' && SESSION_TOKEN_PATTERN.test(value);
}

/* Случайная строка для адресов и ссылок: номер площадки, ссылка-приглашение,
   ссылка оверлея. Только цифры и строчные латинские буквы без похожих знаков
   (нет i, l, o, u): такую ссылку не портят мессенджеры, которые принимают
   подчёркивания и дефисы за разметку, и её можно продиктовать вслух.
   В алфавите 32 знака — ровно 5 бит на знак, без перекоса. */
const LINK_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const LINK_TOKEN_PATTERN = /^[0-9a-hjkmnp-tv-z]+$/;

export function newLinkToken(length) {
  let out = '';
  for (const byte of crypto.randomBytes(length)) out += LINK_ALPHABET[byte & 31];
  return out;
}

export function isLinkToken(value, length) {
  return typeof value === 'string' && value.length === length && LINK_TOKEN_PATTERN.test(value);
}

/* Код восстановления: 20 символов группами по пять, без похожих друг на
   друга знаков (нет 0 и O, 1, I и L, U) — его придётся переписывать руками. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const RECOVERY_LENGTH = 20;
const RECOVERY_GROUP = 5;

export function newRecoveryCode() {
  let raw = '';
  for (let i = 0; i < RECOVERY_LENGTH; i += 1) {
    raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  }
  return raw.match(new RegExp(`.{${RECOVERY_GROUP}}`, 'g')).join('-');
}

/* Приводит введённый код к одному виду: регистр, пробелы и дефисы не важны.
   Если это заведомо не код — возвращает пустую строку. */
export function normalizeRecoveryCode(input) {
  if (typeof input !== 'string' || input.length > 80) return '';
  const raw = input.toUpperCase().replace(/[\s\-_.]+/g, '');
  if (raw.length !== RECOVERY_LENGTH) return '';
  for (const ch of raw) {
    if (!RECOVERY_ALPHABET.includes(ch)) return '';
  }
  return raw;
}

export function hashRecoveryCode(code) {
  const normalized = normalizeRecoveryCode(code);
  return normalized ? sha256Hex(`recovery:${normalized}`) : '';
}

// Сравнение без утечки по времени: длительность не зависит от того, где различие
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || a.length !== b.length) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}
