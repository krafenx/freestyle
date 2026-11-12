import express from 'express';
import { AuthError } from './accounts.js';

/* Вход и аккаунт со стороны адресов: что отвечает сервер на /api/auth/*,
   /api/account/* и как он охраняет личные страницы. */

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_PAGES = /^\/(?:login|register|recover)(?:\/|$)/;

/* Куда вернуть человека после входа. Принимается только путь внутри этого
   же сайта: ссылка вида /login?next=https://чужой-сайт не должна уводить
   на постороннюю страницу. */
export function safeNextPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  let url;
  try {
    url = new URL(value, 'http://site.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'http://site.invalid') return null;
  if (AUTH_PAGES.test(url.pathname)) return null; // иначе после входа снова попадём на вход
  return `${url.pathname}${url.search}${url.hash}`;
}

function firstValue(header) {
  return String(header || '').split(',')[0].trim().toLowerCase();
}

/* Защита от запросов с чужих сайтов. Страница постороннего сайта не должна
   суметь отправить команду от имени вошедшего человека.

   Браузер сам сообщает, откуда пришёл запрос: заголовком Sec-Fetch-Site,
   а более старые — заголовком Origin. Подделать их скрипт страницы не может.
   Программы без браузера (проверки, утилиты) этих заголовков не шлют —
   но у них нет и чужих cookie, так что для них проверка не нужна. */
export function crossSiteGuard(req, res, next) {
  if (!UNSAFE_METHODS.has(req.method)) return next();

  const fetchSite = firstValue(req.headers['sec-fetch-site']);
  if (fetchSite) {
    if (fetchSite === 'same-origin') return next();
    return res.status(403).json({ ok: false, error: 'cross_site_request' });
  }

  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      originHost = '';
    }
    // За промежуточным сервером исходный адрес сайта может прийти в X-Forwarded-Host
    const ownHosts = [firstValue(req.headers.host), firstValue(req.headers['x-forwarded-host'])].filter(Boolean);
    if (!originHost || !ownHosts.includes(originHost)) {
      return res.status(403).json({ ok: false, error: 'cross_site_request' });
    }
  }
  return next();
}

/* Команды принимаются только в формате JSON. Обычная форма на чужом сайте
   такой запрос отправить не может — это ещё один слой той же защиты. */
function requireJson(req, res, next) {
  if (!UNSAFE_METHODS.has(req.method) || req.is('application/json')) return next();
  return res.status(415).json({ ok: false, error: 'json_required' });
}

function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const fields = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

export function createAuthHttp({ accounts, cookies }) {
  /* Узнаём человека по cookie. Если ключ устарел или отозван — стираем его
     в браузере, чтобы он не отправлялся впустую. */
  function loadSession(req, res, next) {
    const token = cookies.read(req);
    const auth = token ? accounts.authenticate(token) : null;
    if (auth?.renewed) cookies.issue(req, res, token, auth.maxAgeSeconds);
    if (token && !auth) cookies.clear(req, res);
    req.auth = auth;
    next();
  }

  function requireAuth(req, res, next) {
    if (req.auth) return next();
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  function reply(err, _req, res, next) {
    if (!(err instanceof AuthError)) return next(err);
    if (err.extra?.retryAfterSeconds) res.setHeader('Retry-After', String(err.extra.retryAfterSeconds));
    return res.status(err.status).json({ ok: false, error: err.code, ...err.extra });
  }

  /* Кто пришёл. Если в этом браузере уже есть действующий вход, новый его заменяет:
     браузер прежний ключ забудет, поэтому и на сервере прежний сеанс закрывается —
     иначе запись ещё месяц висела бы в списке «активных входов». */
  const visitor = (req) => ({
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    replaceSessionId: req.auth?.sessionId,
  });
  const common = [noStore, requireJson, express.json({ limit: '16kb' }), loadSession];

  /* ---------- /api/auth ---------- */
  const authRouter = express.Router();
  authRouter.use(common);

  authRouter.get('/session', (req, res) => {
    if (!req.auth) {
      res.json({ ok: true, authenticated: false, registrationOpen: accounts.registrationOpen });
      return;
    }
    res.json({
      ok: true,
      authenticated: true,
      registrationOpen: accounts.registrationOpen,
      user: req.auth.user,
      activeSessions: accounts.countSessions(req.auth.userId),
    });
  });

  authRouter.post('/register', handle(async (req, res) => {
    const { username, displayName, password } = fields(req);
    const result = await accounts.register({ username, displayName, password, ...visitor(req) });
    cookies.issue(req, res, result.token, result.maxAgeSeconds);
    res.status(201).json({ ok: true, user: result.user, recoveryCode: result.recoveryCode });
  }));

  authRouter.post('/login', handle(async (req, res) => {
    const { username, password } = fields(req);
    const result = await accounts.login({ username, password, ...visitor(req) });
    cookies.issue(req, res, result.token, result.maxAgeSeconds);
    res.json({ ok: true, user: result.user });
  }));

  authRouter.post('/recover', handle(async (req, res) => {
    const { username, recoveryCode, newPassword } = fields(req);
    const result = await accounts.recover({ username, recoveryCode, newPassword, ...visitor(req) });
    cookies.issue(req, res, result.token, result.maxAgeSeconds);
    res.json({ ok: true, user: result.user, recoveryCode: result.recoveryCode });
  }));

  // Выход срабатывает и без действующего сеанса: повторное нажатие не должно давать ошибку
  authRouter.post('/logout', (req, res) => {
    if (req.auth) accounts.logout(req.auth.sessionId);
    cookies.clear(req, res);
    res.json({ ok: true });
  });

  authRouter.post('/logout-all', requireAuth, (req, res) => {
    const ended = accounts.logoutEverywhere(req.auth.userId);
    cookies.clear(req, res);
    res.json({ ok: true, endedSessions: ended });
  });

  authRouter.use(reply);

  /* ---------- /api/account (только для вошедших) ---------- */
  const accountRouter = express.Router();
  accountRouter.use(common, requireAuth);

  accountRouter.patch('/profile', (req, res) => {
    res.json({ ok: true, ...accounts.updateProfile({ userId: req.auth.userId, displayName: fields(req).displayName }) });
  });

  accountRouter.post('/password', handle(async (req, res) => {
    const { currentPassword, newPassword } = fields(req);
    const result = await accounts.changePassword({
      userId: req.auth.userId,
      sessionId: req.auth.sessionId,
      currentPassword,
      newPassword,
    });
    res.json({ ok: true, ...result });
  }));

  accountRouter.post('/recovery-code', handle(async (req, res) => {
    const result = await accounts.renewRecoveryCode({
      userId: req.auth.userId,
      currentPassword: fields(req).currentPassword,
    });
    res.json({ ok: true, ...result });
  }));

  accountRouter.use(reply);

  /* ---------- Страницы ---------- */
  // Личная страница: без входа человек попадает на форму входа и после неё возвращается обратно
  function requireLoginPage(req, res, next) {
    if (req.auth) return next();
    return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  }

  // Страницы входа и регистрации уже вошедшему не нужны
  function guestOnlyPage(req, res, next) {
    if (!req.auth) return next();
    return res.redirect(302, safeNextPath(req.query.next) || '/app');
  }

  return {
    authRouter,
    accountRouter,
    pageSession: [noStore, loadSession],
    requireLoginPage,
    guestOnlyPage,
  };
}
