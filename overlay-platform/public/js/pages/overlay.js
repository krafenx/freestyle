import { connectRealtime } from '../core/api.js';
import { createServerClock } from '../scene/clock.js';
import { FONTS } from '../scene/sources/type-fields.js';
import { createSceneView } from '../scene/view.js';

/* ==========================================================================
   Оверлей — страница, которую открывает OBS (источник «Браузер»).

   Она показывает сцену и больше ничего. Источники рисует тот же модуль, что
   и в редакторе (js/scene/view.js), поэтому в эфире сцена выглядит так же.

   Страница не входит в аккаунт. Площадку ей открывает ссылка оверлея из адреса:
   по ней сервер отдаёт сцену, файлы и сигнал «сцена изменилась». С этапа 7 к сигналу
   приложено само изменение: страница применяет его к своей копии, и правка видна
   в эфире сразу, без запроса. Перечитывает сцену страница только когда изменение
   не подошло (пришло не по порядку, непонятное или слишком давно) да ещё по часам —
   редко, пока канал на связи, и часто, пока его нет.

   Главное правило: в эфир не попадает ничего, кроме сцены. Нет связи — остаётся
   то, что уже показано. Ссылка перестала действовать — сцена гаснет, а страница
   остаётся прозрачной. Никаких надписей об ошибках в OBS нет; они есть только
   во вкладке проверки, которую открывают со страницы площадки.

   Здесь нет свежих возможностей языка: встроенный браузер OBS старше обычного.
   Страница и всё, что она подключает, рассчитаны на Chromium 95 — он встроен в OBS
   начиная с версии 27.2 (февраль 2022 года).
   ========================================================================== */

const LINK = /^[0-9a-hjkmnp-tv-z]{32}$/;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_STEPS_MS = [1000, 2000, 4000, 8000, 15_000]; // сервер не ответил: повторяем сами
const POLL_LIVE_MS = 30_000; // канал на связи — сверка на случай, если сигнал потерялся
const POLL_OFFLINE_MS = 5000; // канала нет — сцену сверяем сами
const BUSY_RETRY_MS = 60_000; // каналов по ссылке слишком много — следующая попытка через минуту
const FONTS_WAIT_MS = 3000; // дольше этого шрифты не ждём: сцена важнее
const CHECK_MARGIN = 20; // поля вокруг сцены во вкладке проверки
const FONT_SAMPLE = 'Aa Яя 09'; // по этим знакам браузер выбирает, какие части шрифта скачать

const $ = (id) => document.getElementById(id);
const fitEl = $('overlay-fit');
const stageEl = $('overlay-stage');
const boundsEl = $('overlay-bounds');
const barEl = $('overlay-bar');
const statusEl = $('overlay-status');

/* ---------- Что открыто ----------
   /overlay/<ссылка>        — оверлей для OBS: только сцена;
   /overlay/check#<ссылка>  — вкладка проверки. Ссылка стоит после «#»: так она не уходит
                              на сервер вместе с запросом страницы. Страница сразу убирает
                              её из адресной строки — чтобы не засветить в эфире и чтобы
                              адрес проверки нельзя было по ошибке вставить в OBS —
                              и держит при себе до закрытия вкладки. */
const insideObs = typeof window.obsstudio !== 'undefined';
const segment = window.location.pathname.replace(/\/+$/, '').split('/').slice(2).join('/');

let token = '';
let checking = false;
if (segment === 'check') {
  const given = window.location.hash.slice(1);
  const kept = window.history.state && window.history.state.overlayLink;
  if (LINK.test(given)) token = given;
  else if (typeof kept === 'string' && LINK.test(kept)) token = kept;
  checking = !insideObs;
  try {
    window.history.replaceState(token ? { overlayLink: token } : null, '', '/overlay/check');
  } catch (err) {
    // адресную строку поправить не удалось — на показ сцены это не влияет
  }
} else if (LINK.test(segment)) {
  token = segment;
}

/* ---------- Сцена ---------- */
const clock = createServerClock(); // время сервера: по нему идут таймеры — как в редакторе
const view = createSceneView(stageEl, {
  mode: 'overlay',
  mediaUrl: (id) => `/overlay/${token}/media/${encodeURIComponent(id)}`,
  now: clock.now,
});

