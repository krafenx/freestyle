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
   пришёл сигнал с более новой версией или ответ на свою команду «перепрыгнул»
   через номер — значит, сцену менял кто-то ещё, и страница перечитывает её
   целиком. Правки, которые человек ещё не успел сохранить, при этом остаются.
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
  let gone = false;
  let saveState = 'saved';

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
    setSave();
    emit('gone');
  }

  function backOnline() {
    offline = false;
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
      if (changed) emit('change', { kind: 'source', id });
      if (save) scheduleFlush(soon ? 0 : delay);
      setSave();
    },

    flush: () => flush(),
    flushUrgent,

    // Связь вернулась — не ждём таймера
    wake() {
      if (offline || needRefetch) retry();
    },

    hasUnsaved: () => pending.size > 0 || writes > 0,

    create(type, props) {
      return enqueue(async () => {
        if (!(await sendAllPending())) return null;
        const res = await call('POST', '/sources', props ? { type, props } : { type });
        if (!res.ok) {
          commandFailed(res);
          return null;
        }
        backOnline();
        adoptVersion(res.data.version);
        state.sources = [...state.sources, res.data.source];
        applyOrder(res.data.order);
        emit('change', { kind: 'all' });
        return res.data.source;
      });
    },

    duplicate(id) {
      return enqueue(async () => {
        if (!(await sendAllPending())) return null;
        const res = await call('POST', `/sources/${encodeURIComponent(id)}/duplicate`);
        if (!res.ok) {
          commandFailed(res, id);
          return null;
        }
        backOnline();
        adoptVersion(res.data.version);
        state.sources = [...state.sources, res.data.source];
        applyOrder(res.data.order);
        emit('change', { kind: 'all' });
        return res.data.source;
      });
    },

    remove(id) {
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
      const next = state.sources.filter((source) => source.id !== id);
      next.splice(to, 0, state.sources[from]);
      state.sources = next;
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
        if (!(await sendAllPending())) return false;
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
      queueRefetch();
    },

    // Время сервера: по нему считают таймеры, чтобы у всех совпадало (см. scene/clock.js)
    now: clock.now,
    syncClock: (serverTime, tripMs) => clock.sample(serverTime, tripMs),
  };
}
