import { createOverlayServer } from './app.js';

const server = createOverlayServer();

server
  .start()
  .then(({ host, port }) => {
    console.log(`[krafen-overlay] Сервер запущен на http://${host}:${port}`);
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