let size = { width: 1920, height: 1080 };
let version = -1; // версия сцены, которая сейчас на экране
let shown = new Map(); // номер источника → он сам и его настройки строкой: чтобы не перерисовывать то, что не менялось
let state = token ? 'loading' : 'gone'; // loading — сцены ещё нет, live — показана, gone — ссылка не действует
let reachable = true; // ответил ли сервер в последний раз
let liveUp = false; // на связи ли живой канал
let crowded = false; // сервер ответил, что каналов по этой ссылке уже слишком много
let live = null;
let liveTimer = null;

view.setSize(size.width, size.height);

/* Сцена целиком вписывается в окно и встаёт по центру. Когда окно того же размера,
   что и сцена (в OBS: 1920 × 1080), масштаба нет вовсе — точка в точку. */
function fit() {
  const margin = checking ? CHECK_MARGIN : 0;
  const roomW = Math.max(1, fitEl.clientWidth - margin * 2);
  const roomH = Math.max(1, fitEl.clientHeight - margin * 2);
  let scale = Math.min(roomW / size.width, roomH / size.height);
  if (checking) scale = Math.min(1, scale); // при проверке сцену не растягиваем
  const x = Math.round((fitEl.clientWidth - size.width * scale) / 2);
  const y = Math.round((fitEl.clientHeight - size.height * scale) / 2);
  stageEl.style.transform = scale === 1 && x === 0 && y === 0 ? 'none' : `translate(${x}px, ${y}px) scale(${scale})`;
  if (checking) {
    boundsEl.style.transform = `translate(${x}px, ${y}px)`;
    boundsEl.style.width = `${size.width * scale}px`;
    boundsEl.style.height = `${size.height * scale}px`;
  }
}

// Во вкладке проверки сцена встаёт под строкой с пояснениями; строка бывает и в две линии
function layout() {
  if (checking) fitEl.style.top = `${barEl.offsetHeight}px`;
  fit();
}

/* Источники с той же сценой: размер сверяется один раз на всех.
   Настройки и состояние источника, которые не изменились, остаются теми же объектами:
   по этому признаку сцена понимает, что содержимое перерисовывать не нужно. Ролик
   не начинается заново и рамка своего блока не перезагружается оттого, что источник
   подвинули или рядом поправили надпись. */
function show(width, height, sources) {
  if (width !== size.width || height !== size.height) {
    size = { width, height };
    view.setSize(width, height);
    layout();
  }
  const next = new Map();
  const list = sources.map((source) => {
    const settings = JSON.stringify(source.settings);
    const stateText = JSON.stringify(source.state);
    const old = shown.get(source.id);
    if (old) {
      if (old.settings === settings) source.settings = old.source.settings;
      if (old.stateText === stateText) source.state = old.source.state;
    }
    next.set(source.id, { source, settings, stateText });
    return source;
  });
  shown = next;
  view.setSources(list);
}

function apply(data) {
  const scene = data.scene;
  if (!scene || !(scene.width > 0) || !(scene.height > 0) || !Array.isArray(data.sources)) return false;
  show(scene.width, scene.height, data.sources);
  version = scene.version;
  return true;
}

/* ---------- Правки на лету ----------
   К сигналу «сцена изменилась» приложено само изменение. Применяется оно, только если
   ровно на шаг новее того, что на экране; иначе сцену проще перечитать, чем догонять.

   Осторожно с порядком: если два источника переставляли, изменение приходит с полным
   порядком слоёв — и только тогда он применяется. Неполный порядок значил бы, что
   страница чего-то не знает. */
