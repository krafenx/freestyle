import { describeError, goToLogin, request } from '../core/session.js';
import { createServerClock } from '../scene/clock.js';

/* ==========================================================================
   Состояние редактора и его связь с сервером.

   Истина хранится на сервере. Страница держит копию сцены, сразу показывает
   правку человека и отправляет её серверу; ответ сервера заменяет копию.

   Порядок действий сохраняется: команды уходят строго по одной, следующая —
   после ответа на предыдущую. Мелкие правки одного источника (движение ползунка,
   набор текста) склеиваются в одну команду.

   Версия сцены. Каждое сохранённое изменение увеличивает её на единицу. Если
   пришёл ответ на свою команду «перепрыгнул» через номер — значит, сцену менял
   кто-то ещё, и страница перечитывает её целиком. Правки, которые человек ещё
   не успел сохранить, при этом остаются.

   Правки на лету (этап 7). По живому каналу приходит не только «сцена изменилась»,
   но и само изменение: какие источники появились, изменились, переставились или
   исчезли. Страница применяет его к своей копии — сцена в эфире меняется сразу,
   без запроса. Перечитывание остаётся страховкой: если изменение пришло не по
   порядку, непонятное или слишком давно (страница только что подключалась),
   страница перечитывает сцену целиком.

   Присутствие. Пока человек тянет источник, страница присылает его промежуточное
   положение в живой канал — и видит по нему чужие: «Модератор двигает: Заголовок».
   В базу это не попадает: сохраняется одна итоговая правка, когда источник отпустили.
   ========================================================================== */

const SAVE_DELAY_MS = 350; // пауза после последней правки, прежде чем отправлять
const KEEPALIVE_MAX = 16_000; // запрос «переживает» закрытие вкладки, только если он небольшой
const RETRY_STEPS_MS = [2000, 4000, 8000, 15000];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Правка поверх источника: настройки типа дополняются, а не заменяются целиком
function applyPatch(source, patch) {
  const next = { ...source, ...patch };
  if (patch.settings) next.settings = { ...source.settings, ...patch.settings };
  return next;
}

// Две неотправленные правки одного источника — одна; newer перекрывает older
function mergePatches(older, newer) {
  if (!older) return newer;
  if (!newer) return older;
  const out = { ...older, ...newer };
  if (older.settings || newer.settings) out.settings = { ...older.settings, ...newer.settings };
  return out;
}

/* Как назвать действие человеку: «Отменить перемещение» понятнее, чем «Отменить».
   Названия полей — те же слова, что в панели свойств. */
const FIELD_NAMES = {
  x: 'положение',
  y: 'положение',
  width: 'размер',
  height: 'размер',
  opacity: 'непрозрачность',
  visible: 'видимость',
  locked: 'защиту от сдвига',
  name: 'название',
};

function describeAction({ kind, values, name }) {
  if (kind === 'add') return name ? `добавление «${name}»` : 'добавление источника';
  if (kind === 'delete') return name ? `удаление «${name}»` : 'удаление источника';
  if (kind === 'order') return 'порядок слоёв';
  const keys = new Set([
    ...Object.keys(values?.before || {}),
    ...Object.keys(values?.settings?.before || {}),
  ]);
  if (keys.size === 1 && keys.has('settings')) return 'настройку';
  if (keys.size === 1) return FIELD_NAMES[[...keys][0]] || 'правку';
  if (keys.has('x') || keys.has('y') || keys.has('width') || keys.has('height')) {
    if ([...keys].every((key) => ['x', 'y', 'width', 'height'].includes(key))) return 'положение и размер';
  }
  return 'правку';
}

