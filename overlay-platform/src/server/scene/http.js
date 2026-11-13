import express from 'express';
import { fields } from '../auth/http.js';

/* Сцена со стороны адресов: /api/workspaces/:id/scene/* и /media/*.
   Здесь нет ни одной проверки прав — только передача «кто просит» и «что просит»
   в scene.js, где каждое действие первым делом входит в площадку. Так проверку
   невозможно забыть, добавляя новый адрес. */

// Загруженный файл — это данные. Даже если его открыть отдельной вкладкой, браузеру
// запрещено что-либо в нём выполнять и что-либо для него загружать
const MEDIA_SECURITY_POLICY = "default-src 'none'; sandbox";

// Команды редактора: самая большая — свой HTML-блок виджета (до 20 000 знаков)
const COMMAND_BODY_LIMIT = '256kb';

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

/* Отдать загруженный файл. Одинаково для редактора и для оверлея: тип берётся из базы —
   тот, что определён по содержимому при загрузке, — и браузеру запрещено его «угадывать»
   самому. file — то, что вернули правила сцены: где лежит файл и какого он типа. */
export function sendMedia(res, file, next) {
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Security-Policy', MEDIA_SECURITY_POLICY);
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Браузер хранит файл, но перед каждым показом спрашивает сервер: права проверяются заново
  res.setHeader('Cache-Control', 'private, no-cache');
  res.sendFile(file.name, { root: file.root, cacheControl: false, dotfiles: 'deny' }, (err) => {
    if (!err) return;
    // Оборванную человеком загрузку ошибкой не считаем
    if (res.headersSent) res.end();
    else next(err);
  });
}

export function createSceneHttp({ scene, auth }) {
  /* Кто просит — всегда из сеанса входа, а не из присланных данных. origin — метка
     страницы: не право и не секрет, по ней страница узнаёт в рассылке свою же правку. */
  const from = (req) => ({ userId: req.auth?.userId, workspaceId: req.params.id, origin: req.get('x-client-id') });

  /* ---------- /api/workspaces/:id/scene (только для вошедших) ---------- */
  const sceneRouter = express.Router({ mergeParams: true });

  /* Загрузка файла. Тело запроса — сам файл, поэтому этот адрес стоит до разбора JSON.
     Если ответ — отказ, а файл ещё не дочитан, соединение после ответа закрывается:
     сервер не обязан принимать то, что уже отклонил. */
  sceneRouter.post(
    '/media',
    auth.identify,
    (req, res, next) => {
      if (!req.auth) res.setHeader('Connection', 'close');
      next();
    },
    auth.requireAuth,
    (req, res, next) => {
      // Файл присылает только наша страница, и только в таком виде: обычная форма на чужом сайте так не умеет
      const type = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (type === 'application/octet-stream') return next();
      res.setHeader('Connection', 'close');
      return res.status(415).json({ ok: false, error: 'file_required' });
    },
    handle(async (req, res) => {
      /* Пока файл идёт, соединение не должно молчать. Если за заданное время не пришло
         ни байта, связь считается потерянной: сервер сам закрывает соединение, недокачанный
         файл удаляется, место для загрузки освобождается. Иначе «зависшая» загрузка
         (у человека пропал интернет) занимала бы это место, пока не истечёт общий срок запроса. */
      const { socket } = req;
      socket.setTimeout(scene.uploadIdleMs);
      try {
        const result = await scene.upload({
          ...from(req),
          stream: req,
          fileName: req.get('x-file-name'),
          declaredBytes: req.get('content-length'),
        });
        res.status(201).json({ ok: true, ...result });
      } catch (err) {
        if (!req.complete) res.setHeader('Connection', 'close');
        throw err;
      } finally {
        // Соединение может служить и следующим запросам — им этот срок не нужен
        if (!socket.destroyed) socket.setTimeout(0);
      }
    })
  );

  sceneRouter.use(auth.sessionWithBody(COMMAND_BODY_LIMIT), auth.requireAuth);

  sceneRouter.get('/', (req, res) => {
    res.json({ ok: true, ...scene.get(from(req)) });
  });

  sceneRouter.post('/sources', (req, res) => {
    const { type, props } = fields(req);
    res.status(201).json({ ok: true, ...scene.createSource({ ...from(req), type, props }) });
  });

  sceneRouter.patch('/sources/:sourceId', (req, res) => {
    res.json({ ok: true, ...scene.updateSource({ ...from(req), sourceId: req.params.sourceId, patch: fields(req) }) });
  });

  sceneRouter.post('/sources/:sourceId/delete', (req, res) => {
    res.json({ ok: true, ...scene.removeSource({ ...from(req), sourceId: req.params.sourceId }) });
  });

  sceneRouter.post('/sources/:sourceId/duplicate', (req, res) => {
    res.status(201).json({ ok: true, ...scene.duplicateSource({ ...from(req), sourceId: req.params.sourceId }) });
  });

  sceneRouter.post('/sources/:sourceId/move', (req, res) => {
    res.json({ ok: true, ...scene.moveSource({ ...from(req), sourceId: req.params.sourceId, index: fields(req).index }) });
  });

  sceneRouter.post('/sources/:sourceId/command', (req, res) => {
    res.json({ ok: true, ...scene.commandSource({ ...from(req), sourceId: req.params.sourceId, action: fields(req).action }) });
  });

  sceneRouter.post('/media/:fileId/delete', (req, res) => {
    res.json({ ok: true, ...scene.removeMedia({ ...from(req), fileId: req.params.fileId }) });
  });

  sceneRouter.use(auth.reply);

  /* ---------- /media/<площадка>/<файл> ----------
     Сам файл. Отдаётся только участнику площадки; гость и посторонний получают тот же
     ответ, что и на несуществующий файл. Оверлей берёт файлы по своему адресу и своей
     ссылке — см. overlay/http.js. */
  const mediaRouter = express.Router();

  mediaRouter.get('/:id/:fileId', auth.identify, (req, res, next) => {
    sendMedia(res, scene.openMedia({ ...from(req), fileId: req.params.fileId }), next);
  });

  mediaRouter.use(auth.reply);

  return { sceneRouter, mediaRouter };
}