function applyDelta(delta, nextVersion) {
  if (!delta || typeof delta !== 'object') return false;
  if (typeof nextVersion === 'number' && nextVersion !== version + 1) return false;
  const { add = [], put = [], order, remove = [] } = delta;
  if (!Array.isArray(add) || !Array.isArray(put) || !Array.isArray(remove)) return false;
  if (order !== undefined && !Array.isArray(order)) return false;

  const byId = new Map();
  for (const item of shown.values()) byId.set(item.source.id, item.source);
  const current = [...shown.values()].map((item) => item.source);

  // Источник, которого страница не знает, — повод перечитать: значит, она отстала
  if (put.some((item) => !item || !byId.has(item.id))) return false;
  if (add.some((item) => !item || byId.has(item.id))) return false;
  if (remove.some((id) => !byId.has(id))) return false;

  let list = current.filter((source) => !remove.includes(source.id));
  const index = new Map(list.map((source) => [source.id, source]));
  for (const item of put) {
    const at = list.indexOf(index.get(item.id));
    if (at < 0) continue;
    index.set(item.id, { ...list[at], ...item });
    list[at] = index.get(item.id);
  }
  for (const item of add) {
    index.set(item.id, item);
    list.push(item);
  }
  if (order) {
    const complete = order.length === list.length && order.every((id) => index.has(id));
    if (complete) list = order.map((id) => index.get(id));
  }

  show(size.width, size.height, list);
  if (typeof nextVersion === 'number') version = nextVersion;
  return true;
}

/* ---------- Шрифты ---------- */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Сцена уже собрана, но ещё не видна: ждём, пока браузер догрузит шрифты её надписей
async function reveal() {
  try {
    void stageEl.offsetWidth; // браузер раскладывает сцену — и узнаёт, какие шрифты ей нужны
    if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, pause(FONTS_WAIT_MS)]);
  } catch (err) {
    // без шрифтов сцена всё равно показывается
  }
  document.documentElement.classList.add('overlay-ready');
  warmFonts();
}

/* Остальные шрифты платформы скачиваются заранее, в фоне. Иначе в эфире на долю секунды
   мелькнул бы запасной шрифт — когда в редакторе сменят шрифт надписи или впервые
   наберут русскую букву там, где была только латиница. */
function warmFonts() {
  if (!document.fonts || !document.fonts.load) return;
  for (const font of FONTS) {
    const family = font.css.split(',')[0].trim();
    for (const look of ['400', '700', 'italic 400', 'italic 700']) {
      document.fonts.load(`${look} 16px ${family}`, FONT_SAMPLE).catch(() => {});
    }
  }
}

/* ---------- Что происходит (только для вкладки проверки) ---------- */
function report() {
  if (!checking) return;
  let text = 'Загружаю сцену…';
  let warn = false;
  if (state === 'gone') {
    text = token
      ? 'Ссылка не действует: владелец выпустил новую или площадку удалили. Откройте проверку заново со страницы площадки.'
      : 'Здесь нет ссылки оверлея. Откройте проверку кнопкой «Проверить в браузере» на странице площадки.';
    warn = true;
  } else if (!reachable) {
    text = state === 'live'
      ? 'Нет связи с сервером. Сцена показана такой, какой была; пробую снова.'
      : 'Нет связи с сервером. Пробую снова…';
    warn = true;
  } else if (state === 'live') {
    const empty = shown.size === 0 ? ' На сцене пока нет видимых источников.' : '';
    if (liveUp) text = `Сцена на связи: правки из редактора появляются здесь сами.${empty}`;
    else if (crowded) text = `Сцена показана. По этой ссылке открыто слишком много страниц сразу, поэтому правки доходят сюда за несколько секунд. Если это не ваши страницы — выпустите новую ссылку.${empty}`;
    else text = `Сцена показана. Живой канал подключается — пока сцена сверяется раз в несколько секунд.${empty}`;
  }
  statusEl.textContent = text;
  statusEl.classList.toggle('warn', warn);
  boundsEl.hidden = state === 'gone';
  layout(); // надпись могла занять больше или меньше места
}

/* ---------- Запросы сцены ----------
   Один запрос за раз. Если за время запроса появился новый повод свериться,
   после него выполняется ещё один запрос — и только один. */
let busy = false;
let queued = null; // null — повода нет; число — нужна версия не ниже этой; Infinity — свериться в любом случае
let timer = null;
let fails = 0;

async function ask() {
  const controller = new AbortController();
  const limit = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const sentAt = performance.now();
  try {
    // Без cookie: оверлею вход не нужен, а сервер их здесь и не читает
    const response = await fetch(`/api/overlay/${token}`, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, data, tripMs: performance.now() - sentAt };
  } catch (err) {
    return { status: 0, data: null, tripMs: 0 };
  } finally {
    clearTimeout(limit);
  }
}

function plan(delay) {
  clearTimeout(timer);
  timer = setTimeout(() => sync(), delay);
}

