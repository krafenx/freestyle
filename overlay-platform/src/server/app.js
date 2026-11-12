import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { createRealtimeHub } from './ws/hub.js';

/* Что страницам разрешено загружать: только собственные файлы платформы.
   Чужой скрипт, даже если его каким-то образом подсунут на страницу, браузер
   выполнять не станет. Запрета на показ во встроенном окне намеренно нет —
   оверлей открывается внутри OBS, а предпросмотр — внутри рамки. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
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
  const realtime = createRealtimeHub(httpServer);

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    next();
  });

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
    express.static(config.fontsDir, { maxAge: '7d', index: false, fallthrough: false })
  );

  // Проверка состояния: сервер, база данных и живой канал связи
  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      service: 'krafen-overlay-platform',
      stage: 2,
      serverTime: new Date().toISOString(),
      db: db.getHealth(),
      realtime: realtime.getStats(),
    });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ ok: false, error: 'not_found' });
  });

  // Файлы интерфейса. no-cache = браузер каждый раз сверяется с сервером
  // и после обновления платформы не показывает устаревшую страницу.
  const pageOptions = { headers: { 'Cache-Control': 'no-cache' } };

  app.use(
    express.static(config.publicDir, {
      extensions: false,
      index: false,
      setHeaders(res) {
        res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  app.get('/', (_req, res) => {
    res.sendFile(path.join(config.publicDir, 'index.html'), pageOptions);
  });

  app.get('/app', (_req, res) => {
    res.sendFile(path.join(config.publicDir, 'app.html'), pageOptions);
  });

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

  async function start() {
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
    start,
    stop,
  };
}