export function createStore({ workspaceId, clientId, notify }) {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/scene`;
  const headers = { 'X-Client-Id': clientId };
  let urgent = false; // вкладку сворачивают или закрывают: правки нужно успеть отправить
  const call = (method, path, body = {}) =>
    // Такой запрос браузер доводит до конца, даже если страницы уже нет
    request(`${base}${path}`, { method, body, headers, keepalive: urgent && JSON.stringify(body).length < KEEPALIVE_MAX });

  const state = {
    ready: false,
    workspace: null,
    scene: { width: 1920, height: 1080 },
    sources: [], // снизу вверх
    media: [],
    limits: null,
    usage: null,
    selectedId: null,
  };

  let version = 0; // версия сцены, которую страница знает целиком
  const clock = createServerClock(); // время сервера: по нему идут таймеры

  const pending = new Map(); // источник → правка, ещё не отправленная на сервер
  let chain = Promise.resolve();
  let jobs = 0; // команд в очереди, включая перечитывание сцены
  let writes = 0; // из них меняющих сцену: пока они идут, сцена «сохраняется»
  let needRefetch = false;
  let refetchTimer = null;
  let flushTimer = null;
  let retryTimer = null;
  let retryStep = 0;
  let offline = false;
  let silence = null; // последний ответ, которого по существу не было: нет связи, сбой, просьба подождать
  let gone = false;
  let saveState = 'saved';
  /* Куда уходит присутствие (задаётся страницей, когда живой канал подключён).
     null — канала нет: двигать можно, просто другие этого не увидят. */
  let presenceSend = null;
  let presenceLast = 0;
  const PRESENCE_EVERY_MS = 120; // чаще этого о положении не сообщаем: глазам хватает
  /* Кто сейчас что двигает — со слов сервера. Ключ — метка вкладки (origin правки):
     так «двигаете вы» относится к этой вкладке, а не к человеку вообще. */
  let present = new Map();

  /* ---------- История своих действий (Ctrl+Z) ----------
     Отменяется только своё и только то, что не уехало на сервер: пока правка ждёт
     своей паузы, назад её отыграть честно — значит вернуть прежние значения и не
     отправлять ничего. А вот общая история правок площадки не ведётся: отменить
     чужое действие — это не «вернуть как было», а новая правка поверх чужой работы,
     и человек об этом не просил.

     Запись помнит, что именно изменилось: значения до и после, по каждому полю.
     Настройки — по каждому ключу отдельно: иначе отмена правки одного поля стёрла бы
     соседние, сделанные после неё. */
  const HISTORY_MAX = 200;
  let past = []; // что можно отменить, старые записи в начале
  let future = []; // что можно повторить, ближайшая — в конце

  function historyValues(source, patch) {
    const values = { before: {}, after: {} };
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'settings') continue;
      values.before[key] = source?.[key];
      values.after[key] = value;
    }
    if (patch.settings) {
      values.settings = { before: {}, after: {} };
      for (const [key, value] of Object.entries(patch.settings)) {
        values.settings.before[key] = source?.settings?.[key];
        values.settings.after[key] = value;
      }
    }
    return values;
  }

  function record(entry) {
    // Ничего не изменилось — нечего и отменять
    if (entry.values) {
      const empty =
        Object.keys(entry.values.before).length === 0 &&
        Object.keys(entry.values.settings?.before || {}).length === 0;
      if (empty) return;
    }
    past.push(entry);
    if (past.length > HISTORY_MAX) past.shift();
    future = [];
    emit('history', historyState());
  }

  //Значения «до» и «после» → правка в нужную сторону
  function valuesFor(values, side) {
    const patch = {};
    for (const [key, value] of Object.entries(values[side])) patch[key] = value;
    if (values.settings) {
      const settings = {};
      for (const [key, value] of Object.entries(values.settings[side])) settings[key] = value;
      if (Object.keys(settings).length) patch.settings = settings;
    }
    return patch;
  }

  function historyState() {
    const last = past[past.length - 1];
    return {
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      undoLabel: last ? describeAction(last) : '',
      redoLabel: future.length ? describeAction(future[future.length - 1]) : '',
    };
  }

  /* ---------- Подписки ---------- */
  const listeners = new Map();
  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
  }
  function emit(event, detail) {
    for (const fn of listeners.get(event) || []) {
      try {
        fn(detail);
      } catch (err) {
        console.error('[editor] Сбой при обновлении страницы:', err);
      }
    }
  }

  function setSave() {
    const next = gone ? 'gone' : offline ? 'offline' : writes > 0 || pending.size > 0 ? 'saving' : 'saved';
    if (next === saveState) return;
    saveState = next;
    emit('save', next);
  }

  /* ---------- Копия сцены ---------- */
  const find = (id) => state.sources.find((source) => source.id === id) || null;
  const indexOf = (id) => state.sources.findIndex((source) => source.id === id);

  function replace(source) {
    const at = indexOf(source.id);
    if (at < 0) return false;
    if (same(state.sources[at], source)) return false;
    state.sources = state.sources.map((item, i) => (i === at ? source : item));
    return true;
  }

  function dropLocal(id) {
    pending.delete(id);
    if (indexOf(id) < 0) return;
    state.sources = state.sources.filter((source) => source.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    emit('change', { kind: 'all' });
  }

  // Порядок слоёв с сервера. Если он не сходится с тем, что знает страница, сцену меняли без нас
  function applyOrder(order) {
    if (!Array.isArray(order)) return;
    const byId = new Map(state.sources.map((source) => [source.id, source]));
    if (order.length !== byId.size || order.some((id) => !byId.has(id))) needRefetch = true;
    const next = order.map((id) => byId.get(id)).filter(Boolean);
    for (const source of state.sources) {
      if (!order.includes(source.id)) next.push(source);
    }
    state.sources = next;
  }

  // Ответ сервера об одном источнике. Неотправленные правки человека остаются поверх
  function adoptSource(server) {
    if (!server) return;
    const patch = pending.get(server.id);
    if (replace(patch ? applyPatch(server, patch) : server)) emit('change', { kind: 'source', id: server.id });
  }

  function adoptVersion(next) {
    if (typeof next !== 'number') return;
    if (next === version || next === version + 1) version = next;
    else if (next > version) needRefetch = true; // между нашими командами прошла чужая правка
  }

  function adoptScene(data) {
    version = data.scene.version;
    state.workspace = data.workspace;
    state.scene = { width: data.scene.width, height: data.scene.height };
    state.media = data.media;
    state.limits = data.limits;
    state.usage = data.usage;

    const local = new Map(state.sources.map((source) => [source.id, source]));
    state.sources = data.sources.map((server) => {
      const patch = pending.get(server.id);
      const merged = patch ? applyPatch(server, patch) : server;
      const old = local.get(server.id);
      // Не изменившийся источник остаётся тем же объектом: сцена его не перерисовывает
      return old && same(old, merged) ? old : merged;
    });
    for (const id of [...pending.keys()]) {
      if (!find(id)) pending.delete(id); // источник удалили, пока правка ждала отправки
    }
    if (state.selectedId && !find(state.selectedId)) state.selectedId = null;
    state.ready = true;
    emit('change', { kind: 'all' });
  }

  /* ---------- Правки на лету ----------
     Изменение из живого канала применяется к копии сцены. Порядок строгий: изменение
     годится, только если оно ровно на шаг новее того, что страница знает. Всё
     остальное (пропуск, повтор, слишком большая дыра — например, страница только что
     подключилась) — повод перечитать сцену целиком: так проще и надёжнее, чем
     догонять неизвестное.

     Что важнее всего: неотправленная правка человека остаётся поверх пришедшего.
     Чужая правка того же источника не должна затирать то, что человек ещё не успел
     сохранить. */

  // Источник пришёл с сервера: накладываем неотправленную правку, остальное — как есть
  function mergeServer(server) {
    const patch = pending.get(server.id);
    return patch ? applyPatch(server, patch) : server;
  }

  function applyDelta(delta, nextVersion) {
    if (!delta || typeof delta !== 'object') return false;
    if (typeof nextVersion === 'number' && nextVersion !== version + 1) return false;
    const { add = [], put = [], order, remove = [] } = delta;
    if (!Array.isArray(add) || !Array.isArray(put) || !Array.isArray(remove)) return false;
    // Порядок может прийти и неполный — тогда его просто не трогаем
    if (order !== undefined && (!Array.isArray(order) || order.some((id) => typeof id !== 'string'))) return false;

    const known = new Set(state.sources.map((source) => source.id));
    // Источник, которого страница не знает, — повод перечитать: значит, она отстала
    if (put.some((item) => !item || !known.has(item.id))) return false;
    // Источника, который уже есть, быть не может: значит, она отстала
    if (add.some((item) => !item || known.has(item.id))) return false;
    if (remove.some((id) => !known.has(id))) return false;

    let list = state.sources.map((source) => source);
    for (const id of remove) {
      list = list.filter((source) => source.id !== id);
      pending.delete(id);
      if (state.selectedId === id) state.selectedId = null;
    }
    for (const item of put) {
      const at = list.findIndex((source) => source.id === item.id);
      if (at < 0) continue;
      const merged = mergeServer({ ...list[at], ...item });
      // Не изменившийся источник остаётся тем же объектом: сцена его не перерисовывает
      list[at] = same(list[at], merged) ? list[at] : merged;
    }
    const byId = new Map(list.map((source) => [source.id, source]));
    for (const item of add) {
      const merged = mergeServer(item);
      list.push(merged);
      byId.set(merged.id, merged);
    }
    if (order) {
      // Полный порядок — тот, где перечислены все известные источники
      const complete = order.length === list.length && order.every((id) => byId.has(id));
      if (complete) list = order.map((id) => byId.get(id));
    }
    state.sources = list;
    if (typeof nextVersion === 'number') version = nextVersion;
    emit('change', { kind: 'all' });
    return true;
  }

  /* ---------- Очередь команд ---------- */
  function enqueue(task, { write = true } = {}) {
    jobs += 1;
    if (write) writes += 1;
    setSave();
    const result = chain.then(task);
    chain = result
      .catch((err) => console.error('[editor] Сбой команды:', err))
      .then(() => {
        jobs -= 1;
        if (write) writes -= 1;
        // Без связи перечитывать бесполезно: это сделает повтор по таймеру
        if (jobs === 0 && needRefetch && !offline) queueRefetch(0);
        setSave();
      });
    return result;
  }

  function markGone() {
    if (gone) return;
    gone = true;
    pending.clear();
    clearTimeout(flushTimer);
    clearTimeout(retryTimer);
    clearTimeout(refetchTimer);
    /* Сцена этому человеку больше не доступна — её копия со страницы убирается целиком:
       иначе под надписью «сцена недоступна» продолжали бы идти таймеры и играть ролики,
       а в списках оставались бы чужие тексты и названия файлов. */
    state.ready = false;
    state.sources = [];
    state.media = [];
    state.selectedId = null;
    emit('change', { kind: 'all' });
    setSave();
    emit('gone');
  }

  function backOnline() {
    offline = false;
    silence = null;
    retryStep = 0;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  // Сервер не ответил: правки остаются на странице, отправка повторяется сама
  function goOffline(waitMs) {
    offline = true;
    setSave();
    if (retryTimer) return;
    const delay = waitMs || RETRY_STEPS_MS[Math.min(retryStep, RETRY_STEPS_MS.length - 1)];
    retryStep += 1;
    retryTimer = setTimeout(retry, delay);
  }

  function retry() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (gone) return;
    if (needRefetch || !pending.size) queueRefetch(0);
    flush(true);
  }

  // Сервер не ответил по существу: нет связи, сбой или просьба подождать
  const noAnswer = (res) => res.status === 0 || res.status >= 500 || res.status === 429;

  /* Разбор отказа. true — можно продолжать со следующей командой;
     false — связи нет, продолжать бессмысленно. */
  function refused(res, { requeue, sourceId } = {}) {
    const code = res.data?.error;
    if (noAnswer(res)) {
      silence = res;
      requeue?.();
      goOffline(res.status === 429 ? (Number(res.data?.retryAfterSeconds) || 5) * 1000 : 0);
      return false;
    }
    backOnline(); // сервер ответил — пусть и отказом
    if (res.status === 401) {
      goToLogin();
      return false;
    }
    if (code === 'workspace_not_found') {
      markGone();
      return false;
    }
    if (code === 'source_not_found' && sourceId) {
      dropLocal(sourceId);
      notify('Этого источника уже нет: его удалил другой участник.');
      return true;
    }
    // Сервер не принял правку: показываем причину и возвращаем то, что сохранено на самом деле
    notify(describeError(res), 'error');
    needRefetch = true;
    return true;
  }

  async function sendPatch(id) {
    const patch = pending.get(id);
    if (!patch) return true;
    pending.delete(id);
    if (!find(id)) return true;
    const res = await call('PATCH', `/sources/${encodeURIComponent(id)}`, patch);
    if (res.ok) {
      backOnline();
      adoptVersion(res.data.version);
      adoptSource(res.data.source);
      return true;
    }
    return refused(res, {
      sourceId: id,
      // Пока шёл запрос, человек мог править дальше — его новые значения важнее
      requeue: () => pending.set(id, mergePatches(patch, pending.get(id))),
    });
  }

  async function sendAllPending() {
    for (const id of [...pending.keys()]) {
      if (!(await sendPatch(id))) return false;
    }
    return true;
  }

  /* Перед командой («добавить», «скопировать», «пуск таймера») уходят накопленные правки:
     иначе команда выполнилась бы над устаревшим источником. Не ушли — значит, сервер молчит,
     и команда не выполняется. Сама страница её не повторит, поэтому человеку об этом говорят:
     без сообщения нажатие выглядело бы так, будто кнопка не работает. */
  async function sendPendingFirst() {
    if (await sendAllPending()) return true;
    if (silence) notify(describeError(silence), 'error');
    return false;
  }

  /* ---------- Отмена: то, что уже на сервере ----------
     Не всё удаётся отменить «до отправки»: удаление уходит сразу, а добавление —
     пока человек не успел за это время ничего другого. Тогда отмена — это новая
     правка: вернуть источник или убрать его. Идёт она тихо, мимо истории, и не мешает
     человеку работать: важно только, чтобы страница и сервер снова сошлись. */
  function send(path, body, { quiet = false } = {}) {
    return enqueue(async () => {
      const res = await call('POST', path, body);
      if (res.ok) {
        backOnline();
        adoptVersion(res.data.version);
        if (res.data.order) applyOrder(res.data.order);
        emit('change', { kind: 'all' });
        return res.data;
      }
      if (!quiet) commandFailed(res);
      needRefetch = true;
      return null;
    });
  }

  /* Вернуть удалённый источник: создаём его заново с прежними полями и настройками.
     Номер будет новый — старый уже занят историей и живым каналом, да и неважно:
     на странице источник узнают по месту и содержимому. */
  function restoreSource(entry) {
    const source = entry.source;
    if (!source) return null;
    entry.ids ??= [];
    const props = {
      name: source.name,
      x: source.x,
      y: source.y,
      width: source.width,
      height: source.height,
      opacity: source.opacity,
      visible: source.visible,
      locked: source.locked,
      settings: source.settings,
    };
    if (source.fileId) props.file = source.fileId;
    entry.restoring = send('/sources', { type: source.type, props }, { quiet: true }).then((data) => {
      if (!data?.source) return null;
      // Номер изменился: запись истории теперь указывает на новый источник
      entry.originalId ??= entry.id;
      entry.id = data.source.id;
      entry.source = { ...source, id: data.source.id };
      return data.source.id;
    });
    return { id: entry.id };
  }

  /* ---------- Отмена: шаг назад или вперёд ----------
     Возвращает запись в историю (её показывают человеку) или null, если идти некуда.
     Правка источника: возвращаем прежние значения и убираем её из очереди на отправку.
     Создание и удаление: пока ответа нет, отменять нечего — источник просто не появился
     или ещё не исчез, и на сервер ничего не уходило. */
  function step(direction) {
    if (gone) return null;
    const from = direction < 0 ? past : future;
    const to = direction < 0 ? future : past;
    const entry = from[from.length - 1];
    if (!entry) return null;

    if (entry.kind !== 'change') {
      from.pop();
      to.push(entry);
      if (entry.kind === 'add') {
        if (!entry.id) return null; // ответа ещё нет: источника нет и на странице
        if (find(entry.id)) {
          // Источник уже на сервере — убрать его оттуда значит удалить
          dropLocal(entry.id);
          send(`/sources/${encodeURIComponent(entry.id)}/delete`, { quiet: true });
        }
      } else if (entry.kind === 'delete') {
        // Обе стороны: и на странице, и на сервере. Создаём копию прежнего источника
        // и возвращаем порядок — иначе следующая перезагрузка страницы всё отменит.
        /* Место в слоях считается по старому номеру: в списке «до удаления» записан он.
           А переставить на него нужно уже новый источник — ждём ответа сервера. */
        const oldId = entry.id;
        const index = Math.max(0, entry.order.indexOf(oldId));
        const restored = restoreSource(entry);
        if (restored) {
          pending.delete(restored.id);
          entry.restoring.then((newId) => {
            if (!newId) return;
            send(`/sources/${encodeURIComponent(newId)}/move`, { index });
          });
        }
      } else if (entry.kind === 'order') {
        // Запомнили «до» — при повторном шаге это станет «после»
        entry.after ??= state.sources.map((source) => source.id);
        const order = direction < 0 ? entry.order : entry.after;
        applyOrder(order);
        emit('change', { kind: 'all' });
        /* Порядок на сервере меняется по одному источнику, а не целиком: вернуть его
           прежним можно, только переставив каждый источник на своё место — снизу вверх,
           потому что каждая перестановка сдвигает соседей. */
        for (const [index, sourceId] of order.entries()) {
          send(`/sources/${encodeURIComponent(sourceId)}/move`, { index });
        }
      }
      emit('history', historyState());
      setSave();
      return entry;
    }

    const source = find(entry.id);
    if (!source) {
      // Источник успели удалить (своими руками или чужими) — эта запись больше ничего не значит
      from.pop();
      emit('history', historyState());
      return null;
    }

    from.pop();
    const patch = valuesFor(entry.values, direction < 0 ? 'before' : 'after');
    // Отменённой правки в очереди быть не должно: иначе она уедет на сервер после отмены.
    // Если в очереди есть другие поля того же источника, их не трогаем — они отдельные.
    const queued = pending.get(entry.id) || null;
    /* Отмена (назад): тех полей, которые она вернула, в очереди на отправку быть не должно.
       Повтор (вперёд): они, наоборот, должны уехать на сервер — как обычная правка.
       Поля, которых отмена не касается, остаются как были. */
    const keep = (source_) => {
      const rest = {};
      for (const [key, value] of Object.entries(source_ || {})) {
        if (key === 'settings') continue;
        if (!(key in patch)) rest[key] = value;
      }
      if (source_?.settings) {
        const settings = {};
        for (const [key, value] of Object.entries(source_.settings)) {
          if (!(key in (patch.settings || {}))) settings[key] = value;
        }
        if (Object.keys(settings).length) rest.settings = settings;
      }
      return rest;
    };
    const next = direction < 0 ? keep(queued) : mergePatches(queued, patch);
    if (Object.keys(next).length) pending.set(entry.id, next);
    else pending.delete(entry.id);
    replace(applyPatch(source, patch));
    to.push(entry);
    emit('change', { kind: 'source', id: entry.id });
    emit('history', historyState());
    setSave();
    /* Отмена и повтор — такие же правки, как и всё остальное: то, что осталось
       неотправленным, уходит на сервер обычным порядком. Если не осталось ничего —
       отправлять нечего, и висящий таймер только зря разбудил бы страницу. */
    if (pending.size) scheduleFlush(SAVE_DELAY_MS);
    else clearTimeout(flushTimer), (flushTimer = null);
    return entry;
  }

  function flush(force = false) {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (gone || !pending.size || (offline && !force)) return Promise.resolve();
    return enqueue(sendAllPending).catch(() => {});
  }

  // Вкладку сворачивают или закрывают: отправляем всё, что ждало своей паузы, не откладывая
  function flushUrgent() {
    if (!pending.size) return;
    urgent = true;
    flush().then(() => {
      urgent = false;
    });
  }

  function scheduleFlush(delay) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flush(), delay);
  }

  /* ---------- Загрузка сцены ---------- */
  async function fetchScene() {
    needRefetch = false;
    const sentAt = performance.now();
    const res = await request(base, { headers });
    if (res.ok) {
      clock.sample(res.data.serverTime, performance.now() - sentAt);
      backOnline();
      adoptScene(res.data);
      return 'ok';
    }
    if (res.status === 401) {
      goToLogin();
      return 'login';
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      markGone();
      return 'gone';
    }
    // Нет связи. Если сцена уже на экране — оставляем её и пробуем позже сами;
    // если ещё нет — страница покажет кнопку «Повторить»
    if (state.ready) {
      needRefetch = true;
      goOffline(0);
    }
    return 'offline';
  }

  function queueRefetch(delay = 120) {
    if (refetchTimer || gone) return;
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      enqueue(fetchScene, { write: false }).catch(() => {});
    }, delay);
  }

  // Общее окончание команд «создать», «удалить», «переставить»…
  function commandFailed(res, sourceId) {
    refused(res, { sourceId });
    // Такую команду страница сама не повторит — человеку нужно знать, что она не прошла
    if (noAnswer(res)) notify(describeError(res), 'error');
  }

  /* ---------- Что доступно странице ---------- */
  return {
    state,
    on,
    find,
    indexOf,
    get saveState() {
      return saveState;
    },

    // Первая загрузка: 'ok', 'gone', 'login' или 'offline'
    load: () => enqueue(fetchScene, { write: false }),
    refresh: () => queueRefetch(0),

    select(id) {
      const next = id && find(id) ? id : null;
      if (next === state.selectedId) return;
      state.selectedId = next;
      emit('change', { kind: 'select' });
    },

    /* Правка источника: сразу видна на странице, на сервер уходит чуть позже.
       save: false — пока только показать (идёт перетаскивание); soon — отправить без паузы;
       delay — своя пауза перед отправкой (набор с клавиатуры ждёт дольше ползунка). */
    change(id, patch, { save = true, soon = false, delay = SAVE_DELAY_MS } = {}) {
      const source = find(id);
      if (!source || gone) return;
      const changed = replace(applyPatch(source, patch));
      pending.set(id, mergePatches(pending.get(id), patch));
      // Пока источник тянут, история не растёт: отменять там нечего, запись была бы на каждый шаг
      if (save && changed) record({ kind: 'change', id, values: historyValues(source, patch), name: source.name });
      if (changed) emit('change', { kind: 'source', id });
      if (save) scheduleFlush(soon ? 0 : delay);
      setSave();
    },

    /* ---------- Отмена своих действий ----------
       Возвращает true, если отменять было что. Всё, что отменяется, ещё не уехало
       на сервер: правка ждёт своей паузы, а создание и удаление — ответа.
       Значит, отмена — это просто «забыть эту правку», а не новая правка поверх. */
    undo: () => step(-1),
    redo: () => step(1),
    history: () => historyState(),

    flush: () => flush(),
    flushUrgent,

    /* Связь вернулась (так говорит браузер) или человек вернулся на вкладку — не ждём таймера.
       Повторы снова идут часто: первая попытка нередко срывается, потому что сеть «поднялась»
       ещё не до конца, и без этого следующая была бы только через 8–15 секунд. */
    wake() {
      if (!offline && !needRefetch) return;
      retryStep = 0;
      retry();
    },

    hasUnsaved: () => pending.size > 0 || writes > 0,

    create(type, props) {
      return enqueue(async () => {
        if (!(await sendPendingFirst())) return null;
        const res = await call('POST', '/sources', props ? { type, props } : { type });
        if (!res.ok) {
          commandFailed(res);
          return null;
        }
        backOnline();
        adoptVersion(res.data.version);
        state.sources = [...state.sources, res.data.source];
        applyOrder(res.data.order);
        record({ kind: 'add', id: res.data.source.id, name: res.data.source.name });
        emit('change', { kind: 'all' });
        return res.data.source;
      });
    },

    duplicate(id) {
      return enqueue(async () => {
        if (!(await sendPendingFirst())) return null;
        const res = await call('POST', `/sources/${encodeURIComponent(id)}/duplicate`);
        if (!res.ok) {
          commandFailed(res, id);
          return null;
        }
        backOnline();
        adoptVersion(res.data.version);
        state.sources = [...state.sources, res.data.source];
        applyOrder(res.data.order);
        record({ kind: 'add', id: res.data.source.id, name: res.data.source.name });
        emit('change', { kind: 'all' });
        return res.data.source;
      });
    },

    remove(id) {
      // Что удаляем — для отмены: сам источник и порядок, в котором он стоял
      const removed = find(id);
      const order = state.sources.map((source) => source.id);
      return enqueue(async () => {
        pending.delete(id); // правки удаляемого источника отправлять незачем
        const res = await call('POST', `/sources/${encodeURIComponent(id)}/delete`);
        if (!res.ok && res.data?.error !== 'source_not_found') {
          commandFailed(res);
          return false;
        }
        backOnline();
        if (res.ok) adoptVersion(res.data.version);
        dropLocal(id);
        if (res.ok) applyOrder(res.data.order);
        if (res.ok && removed) record({ kind: 'delete', id, source: removed, order, name: removed.name });
        emit('change', { kind: 'all' });
        return true;
      });
    },

    // index — новое место в порядке слоёв: 0 — в самом низу
    move(id, index) {
      const from = indexOf(id);
      const to = Math.min(state.sources.length - 1, Math.max(0, index));
      if (from < 0 || from === to) return Promise.resolve(false);
      // Сразу показываем новый порядок; сервер его подтвердит или поправит
      const order = state.sources.map((source) => source.id);
      const next = state.sources.filter((source) => source.id !== id);
      next.splice(to, 0, state.sources[from]);
      state.sources = next;
      record({ kind: 'order', id, order, name: state.sources[to]?.name });
      emit('change', { kind: 'all' });

      return enqueue(async () => {
        const res = await call('POST', `/sources/${encodeURIComponent(id)}/move`, { index: to });
        if (!res.ok) {
          commandFailed(res, id);
          needRefetch = true;
          return false;
        }
        backOnline();
        adoptVersion(res.data.version);
        applyOrder(res.data.order);
        emit('change', { kind: 'all' });
        return true;
      });
    },

    // Команда источнику (таймеру: пуск, пауза, сброс). Время считает сервер
    command(id, action) {
      return enqueue(async () => {
        if (!(await sendPendingFirst())) return false;
        const res = await call('POST', `/sources/${encodeURIComponent(id)}/command`, { action });
        if (!res.ok) {
          commandFailed(res, id);
          return false;
        }
        backOnline();
        adoptVersion(res.data.version);
        adoptSource(res.data.source);
        return true;
      });
    },

    /* ---------- Файлы ---------- */
    mediaById: (id) => state.media.find((file) => file.id === id) || null,
    mediaUrl: (id) => `/media/${encodeURIComponent(workspaceId)}/${encodeURIComponent(id)}`,

    /* Загрузка файла. Идёт мимо очереди команд: большой файл не должен задерживать
       сохранение правок. Ответ — как у обычного запроса: { ok, status, data }. */
    upload(file, { onProgress } = {}) {
      return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${base}/media`);
        xhr.responseType = 'json';
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || ''));
        xhr.setRequestHeader('X-Client-Id', clientId);
        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) onProgress?.(event.loaded / event.total);
        });
        const finish = () => {
          const data = xhr.status !== 0 && xhr.response && typeof xhr.response === 'object' ? xhr.response : { error: 'network' };
          const res = { ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data };
          if (res.ok) {
            state.media = [data.file, ...state.media];
            state.usage = data.usage;
            adoptVersion(data.version);
            if (needRefetch && jobs === 0) queueRefetch(0);
            emit('change', { kind: 'media' });
          } else if (res.status === 401) {
            goToLogin();
          } else if (data.error === 'workspace_not_found') {
            markGone();
          }
          resolve(res);
        };
        xhr.addEventListener('load', finish);
        xhr.addEventListener('error', finish);
        xhr.addEventListener('abort', finish);
        xhr.send(file);
      });
    },

    removeMedia(fileId) {
      return enqueue(async () => {
        if (!(await sendAllPending())) return { ok: false, status: 0, data: { error: 'network' } };
        const res = await call('POST', `/media/${encodeURIComponent(fileId)}/delete`);
        if (res.ok) {
          backOnline();
          adoptVersion(res.data.version);
          state.media = state.media.filter((file) => file.id !== fileId);
          state.usage = res.data.usage;
          emit('change', { kind: 'media' });
        } else if (res.status === 401) {
          goToLogin();
        } else if (res.data?.error === 'workspace_not_found') {
          markGone();
        } else if (res.data?.error === 'media_not_found') {
          needRefetch = true;
        }
        return res;
      });
    },

    /* ---------- Сигналы живого канала и часы ---------- */
    signal(message) {
      if (message?.what !== 'scene') return;
      if (message.origin === clientId) return; // наша же правка: ответ на неё придёт запросом
      if (typeof message.version === 'number' && message.version <= version) return;
      // Изменение к сигналу: применяем сами — сцена меняется сразу, без запроса
      if (applyDelta(message.delta, message.version)) return;
      queueRefetch();
    },

    /* Изменение пришло по каналу и не применилось: страница ничего не потеряла,
       но и нового не увидела. Перечитываем сцену обычным запросом. */
    stale: () => queueRefetch(0),

    /* ---------- Присутствие ---------- */
    // Страница сообщает, куда отправлять «что я двигаю» (или null — канала нет)
    setPresenceChannel(send) {
      presenceSend = typeof send === 'function' ? send : null;
      if (!presenceSend) presenceLast = 0;
    },

    /* Положение источника, который сейчас тянут. В базу ничего не идёт, а сообщение
       о присутствии уходит не чаще, чем раз в PRESENCE_EVERY_MS.
       Полный прямоугольник берём из сцены, а не из правки: правка несёт только то, что
       изменилось, а вторая страница не знает ни размера источника, ни того, что он
       вообще есть, — ей нужны все четыре числа. */
    moving(id) {
      if (!presenceSend || gone) return;
      const source = find(id);
      if (!source) return;
      const time = performance.now();
      if (time - presenceLast < PRESENCE_EVERY_MS) return;
      presenceLast = time;
      presenceSend({
        sourceId: id,
        x: Math.round(source.x),
        y: Math.round(source.y),
        width: Math.round(source.width),
        height: Math.round(source.height),
        end: false,
      });
    },

    // Источник отпустили: присутствие снимается сразу
    stoppedMoving() {
      if (!presenceSend) return;
      presenceLast = 0;
      presenceSend({ end: true });
    },

    // Кто сейчас что двигает — для панели и сцены
    presence: () => [...present.values()],
    presenceOf: (sourceId) => present.get(sourceId) || null,

    /* Сервер сказал, кто что двигает — и отметил, чьи это движения (mine): у одного
       человека в двух вкладках это одно присутствие, и обе видят «двигаете вы».
       Страница ничего не сравнивает сама. */
    setPresence(people) {
      const next = new Map();
      for (const person of Array.isArray(people) ? people : []) {
        if (person && typeof person.sourceId === 'string') next.set(person.sourceId, person);
      }
      const outline = (list) => JSON.stringify(list.map((person) => [person.sourceId, person.name, person.mine]).sort());
      const changed = outline([...present.values()]) !== outline([...next.values()]);
      present = next;
      if (changed) emit('change', { kind: 'presence' });
    },

    // Время сервера: по нему считают таймеры, чтобы у всех совпадало (см. scene/clock.js)
    now: clock.now,
    syncClock: (serverTime, tripMs) => clock.sample(serverTime, tripMs),
  };
}