// atLeast — номер версии из сигнала: если она уже на экране, запрос не нужен
function sync(atLeast = Infinity) {
  if (state === 'gone' || atLeast <= version) return;
  if (busy) {
    queued = queued === null ? atLeast : Math.max(queued, atLeast);
    return;
  }
  run();
}

async function run() {
  busy = true;
  clearTimeout(timer);
  const res = await ask();
  busy = false;
  if (state === 'gone') return;

  const ok = res.status === 200 && res.data && res.data.ok === true && apply(res.data);
  if (ok) {
    clock.sample(res.data.serverTime, res.tripMs);
    fails = 0;
    reachable = true;
    if (state === 'loading') {
      state = 'live';
      reveal();
    }
  } else if (res.status === 404 && res.data && res.data.error === 'overlay_not_found') {
    leave();
    return;
  } else {
    // Сервер не ответил или ответил сбоем: что показано — остаётся, запрос повторится сам
    fails += 1;
    reachable = false;
  }
  report();

  const need = queued;
  queued = null;
  if (ok && need !== null && need > version) {
    run();
    return;
  }
  if (ok) plan(liveUp ? POLL_LIVE_MS : POLL_OFFLINE_MS);
  else plan(RETRY_STEPS_MS[Math.min(fails, RETRY_STEPS_MS.length) - 1]);
}

/* Ссылка больше не действует: владелец выпустил новую или площадку удалили.
   Сцена убирается целиком — ролики останавливаются, звук гаснет, — канал закрывается,
   и страница больше ни о чём не спрашивает сервер. */
function leave() {
  state = 'gone';
  clearTimeout(timer);
  clearTimeout(liveTimer);
  queued = null;
  if (live) live.close();
  live = null;
  liveUp = false;
  crowded = false;
  shown = new Map();
  view.setSources([]);
  report();
}

/* ---------- Живой канал ----------
   По нему приходит только сигнал «сцена изменилась» с номером версии и время сервера. */
function startLive() {
  if (state === 'gone') return;
  live = connectRealtime({
    channel: 'overlay',
    key: token,
    onStatus(st) {
      const up = st.state === 'connected';
      const wasUp = liveUp;
      liveUp = up;
      if (up) crowded = false;
      // Пока канала не было, сигналы могли пройти мимо — после подключения сверяемся
      if (up && !wasUp) sync();
      // Канал пропал — сверяемся сразу: так видно, жив ли сервер и действует ли ещё ссылка.
      // Дальше, пока канала нет, сцена сверяется часто
      else if (!up && wasUp) sync();
      report();
    },
    onMessage(msg) {
      if (!msg) return;
      if (msg.type === 'overlay:changed') {
        /* Изменение приложено к сигналу — применяем его сами. Не подошло (пропуск,
           повтор, слишком давно) — перечитываем сцену обычным запросом. */
        if (applyDelta(msg.delta, msg.version)) {
          report();
          return;
        }
        sync(typeof msg.version === 'number' ? msg.version : Infinity);
      } else if (msg.type === 'denied') {
        // Сервер закрыл канал. Почему — скажет обычный запрос: если ссылка отменена, сцена погаснет
        sync();
      } else if (msg.type === 'busy') {
        /* По этой ссылке уже открыто слишком много каналов. Сцена показывается и без канала —
           сверяется обычными запросами, — а в канал страница стучится редко, а не каждые секунды. */
        crowded = true;
        liveUp = false;
        if (live) live.close();
        live = null;
        clearTimeout(liveTimer);
        liveTimer = setTimeout(startLive, BUSY_RETRY_MS);
        report();
      } else if (msg.type === 'pong' && typeof msg.clientTs === 'number' && typeof msg.serverTime === 'number') {
        clock.sample(msg.serverTime, Math.max(0, Math.round(performance.now()) - msg.clientTs));
      }
    },
  });
}

/* ---------- Запуск ---------- */
if (checking) {
  document.documentElement.classList.add('overlay-check');
  document.title = 'Проверка оверлея — krafen studio';
  barEl.hidden = false;
  boundsEl.hidden = false;
}

window.addEventListener('resize', layout);
layout();
report();

if (state !== 'gone') {
  run();
  startLive();
  // Окно снова видно или вернулась сеть — сверяемся, не дожидаясь срока
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync();
  });
  window.addEventListener('online', () => sync());
}
