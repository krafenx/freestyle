import crypto from 'node:crypto';

/* Пароли в базе не хранятся. Хранится только результат медленного
   одностороннего преобразования (scrypt) со случайной добавкой («солью»):
   по нему можно проверить введённый пароль, но нельзя восстановить исходный.

   Строка в базе: scrypt$N$r$p$соль$результат — параметры лежат рядом,
   поэтому их можно усилить позже, не ломая вход старым пользователям. */

// Настройка из рекомендаций OWASP: 32 МБ памяти и около 0,2 с на одну проверку
export const DEFAULT_PASSWORD_COST = Object.freeze({ N: 32768, r: 8, p: 3 });

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function scrypt(password, salt, keyLength, { N, r, p }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, { N, r, p, maxmem: 256 * N * r }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/* Одинаково набранный пароль должен совпасть на любом устройстве, даже если
   клавиатуры кодируют «й» или «ё» по-разному. */
export function normalizePassword(password) {
  return String(password).normalize('NFKC');
}

function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // Границы защищают от испорченной записи, которая заставила бы сервер считать часами
  if (!Number.isInteger(N) || N < 1024 || N > 1048576 || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 16) return null;
  if (!Number.isInteger(p) || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length < 8 || key.length < 16 || key.length > 64) return null;
  return { N, r, p, salt, key };
}

/* Очередь к «тяжёлому» вычислению. Одновременно считаются не больше двух
   паролей: иначе поток запросов на вход занял бы всю память и остановил бы
   раздачу страниц. Остальные ждут; если ждущих слишком много — отказ. */
function createGate(maxConcurrent, maxQueue) {
  let active = 0;
  const waiting = [];
  return async function run(task) {
    if (active >= maxConcurrent) {
      if (waiting.length >= maxQueue) {
        throw Object.assign(new Error('Слишком много одновременных проверок пароля'), { code: 'busy' });
      }
      await new Promise((resolve) => waiting.push(resolve)); // место передаётся напрямую от закончившего
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

export function createPasswordHasher({ cost = DEFAULT_PASSWORD_COST, maxConcurrent = 2, maxQueue = 24 } = {}) {
  const gate = createGate(maxConcurrent, maxQueue);
  let decoyPromise = null;

  async function hash(password) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = await gate(() => scrypt(normalizePassword(password), salt, KEY_LENGTH, cost));
    return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }

  async function verify(password, stored) {
    const parsed = parseHash(stored);
    if (!parsed) return false;
    const key = await gate(() => scrypt(normalizePassword(password), parsed.salt, parsed.key.length, parsed));
    return crypto.timingSafeEqual(key, parsed.key);
  }

  /* Проверка «вхолостую» для несуществующего аккаунта. Занимает столько же
     времени, сколько настоящая, поэтому по скорости ответа нельзя узнать,
     зарегистрировано ли такое имя. */
  async function verifyDecoy(password) {
    decoyPromise ??= hash(crypto.randomBytes(24).toString('base64url'));
    let decoy;
    try {
      decoy = await decoyPromise;
    } catch (err) {
      // Заготовку не удалось подготовить (очередь была переполнена) — в следующий раз готовим заново.
      // Иначе один всплеск нагрузки навсегда сломал бы ответ для несуществующих имён.
      decoyPromise = null;
      throw err;
    }
    await verify(password, decoy);
    return false;
  }

  function needsRehash(stored) {
    const parsed = parseHash(stored);
    return !parsed || parsed.N !== cost.N || parsed.r !== cost.r || parsed.p !== cost.p;
  }

  return { hash, verify, verifyDecoy, needsRehash };
}

/* Самые ходовые пароли. Их перебирают первыми, поэтому они запрещены,
   даже если подходят по длине. Сравнение — без учёта регистра. */
const COMMON_PASSWORDS = new Set(`
password password1 password12 password123 passw0rd p@ssw0rd p@ssword passwordpassword
12345678 123456789 1234567890 0123456789 12345678910 87654321 987654321 9876543210
12121212 11223344 1122334455 12341234 123123123 123321123 1234554321 123454321 147258369
qwertyui qwertyuiop qwerty123 qwerty1234 qwerty12345 qwertyqwerty 1qaz2wsx 1qaz2wsx3edc
qazwsxedc qazwsx123 zaq12wsx 1q2w3e4r 1q2w3e4r5t q1w2e3r4 q1w2e3r4t5 asdfghjk asdfghjkl
asdf1234 zxcvbnm1 zxcvbnm123 1234qwer qwer1234 123qweasd qweasdzxc qweasd123
abc12345 abcd1234 abc123456 a1b2c3d4 aa123456 a12345678 123456789a 12345678a 123456aa
iloveyou iloveyou1 sunshine princess football baseball superman starwars trustno1
welcome1 welcome123 letmein1 letmein123 admin123 admin1234 administrator changeme
master123 dragon123 monkey123 shadow123 michael1 jennifer computer internet samsung1
google123 twitch123 stream123 streamer streamer1 obs12345 overlay1 overlay123
йцукенгш йцукен123 пароль123 парольпароль любовь123 привет123
`.split(/\s+/).filter(Boolean));

function isOneRepeatedSymbol(chars) {
  return chars.every((ch) => ch === chars[0]);
}

// «23456789», «hgfedcba» и подобные цепочки подряд идущих символов
function isPlainSequence(chars) {
  const codes = chars.map((ch) => ch.codePointAt(0));
  const step = codes[1] - codes[0];
  if (step !== 1 && step !== -1) return false;
  return codes.every((code, i) => i === 0 || code - codes[i - 1] === step);
}

/* Возвращает код причины, по которой пароль не подходит, или null. */
export function checkNewPassword(password, { username = '' } = {}) {
  if (typeof password !== 'string') return 'password_required';
  const normalized = normalizePassword(password);
  const chars = [...normalized];
  if (chars.length === 0) return 'password_required';
  if (chars.length < PASSWORD_MIN_LENGTH) return 'password_too_short';
  if (chars.length > PASSWORD_MAX_LENGTH) return 'password_too_long';

  const lower = normalized.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || isOneRepeatedSymbol(chars) || isPlainSequence(chars)) {
    return 'password_too_common';
  }

  // Имя пользователя с парой цифр в начале или в конце — тоже первое, что пробуют
  const name = String(username || '').toLowerCase();
  if (name && lower.replace(/^\d+|\d+$/g, '') === name) return 'password_like_username';

  return null;
}
