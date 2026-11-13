import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createAccounts } from './auth/accounts.js';
import { createSessionCookies } from './auth/cookies.js';
import { createAuthHttp, crossSiteGuard } from './auth/http.js';
import { isLinkToken } from './auth/tokens.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { createSceneHttp } from './scene/http.js';
import { createScene } from './scene/scene.js';
import { createMediaStorage } from './scene/storage.js';
import { createWorkspacesHttp } from './workspaces/http.js';
import { PUBLIC_ID_LENGTH, createWorkspaces } from './workspaces/workspaces.js';
import { createRealtimeHub } from './ws/hub.js';

/* Что страницам разрешено загружать: только собственные файлы платформы.
   Чужой скрипт, даже если его каким-то образом подсунут на страницу, браузер
   выполнять не станет. Запрета на показ во встроенном окне намеренно нет —
   оверлей открывается внутри OBS, а предпросмотр — внутри рамки.
   Свой блок виджета показывается во вложенной рамке без скриптов и наследует эту же
   политику: с чужих адресов он не загрузит ничего. frame-src 'self' не даёт вложенной
   рамке уйти на посторонний сайт. Подробно — в public/js/scene/html-block.js. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// Из папки шрифтов наружу отдаются только описания начертаний и сами файлы шрифтов
const FONT_ASSET_PATTERN = /^\/[a-z0-9-]+\/(?:\d{3}(?:-italic)?\.css|files\/[a-z0-9-]+\.woff2?)$/;

export function createOverlayServer(overrides = {}) {
  const config = loadConfig(overrides);
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const db = openDatabase(config.dbPath);
  const app = express();
  const httpServer = http.createServer(app);

  // Аккаунты. Часы, стоимость проверки пароля и пороги попыток подменяются только в проверках
  const accounts = createAccounts({
    db: db.raw,
    registration: config.registration,
    now: overrides.now,
    passwordCost: overrides.passwordCost,
    limits: overrides.authLimits,
    sessionTtlMs: overrides.sessionTtlMs,
    // Вход закончился — страницы площадок с этим входом отключаются от живого канала сразу
    onSessionsEnded: () => realtime.recheck(),
  });
  const authHttp = createAuthHttp({
    accounts,
    cookies: createSessionCookies({ mode: config.sessionCookieMode }),
  });

  // Площадки, модераторы и приглашения. О каждом изменении узнают открытые страницы площадки
  const workspaces = createWorkspaces({
    db: db.raw,
    now: overrides.now,
    limits: overrides.workspaceLimits,
    onChange: (event) => realtime.announceWorkspace(event),
    // Вместе с площадкой с диска уходят её файлы
    onRemoved: (workspaceId) => scene.forgetWorkspace(workspaceId),
  });

  /* Сцена: источники и загруженные файлы. Со сценой работают владелец и модераторы;
     кто есть кто, сцена спрашивает у площадок — своей проверки прав у неё нет. */
  const scene = createScene({
    db: db.raw,
    workspaces,
    storage: createMediaStorage({ dir: config.uploadsDir, now: overrides.now }),
    now: overrides.now,
    limits: { storageBytesTotal: config.uploadsTotalLimitMb * 1024 * 1024, ...overrides.sceneLimits },
    onChange: (event) => realtime.announceWorkspace(event),
  });

  /* Живой канал связи. В канал площадки попадает только тот, у кого действует вход
     и кто прямо сейчас её владелец или модератор; это же проверяется перед каждой
     отправкой сообщения. */
  const realtime = createRealtimeHub(httpServer, {
    now: overrides.now,
    guard: ({ workspaceId, userId, sessionId }) =>
      (accounts.isSessionAlive(sessionId) ? workspaces.roleOf({ userId, workspaceId }) : null),
  });

  const workspacesHttp = createWorkspacesHttp({ workspaces, realtime, auth: authHttp.api });
  const sceneHttp = createSceneHttp({ scene, auth: authHttp.api });

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    next();
  });

  // Команды с чужих сайтов отклоняются для всех адресов /api разом — и для будущих тоже
  app.use('/api', crossSiteGuard);

  // Вход, регистрация и настройки аккаунта
  app.use('/api/auth', authHttp.authRouter);
  app.use('/api/account', authHttp.accountRouter);

  // Сцена площадки. Стоит раньше адресов самой площадки: у команд редактора свой,
  // больший предел длины, а загрузка файла — вообще не JSON
  app.use('/api/workspaces/:id/scene', sceneHttp.sceneRouter);

  // Площадки и приглашения
  app.use('/api/workspaces', workspacesHttp.workspacesRouter);
  app.use('/api/invites', workspacesHttp.invitesRouter);

  app.use(express.json({ limit: '1mb' }));

  // Шрифты лежат на нашем же сервере: страницы и оверлей в OBS не зависят от чужих сайтов
  app.use(
    '/vendor/fonts',
    (req, res, next) => {
      if (!FONT_ASSET_PATTERN.test(req.path)) {
        res.status(404).type('text/plain').send('Not found');
        return;
      }
      next();
    },
    express.static(config.fontsDir, {
      maxAge: '7d',
      index: false,
      fallthrough: false,
      /* Шрифты — общедоступные файлы. Разрешение нужно своему блоку виджета: его рамка
         для браузера — посторонний сайт, а шрифт «постороннему» без разрешения не отдают. */
      setHeaders: (res) => res.setHeader('Access-Control-Allow-Origin', '*'),
    })
  );

  // Проверка состояния: сервер, база данных и живой канал связи
  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      service: 'krafen-overlay-platform',
      stage: 5,
      serverTime: new Date().toISOString(),
      db: db.getHealth(),
      realtime: realtime.getStats(),
    });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ ok: false, error: 'not_found' });
  });

  // Загруженные файлы: только участникам площадки и только как данные (см. scene/http.js)
  app.use('/media', sceneHttp.mediaRouter);

  // Файлы интерфейса. no-cache = браузер каждый раз сверяется с сервером
  // и после обновления платформы не показывает устаревшую страницу.
  const pageOptions = { headers: { 'Cache-Control': 'no-cache' } };
  // Страницы, связанные со входом, браузер не запоминает вовсе: после выхода
  // кнопка «Назад» не должна показывать сохранённую копию кабинета.
  const privatePageOptions = { headers: { 'Cache-Control': 'no-store' } };
  const page = (file, options = pageOptions) => (_req, res) => {
    res.sendFile(path.join(config.publicDir, file), options);
  };

  const serveStatic = express.static(config.publicDir, {
    extensions: false,
    index: false,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  });

  // Страницы отдаются только по своим адресам ниже (там же проверяется вход).
  // Напрямую как файл — /app.html — страницу получить нельзя.
  app.use((req, res, next) => {
    let pathname = req.path;
    try {
      pathname = decodeURIComponent(req.path);
    } catch {
      // некорректный адрес разберёт следующий обработчик
    }
    if (/\.html?$/i.test(pathname)) return next();
    return serveStatic(req, res, next);
  });

  app.get('/', page('index.html'));

  // Кабинет — только после входа
  app.get('/app', authHttp.pageSession, authHttp.requireLoginPage, page('app.html', privatePageOptions));

  /* Страница площадки — тоже только после входа. Сама страница одинакова для всех:
     есть ли у человека доступ к этой площадке, решает запрос её данных
     (/api/workspaces/:id). Здесь отсекаются только заведомо неверные адреса. */
  const workspaceAddress = (req, _res, next) => next(isLinkToken(req.params.id, PUBLIC_ID_LENGTH) ? undefined : 'route');
  app.get(
    '/app/w/:id',
    workspaceAddress,
    authHttp.pageSession,
    authHttp.requireLoginPage,
    page('workspace.html', privatePageOptions)
  );

  // Редактор сцены — по тем же правилам: страница одна на всех, данные и права — в запросах
  app.get(
    '/app/w/:id/editor',
    workspaceAddress,
    authHttp.pageSession,
    authHttp.requireLoginPage,
    page('editor.html', privatePageOptions)
  );

  /* Ссылка-приглашение открывается и гостю: он должен увидеть, куда его зовут,
     до того как входить. Сама ссылка — секрет, поэтому браузеру запрещено
     сообщать её адрес другим страницам. */
  app.get('/invite/:token', (_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  }, page('invite.html', privatePageOptions));

  // Вход, регистрация и восстановление — только для тех, кто ещё не вошёл
  for (const name of ['login', 'register', 'recover']) {
    app.get(`/${name}`, authHttp.pageSession, authHttp.guestOnlyPage, page(`${name}.html`, privatePageOptions));
  }

  // Всё остальное — «не найдено»: человеку страница, программам короткий ответ
  app.use((req, res) => {
    const wantsPage = String(req.headers.accept || '').includes('text/html');
    if (wantsPage && (req.method === 'GET' || req.method === 'HEAD')) {
      res.status(404).sendFile(path.join(config.publicDir, '404.html'), pageOptions);
      return;
    }
    res.status(404).type('text/plain').send('Not found');
  });

  // Ошибки: наружу уходит только короткий код, подробности остаются в журнале сервера
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = Number(err?.status || err?.statusCode) || 500;
    if (status >= 500) {
      console.error('[krafen-overlay] Ошибка при обработке запроса:', err);
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    const code =
      err?.type === 'entity.parse.failed' ? 'invalid_json'
      : err?.type === 'entity.too.large' ? 'payload_too_large'
      : status === 404 ? 'not_found'
      : status >= 500 ? 'server_error'
      : 'bad_request';
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    if (req.path.startsWith('/api')) {
      res.status(safeStatus).json({ ok: false, error: code });
    } else {
      res.status(safeStatus).type('text/plain').send(safeStatus === 404 ? 'Not found' : 'Error');
    }
  });

  // Раз в час убираем истёкшие сеансы входа, просроченные приглашения и файлы,
  // о которых база не знает (недокачанные, оставшиеся от удалённых площадок)
  let cleanupTimer = null;

  function cleanup() {
    accounts.cleanup();
    workspaces.cleanup();
    scene.cleanup();
  }

  async function start() {
    cleanup();
    cleanupTimer = setInterval(() => {
      try {
        cleanup();
      } catch (err) {
        console.error('[krafen-overlay] Не удалось убрать устаревшие записи:', err);
      }
    }, 60 * 60 * 1000);
    cleanupTimer.unref?.();

    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(config.port, config.host, () => {
        httpServer.off('error', reject);
        resolve();
      });
    });
    const addr = httpServer.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : config.port;
    return { host: config.host, port: actualPort };
  }

  async function stop() {
    clearInterval(cleanupTimer);
    await realtime.close();
    await new Promise((resolve) => {
      if (!httpServer.listening) return resolve();
      httpServer.close(() => resolve());
      // Не ждём, пока браузеры сами закроют «спящие» соединения
      httpServer.closeIdleConnections?.();
    });
    db.close();
  }

  return {
    app,
    httpServer,
    config,
    db,
    realtime,
    accounts,
    workspaces,
    scene,
    start,
    stop,
  };
}
