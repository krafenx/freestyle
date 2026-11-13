import express from 'express';
import { sendMedia } from '../scene/http.js';

/* Оверлей со стороны адресов — то, к чему обращается страница, открытая в OBS:

     GET /api/overlay/<ссылка>                 сцена: только то, что сейчас показано
     GET /overlay/<ссылка>/media/<файл>        файл, который сейчас показан на сцене

   Входа здесь нет вовсе: cookie не читаются и не выставляются, сеансы не трогаются.
   Площадку открывает ссылка оверлея, и только на чтение — других действий у этих
   адресов нет. Проверок здесь тоже нет: действует ли ссылка, решают правила площадок
   (workspaces.enterOverlay), а что именно по ней видно — правила сцены (scene.js).
   Сама страница оверлея отдаётся в app.js. */
export function createOverlayHttp({ scene, reply }) {
  // Что предъявлено — только ссылка из адреса
  const from = (req) => ({ token: req.params.token });

  /* ---------- /api/overlay ---------- */
  const apiRouter = express.Router();

  // Ни сцена, ни отказ не запоминаются браузером: ссылку могут отменить в любой момент
  apiRouter.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  apiRouter.get('/:token', (req, res) => {
    res.json({ ok: true, ...scene.overlayScene(from(req)) });
  });

  apiRouter.use(reply);

  /* ---------- /overlay/<ссылка>/media/<файл> ----------
     Отдаётся так же, как файл в редакторе: тип из базы и запрет что-либо выполнять.
     Браузер хранит файл, но перед показом сверяется с сервером — по отменённой ссылке
     он перестаёт отдаваться сразу. */
  const mediaRouter = express.Router();

  mediaRouter.get('/:token/media/:fileId', (req, res, next) => {
    sendMedia(res, scene.openOverlayMedia({ ...from(req), fileId: req.params.fileId }), next);
  });

  mediaRouter.use(reply);

  return { apiRouter, mediaRouter };
}
