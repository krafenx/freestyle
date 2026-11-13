import { createOverlayServer } from './app.js';
import { loadEnvFile } from './config.js';

loadEnvFile();

let server;
try {
  server = createOverlayServer();
} catch (err) {
  console.error(`[krafen-overlay] Сервер не запущен: ${err.message}`);
  process.exit(1);
}

server
  .start()
  .then(({ host, port }) => {
    console.log(`[krafen-overlay] Сервер запущен на http://${host}:${port}`);
    if (!server.accounts.registrationOpen) {
      console.log('[krafen-overlay] Регистрация новых аккаунтов закрыта (REGISTRATION=closed)');
    }
    if (server.config.sessionCookieMode === 'embedded') {
      console.log('[krafen-overlay] Режим предпросмотра (SESSION_COOKIE_MODE=embedded): только для среды разработки');
    }
  })
  .catch((err) => {
    console.error('[krafen-overlay] Ошибка запуска сервера:', err);
    process.exit(1);
  });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.stop().finally(() => process.exit(0));
  });
}
