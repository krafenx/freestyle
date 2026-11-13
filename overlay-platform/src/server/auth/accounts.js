import { inTransaction } from '../db/database.js';
import { AppError, isUniqueViolation } from '../errors.js';
import { INVISIBLE_CHARS, cleanLine, lengthOf } from '../text.js';
import { checkNewPassword, createPasswordHasher, normalizePassword } from './passwords.js';
import { clientKey, createRateLimiter } from './rate-limit.js';
import { hashRecoveryCode, newRecoveryCode, newSessionToken, safeEqualHex, sha256Hex } from './tokens.js';

/* Аккаунты и сеансы входа: регистрация, вход, выход, восстановление доступа
   и настройки аккаунта. Здесь только правила; работа с адресами страниц
   и cookie — в http.js. */

// Отказ, связанный со входом и аккаунтом (общее устройство отказов — в ../errors.js)
export class AuthError extends AppError {
  constructor(code, status = 400, extra = {}) {
    super(code, status, extra);
    this.name = 'AuthError';
  }
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export const SESSION_TTL_MS = 30 * DAY; // вход «забывается» через 30 дней без посещений
const SESSION_TOUCH_MS = 10 * MINUTE; // как часто отмечаем посещение (не при каждом запросе)

export const DEFAULT_AUTH_LIMITS = Object.freeze({
  // Неудачные попытки входа и восстановления
  attemptsPerClientAndName: { limit: 8, windowMs: 15 * MINUTE },
  attemptsPerClient: { limit: 30, windowMs: 15 * MINUTE },
  attemptsPerName: { limit: 100, windowMs: 60 * MINUTE },
  // Регистрация с одного адреса: созданные аккаунты и любые обращения
  registrationsPerClient: { limit: 5, windowMs: 60 * MINUTE },
  registrationTriesPerClient: { limit: 30, windowMs: 60 * MINUTE },
  // Неверный текущий пароль в настройках аккаунта
  passwordChecksPerUser: { limit: 8, windowMs: 15 * MINUTE },
});

const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,24}$/;

// Имена, которые можно принять за служебные или за саму платформу
const RESERVED_USERNAMES = new Set(`
admin administrator root system support help moderator owner staff official
api app www web mail login logout register signup signin recover account accounts
overlay overlays studio workspace workspaces editor null undefined anonymous guest me
`.split(/\s+/).filter(Boolean));

const DISPLAY_NAME_MAX = 40;

function cleanUserAgent(value) {
  if (typeof value !== 'string') return '';
  return value.replace(INVISIBLE_CHARS, ' ').slice(0, 200);
}

export function createAccounts({
  db,
  now = Date.now,
  passwordCost,
  limits = {},
  registration = 'open',
  sessionTtlMs = SESSION_TTL_MS,
  maxSessionsPerUser = 20,
  // Вызывается, когда чьи-то входы перестали действовать (см. sessionsEnded ниже)
  onSessionsEnded = null,
} = {}) {
  const hasher = createPasswordHasher({ cost: passwordCost });
  const limiter = createRateLimiter({ now });
  const rules = { ...DEFAULT_AUTH_LIMITS, ...limits };

  const sql = {
    userByKey: db.prepare('SELECT * FROM users WHERE username_key = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare(`
      INSERT INTO users (username, username_key, display_name, password_hash, recovery_hash,
                         created_at, updated_at, password_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    setPassword: db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?'),
    upgradePasswordHash: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    setRecovery: db.prepare('UPDATE users SET recovery_hash = ?, updated_at = ? WHERE id = ?'),
    setDisplayName: db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?'),
    listUsers: db.prepare(`
      SELECT u.username, u.display_name, u.created_at,
             (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions
      FROM users u ORDER BY u.id
    `),

    insertSession: db.prepare(`
      INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    sessionByHash: db.prepare(`
      SELECT s.id AS session_id, s.last_seen_at, s.expires_at, u.*
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    countSessions: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?'),
    sessionAlive: db.prepare('SELECT 1 AS yes FROM sessions WHERE id = ? AND expires_at > ?'),
    trimSessions: db.prepare(`
      DELETE FROM sessions
      WHERE user_id = ? AND id NOT IN (
        SELECT id FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC, id DESC LIMIT ?
      )
    `),
  };

  const transaction = (work) => inTransaction(db, work);

  /* Какие-то входы только что перестали действовать. Об этом узнаёт живой канал связи:
     открытые страницы с закрытым входом отключаются сразу. Сам выход уже состоялся,
     поэтому сбой при оповещении не должен превращать его в ошибку. */
  function sessionsEnded(count = 1) {
    if (!onSessionsEnded || !(Number(count) > 0)) return;
    try {
      onSessionsEnded();
    } catch (err) {
      console.error('[krafen-overlay] Не удалось сообщить о закрытых входах:', err);
    }
  }

  function publicUser(row) {
    return {
      username: row.username,
      displayName: row.display_name,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  function assertNotBlocked(checks) {
    const waitMs = Math.max(0, ...checks.map(([key, rule]) => limiter.retryAfterMs(key, rule)));
    if (waitMs > 0) {
      throw new AuthError('too_many_attempts', 429, { retryAfterSeconds: Math.ceil(waitMs / 1000) });
    }
  }

  function attemptKeys(scope, client, nameKey) {
    return [
      [`${scope}:${client}:${nameKey}`, rules.attemptsPerClientAndName],
      [`${scope}-client:${client}`, rules.attemptsPerClient],
      [`${scope}-name:${nameKey}`, rules.attemptsPerName],
    ];
  }

  function requirePassword(password, context, field) {
    const reason = checkNewPassword(password, context);
    if (reason) throw new AuthError(reason, 400, { field });
  }

  // Очередь на проверку паролей переполнена — просим повторить, а не копим запросы
  async function heavy(work) {
    try {
      return await work();
    } catch (err) {
      if (err?.code === 'busy') throw new AuthError('server_busy', 503, { retryAfterSeconds: 5 });
      throw err;
    }
  }

  function createSession(userId, userAgent, replaceSessionId) {
    // Прежний вход в этом же браузере закрывается до создания нового (см. visitor в http.js)
    let ended = 0;
    if (Number.isInteger(replaceSessionId)) ended += Number(sql.deleteSession.run(replaceSessionId).changes);
    const token = newSessionToken();
    const time = now();
    sql.insertSession.run(sha256Hex(token), userId, time, time, time + sessionTtlMs, cleanUserAgent(userAgent));
    ended += Number(sql.trimSessions.run(userId, userId, maxSessionsPerUser).changes);
    sessionsEnded(ended);
    return { token, maxAgeSeconds: Math.floor(sessionTtlMs / 1000) };
  }

  /* ---------- Регистрация ---------- */
  async function register({ username, displayName, password, ip, userAgent, replaceSessionId } = {}) {
    if (registration !== 'open') throw new AuthError('registration_closed', 403);

    const client = clientKey(ip);
    const triesKey = `register-try:${client}`;
    const createdKey = `register:${client}`;
    assertNotBlocked([
      [triesKey, rules.registrationTriesPerClient],
      [createdKey, rules.registrationsPerClient],
    ]);
    limiter.hit(triesKey, rules.registrationTriesPerClient);

    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
      throw new AuthError('username_invalid', 400, { field: 'username' });
    }
    const usernameKey = username.toLowerCase();
    if (RESERVED_USERNAMES.has(usernameKey)) {
      throw new AuthError('username_reserved', 400, { field: 'username' });
    }

    const shownName = cleanLine(displayName) || username;
    if (lengthOf(shownName) > DISPLAY_NAME_MAX) {
      throw new AuthError('display_name_too_long', 400, { field: 'displayName' });
    }

    requirePassword(password, { username }, 'password');

    if (sql.userByKey.get(usernameKey)) {
      throw new AuthError('username_taken', 409, { field: 'username' });
    }

    const passwordHash = await heavy(() => hasher.hash(password));
    const recoveryCode = newRecoveryCode();
    const time = now();

    let userId;
    try {
      userId = Number(
        sql.insertUser.run(
          username, usernameKey, shownName, passwordHash, hashRecoveryCode(recoveryCode), time, time, time
        ).lastInsertRowid
      );
    } catch (err) {
      // Двое одновременно заняли одно имя — второй получает обычный отказ
      if (isUniqueViolation(err)) throw new AuthError('username_taken', 409, { field: 'username' });
      throw err;
    }

    limiter.hit(createdKey, rules.registrationsPerClient);
    const session = createSession(userId, userAgent, replaceSessionId);
    return { user: publicUser(sql.userById.get(userId)), recoveryCode, ...session };
  }

  /* ---------- Вход ---------- */
  async function login({ username, password, ip, userAgent, replaceSessionId } = {}) {
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      throw new AuthError('credentials_required', 400);
    }
    const nameKey = username.trim().toLowerCase().slice(0, 64);
    const keys = attemptKeys('login', clientKey(ip), nameKey);
    assertNotBlocked(keys);

    const row = USERNAME_PATTERN.test(nameKey) ? sql.userByKey.get(nameKey) : null;
    const absurd = password.length > 1000;

    let ok = false;
    if (row && !absurd) ok = await heavy(() => hasher.verify(password, row.password_hash));
    else await heavy(() => hasher.verifyDecoy(absurd ? 'x' : password));

    if (!ok) {
      for (const [key, rule] of keys) limiter.hit(key, rule);
      // Один и тот же ответ на «нет такого имени» и «неверный пароль»
      throw new AuthError('invalid_credentials', 401);
    }

    limiter.clear(keys[0][0]);
    if (hasher.needsRehash(row.password_hash)) {
      // Параметры защиты усилили после регистрации — обновляем запись при удачном входе.
      // Если сервер в эту секунду перегружен, человека всё равно впускаем: запись обновится в другой раз.
      try {
        sql.upgradePasswordHash.run(await hasher.hash(password), row.id);
      } catch (err) {
        if (err?.code !== 'busy') throw err;
      }
    }
    const session = createSession(row.id, userAgent, replaceSessionId);
    return { user: publicUser(row), ...session };
  }

  /* ---------- Проверка сеанса при каждом обращении ---------- */
  function authenticate(token) {
    if (!token) return null;
    const row = sql.sessionByHash.get(sha256Hex(token));
    if (!row) return null;

    const time = now();
    if (row.expires_at <= time) {
      sql.deleteSession.run(row.session_id);
      sessionsEnded();
      return null;
    }

    let renewed = false;
    if (time - row.last_seen_at >= SESSION_TOUCH_MS) {
      sql.touchSession.run(time, time + sessionTtlMs, row.session_id);
      renewed = true;
    }
    return {
      user: publicUser(row),
      userId: row.id,
      sessionId: row.session_id,
      renewed,
      maxAgeSeconds: Math.floor(sessionTtlMs / 1000),
    };
  }

  function logout(sessionId) {
    sessionsEnded(sql.deleteSession.run(sessionId).changes);
  }

  function logoutEverywhere(userId) {
    const ended = Number(sql.deleteUserSessions.run(userId).changes);
    sessionsEnded(ended);
    return ended;
  }

  function countSessions(userId) {
    return sql.countSessions.get(userId, now()).n;
  }

  // Действует ли ещё этот вход. Нужно живому каналу связи: соединение открыто долго,
  // а человек за это время мог выйти или сменить пароль
  function isSessionAlive(sessionId) {
    return Number.isInteger(sessionId) && Boolean(sql.sessionAlive.get(sessionId, now()));
  }

  /* ---------- Восстановление доступа по коду ---------- */
  async function recover({ username, recoveryCode, newPassword, ip, userAgent, replaceSessionId } = {}) {
    if (typeof username !== 'string' || typeof recoveryCode !== 'string' || !username.trim() || !recoveryCode.trim()) {
      throw new AuthError('recovery_required', 400);
    }
    const nameKey = username.trim().toLowerCase().slice(0, 64);
    const keys = attemptKeys('recover', clientKey(ip), nameKey);
    assertNotBlocked(keys);

    // Пароль проверяется раньше кода: по ответу «пароль слабый» нельзя понять, подошёл ли код
    requirePassword(newPassword, { username: nameKey }, 'newPassword');

    const row = USERNAME_PATTERN.test(nameKey) ? sql.userByKey.get(nameKey) : null;
    const given = hashRecoveryCode(recoveryCode);
    const ok = Boolean(row?.recovery_hash && given && safeEqualHex(given, row.recovery_hash));
    if (!ok) {
      for (const [key, rule] of keys) limiter.hit(key, rule);
      throw new AuthError('invalid_recovery', 401);
    }
    limiter.clear(keys[0][0]);

    const passwordHash = await heavy(() => hasher.hash(newPassword));
    const freshCode = newRecoveryCode(); // использованный код больше не действует
    const time = now();
    const ended = transaction(() => {
      sql.setPassword.run(passwordHash, time, time, row.id);
      sql.setRecovery.run(hashRecoveryCode(freshCode), time, row.id);
      return sql.deleteUserSessions.run(row.id).changes; // все прежние входы закрываются
    });
    sessionsEnded(ended);
    limiter.clear(`login:${clientKey(ip)}:${nameKey}`);

    const session = createSession(row.id, userAgent, replaceSessionId);
    return { user: publicUser(sql.userById.get(row.id)), recoveryCode: freshCode, ...session };
  }

  /* ---------- Настройки аккаунта (только для вошедшего) ---------- */
  async function confirmCurrentPassword(row, currentPassword) {
    if (typeof currentPassword !== 'string' || !currentPassword) {
      throw new AuthError('current_password_required', 400, { field: 'currentPassword' });
    }
    const key = `password-check:${row.id}`;
    assertNotBlocked([[key, rules.passwordChecksPerUser]]);
    const ok = currentPassword.length <= 1000 && (await heavy(() => hasher.verify(currentPassword, row.password_hash)));
    if (!ok) {
      limiter.hit(key, rules.passwordChecksPerUser);
      throw new AuthError('wrong_password', 403, { field: 'currentPassword' });
    }
    limiter.clear(key);
  }

  function requireUser(userId) {
    const row = sql.userById.get(userId);
    if (!row) throw new AuthError('unauthorized', 401);
    return row;
  }

  async function changePassword({ userId, sessionId, currentPassword, newPassword } = {}) {
    const row = requireUser(userId);
    requirePassword(newPassword, { username: row.username }, 'newPassword');
    await confirmCurrentPassword(row, currentPassword);
    if (normalizePassword(newPassword) === normalizePassword(currentPassword)) {
      throw new AuthError('password_same', 400, { field: 'newPassword' });
    }
    const passwordHash = await heavy(() => hasher.hash(newPassword));
    const time = now();
    const endedSessions = transaction(() => {
      sql.setPassword.run(passwordHash, time, time, row.id);
      // Если пароль меняют из-за подозрения на взлом, чужие входы должны закрыться
      return Number(sql.deleteOtherSessions.run(row.id, sessionId).changes);
    });
    sessionsEnded(endedSessions);
    return { endedSessions };
  }

  async function renewRecoveryCode({ userId, currentPassword } = {}) {
    const row = requireUser(userId);
    await confirmCurrentPassword(row, currentPassword);
    const recoveryCode = newRecoveryCode();
    sql.setRecovery.run(hashRecoveryCode(recoveryCode), now(), row.id);
    return { recoveryCode };
  }

  function updateProfile({ userId, displayName } = {}) {
    const row = requireUser(userId);
    const shownName = cleanLine(displayName);
    if (!shownName) throw new AuthError('display_name_required', 400, { field: 'displayName' });
    if (lengthOf(shownName) > DISPLAY_NAME_MAX) {
      throw new AuthError('display_name_too_long', 400, { field: 'displayName' });
    }
    sql.setDisplayName.run(shownName, now(), row.id);
    return { user: publicUser(sql.userById.get(row.id)) };
  }

  /* ---------- Для владельца сервера (src/tools/account.js) ---------- */
  function listUsers() {
    return sql.listUsers.all(now()).map((row) => ({
      username: row.username,
      displayName: row.display_name,
      createdAt: new Date(row.created_at).toISOString(),
      activeSessions: row.sessions,
    }));
  }

  // Новый код восстановления без пароля: человек потерял и пароль, и прежний код
  function issueRecoveryCode(username) {
    const row = typeof username === 'string' ? sql.userByKey.get(username.trim().toLowerCase()) : null;
    if (!row) return null;
    const recoveryCode = newRecoveryCode();
    sql.setRecovery.run(hashRecoveryCode(recoveryCode), now(), row.id);
    return { username: row.username, recoveryCode };
  }

  function cleanup() {
    limiter.sweep();
    const expired = Number(sql.deleteExpired.run(now()).changes);
    sessionsEnded(expired);
    return expired;
  }

  return {
    registrationOpen: registration === 'open',
    register,
    login,
    authenticate,
    logout,
    logoutEverywhere,
    countSessions,
    isSessionAlive,
    recover,
    changePassword,
    renewRecoveryCode,
    updateProfile,
    listUsers,
    issueRecoveryCode,
    cleanup,
  };
}
