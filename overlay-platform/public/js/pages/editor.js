import { initAtmosphere } from '../core/atmosphere.js';
import { connectRealtime } from '../core/api.js';
import { bindLogout, liveBadge, showUserChip } from '../core/cabinet.js';
import { countOf } from '../core/format.js';
import { setFormError, withBusy } from '../core/forms.js';
import { describeError, fetchSession, goToLogin, send } from '../core/session.js';
import { bindModalDismiss, closeModal, initMobileNav, openModal, toast } from '../core/ui.js';
import { createLayers } from '../editor/layers.js';
import { createLibrary } from '../editor/library.js';
import { createPanel } from '../editor/panel.js';
import { createStage } from '../editor/stage.js';
import { createStore } from '../editor/store.js';
import { el, icon } from '../scene/dom.js';
import { SOURCE_LIST, sourceType } from '../scene/sources/index.js';
import { createSceneView } from '../scene/view.js';

/* Редактор сцены. Страница показывает сцену и отправляет серверу просьбы:
   «создай источник», «подвинь», «пусти таймер». Что из этого можно и что
   получилось в итоге, решает сервер — при каждом действии. Сама сцена рисуется
   тем же модулем (js/scene/view.js), что и оверлей в OBS. */

initAtmosphere();
initMobileNav();
bindModalDismiss();
bindLogout();

const $ = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Адрес страницы — /app/w/<номер площадки>/editor
const workspaceId = window.location.pathname.split('/').filter(Boolean)[2] || '';
const api = (suffix = '') => `/api/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;

/* Метка этой вкладки. Не право и не секрет: по ней страница узнаёт в рассылке
   «сцена изменилась» свою же правку и не перечитывает сцену лишний раз. */
const clientId = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => (byte % 36).toString(36)).join('');

const store = createStore({ workspaceId, clientId, notify: toast });

$('back-link').setAttribute('href', `/app/w/${encodeURIComponent(workspaceId)}`);

const SIZE_MIN = 8;
const SIZE_MAX = 8192;
const NAME_MAX = 40;

/* ---------- Состояния страницы ---------- */
function show(state) {
  for (const name of ['loading', 'ready', 'gone', 'offline']) {
    $(`state-${name}`).hidden = name !== state;
  }
  const ready = state === 'ready';
  $('library-open').disabled = !ready;
  $('add-open').disabled = !ready;
}

function showGone() {
  stopLive();
  // Открытые окна относились к площадке, которой для этого человека больше нет
  document.querySelectorAll('.modal.open').forEach((modal) => closeModal(modal.id));
  $('ws-name').textContent = 'Сцена недоступна';
  $('ws-role').hidden = true;
  $('save-status').hidden = true;
  $('upload-status').hidden = true;
  document.title = 'Сцена недоступна — krafen studio';
  show('gone');
}

/* ---------- Сцена ---------- */
const view = createSceneView($('scene'), {
  mode: 'editor',
  mediaUrl: store.mediaUrl,
  now: store.now,
});

function renderHeader() {
  const { workspace, scene } = store.state;
  if (!workspace) return;
  const isOwner = workspace.role === 'owner';
  document.title = `Сцена · ${workspace.name} — krafen studio`;
  $('ws-name').textContent = workspace.name; // название — как текст
  $('ws-role').className = `status-badge ${isOwner ? 'crimson' : 'muted'}`;
  $('ws-role').textContent = isOwner ? 'владелец' : 'модератор';
  $('ws-role').hidden = false;
  $('stage-size').textContent = `${scene.width} × ${scene.height}`;
  $('stage').setAttribute('aria-label', `Сцена ${scene.width} на ${scene.height} точек`);
}

store.on('change', (detail) => {
  if (detail.kind === 'all') {
    const { width, height } = store.state.scene;
    view.setSize(width, height);
    view.setSources(store.state.sources);
    renderHeader();
  } else if (detail.kind === 'source') {
    const source = store.find(detail.id);
    if (source) view.updateSource(source);
  }
});

/* ---------- Сохранено ли ---------- */
const SAVE_STATES = {
  saved: ['ok', 'сохранено', 'Все правки сохранены на сервере'],
  saving: ['amber', 'сохраняю…', 'Правки отправляются на сервер'],
  offline: ['crimson', 'не сохранено', 'Нет связи с сервером. Правки остаются на странице и отправятся сами, когда связь вернётся'],
};

function showSave(state) {
  const badge = $('save-status');
  const info = SAVE_STATES[state];
  badge.hidden = !info;
  if (!info) return;
  const [tone, text, hint] = info;
  badge.className = `status-badge ${tone}`;
  badge.replaceChildren(el('span', 'dot'), el('span', '', text));
  badge.title = hint;
}
store.on('save', showSave);
store.on('gone', showGone);

/* ---------- Окно подтверждения ---------- */
const confirmSubmit = $('confirm-submit');
const confirmError = $('confirm-error');
let confirmJob = null;

function askConfirm({ eyebrow, title, text, action, busy, run, done }) {
  $('confirm-eyebrow').textContent = eyebrow;
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  confirmSubmit.textContent = action;
  setFormError(confirmError, '');
  confirmJob = { busy, run, done };
  openModal('modal-confirm');
}

confirmSubmit.addEventListener('click', () => {
  const job = confirmJob;
  if (!job) return;
  withBusy(confirmSubmit, job.busy, async () => {
    const result = await job.run();
    // Команды сцены отвечают «да / нет» и сами показывают причину отказа; запросы — ответом сервера
    const failed = result && typeof result === 'object' && result.ok === false;
    if (failed && result.status !== 401 && result.data?.error !== 'workspace_not_found') {
      setFormError(confirmError, describeError(result));
      return;
    }
    confirmJob = null;
    closeModal('modal-confirm');
    if (result === true || result?.ok === true) job.done?.(result);
  });
});

/* ---------- Действия с источниками ---------- */
function askDelete(sourceId) {
  const source = store.find(sourceId);
  if (!source) return;
  askConfirm({
    eyebrow: 'это нельзя отменить',
    title: 'Удалить источник?',
    text: `Источник «${source.name}» исчезнет со сцены — и в редакторе, и в эфире. Вернуть его будет нельзя.`
      + (source.file ? ' Его файл останется в списке файлов площадки.' : ''),
    action: 'Удалить',
    busy: 'Удаляю…',
    run: () => store.remove(sourceId),
    done: () => stageApi.focus(),
  });
}

async function duplicate(sourceId) {
  const copy = await store.duplicate(sourceId);
  if (copy) store.select(copy.id);
}

/* ---------- Файл источника и его размер ---------- */

/* Какую рамку дать источнику под файл с такими пропорциями.
   fit: 'natural' — размер самого файла (но не больше сцены): так встаёт первый файл;
        'inside'  — вписать в нынешнюю рамку: так встаёт файл на замену. */
function boxFor(box, fileWidth, fileHeight, fit) {
  const { width: sceneWidth, height: sceneHeight } = store.state.scene;
  const limit = fit === 'inside' ? { width: box.width, height: box.height } : { width: sceneWidth, height: sceneHeight };
  const scale = Math.min(limit.width / fileWidth, limit.height / fileHeight, fit === 'inside' ? Infinity : 1);
  const width = clamp(Math.round(fileWidth * scale), SIZE_MIN, SIZE_MAX);
  const height = clamp(Math.round(fileHeight * scale), SIZE_MIN, SIZE_MAX);
  // Середина рамки остаётся на месте
  return {
    x: Math.round(box.x + (box.width - width) / 2),
    y: Math.round(box.y + (box.height - height) / 2),
    width,
    height,
  };
}

// Размер видео сервер не знает — его называет сам браузер, прочитав начало ролика
function readVideoSize(url) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let finished = false;
    const done = (size) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      resolve(size);
    };
    const timer = setTimeout(() => done(null), 8000);
    video.preload = 'metadata';
    video.muted = true;
    video.addEventListener('loadedmetadata', () => {
      done(video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : null);
    });
    video.addEventListener('error', () => done(null));
    video.src = url;
  });
}

const boxOf = (source) => ({ x: source.x, y: source.y, width: source.width, height: source.height });
const sameBox = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

async function fitToVideo(sourceId, fileId, fit) {
  const before = store.find(sourceId);
  if (!before) return;
  const startBox = boxOf(before);
  const size = await readVideoSize(store.mediaUrl(fileId));
  const source = store.find(sourceId);
  // Пока читали ролик, человек мог сам подвинуть источник, сменить файл или включить защиту — тогда не вмешиваемся
  if (!size || !source || source.file !== fileId || source.locked || !sameBox(boxOf(source), startBox)) return;
  store.change(sourceId, boxFor(source, size.width, size.height, fit), { soon: true });
}

// Человек выбрал файл для источника
function applyFile(sourceId, file) {
  const source = store.find(sourceId);
  if (!source) return;
  const fit = source.file ? 'inside' : 'natural';
  const patch = { file: file.id };
  // Рамка принимает пропорции файла. Защищённый от сдвига источник остаётся как был
  if (!source.locked && file.width && file.height) Object.assign(patch, boxFor(source, file.width, file.height, fit));
  store.change(sourceId, patch, { soon: true });
  store.select(sourceId);
  if (!source.locked && file.kind === 'video') fitToVideo(sourceId, file.id, fit);
}

/* ---------- Файлы, перенесённые мышью на сцену ----------
   Каждый загружается и сразу встаёт на сцену источником своего вида. */
// Название файла для уведомления: длинное обрезается
const shortName = (name) => ([...name].length > 40 ? `${[...name].slice(0, 39).join('')}…` : name);

function nameFromFile(fileName) {
  const base = String(fileName || '').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
  return [...base].slice(0, NAME_MAX).join('').trim();
}

async function placeFiles(files, point) {
  const { files: uploaded, failed } = await library.uploadFiles(files);
  // Окно файлов закрыто — о неудаче говорим здесь; подробности по каждому файлу остаются в окне
  if (failed.length === 1) {
    toast(`«${shortName(failed[0].name)}» не загружен. ${failed[0].message}`, 'error');
  } else if (failed.length > 1) {
    toast(`Не загружено: ${countOf(failed.length, ['файл', 'файла', 'файлов'])}. Причины — в окне «Файлы».`, 'error');
  }
  const { width: sceneWidth, height: sceneHeight } = store.state.scene;
  let shift = 0;
  let last = null;
  for (const file of uploaded) {
    const module = sourceType(file.kind); // вид файла и тип источника называются одинаково: image, gif, video
    if (!module) continue;
    const size = file.width && file.height
      ? boxFor({ x: 0, y: 0, width: 0, height: 0 }, file.width, file.height, 'natural')
      : module.size;
    // Середина источника — там, где отпустили файл; целиком на сцене, если помещается
    const props = {
      file: file.id,
      width: size.width,
      height: size.height,
      x: clamp(Math.round(point.x - size.width / 2) + shift, Math.min(0, sceneWidth - size.width), Math.max(0, sceneWidth - size.width)),
      y: clamp(Math.round(point.y - size.height / 2) + shift, Math.min(0, sceneHeight - size.height), Math.max(0, sceneHeight - size.height)),
    };
    const name = nameFromFile(file.name);
    if (name) props.name = name;
    const created = await store.create(module.type, props);
    if (!created) break;
    last = created;
    shift += 24;
    if (file.kind === 'video') fitToVideo(created.id, file.id, 'natural');
  }
  if (last) store.select(last.id);
}

/* ---------- Части редактора ---------- */
const library = createLibrary({
  store,
  els: {
    eyebrow: $('library-eyebrow'),
    title: $('library-title'),
    usageFiles: $('usage-files'),
    usageBytes: $('usage-bytes'),
    meter: $('usage-meter'),
    input: $('file-input'),
    pickButton: $('upload-pick'),
    hint: $('upload-hint'),
    uploads: $('upload-list'),
    filter: $('library-filter'),
    grid: $('file-grid'),
    empty: $('library-empty'),
  },
  show: () => openModal('modal-library'),
  hide: () => closeModal('modal-library'),
  notify: toast,
  confirm: askConfirm,
  onPicked: applyFile,
  // Файл загружали для конкретного источника — сразу ставим его туда
  onUploaded(files, { forSource }) {
    if (!forSource || !files.length || !store.find(forSource)) return;
    closeModal('modal-library');
    applyFile(forSource, files[0]);
  },
  onUploadsChange(uploads) {
    const active = uploads.filter((item) => item.status === 'waiting' || item.status === 'uploading');
    const badge = $('upload-status');
    badge.hidden = active.length === 0;
    if (!active.length) return;
    const current = active.find((item) => item.status === 'uploading');
    const share = current ? ` · ${Math.round(current.progress * 100)}%` : '';
    badge.replaceChildren(el('span', 'dot'), el('span', '', `загрузка: ${countOf(active.length, ['файл', 'файла', 'файлов'])}${share}`));
  },
});

const panel = createPanel({
  store,
  body: $('props-body'),
  empty: $('props-empty'),
  onPickFile: (source) => library.open({ sourceId: source.id }),
  onDelete: askDelete,
  onDuplicate: duplicate,
});

const stageApi = createStage({
  store,
  stage: $('stage'),
  frame: $('stage-frame'),
  sceneRoot: $('scene'),
  overlay: $('stage-overlay'),
  onEdit(sourceId) {
    store.select(sourceId);
    showPanel('props');
    panel.focusMain();
  },
  onDelete: askDelete,
  onDuplicate: duplicate,
  onFiles: placeFiles,
});

createLayers({
  store,
  list: $('layer-list'),
  empty: $('layers-empty'),
  count: $('layers-count'),
  buttons: {
    top: $('layer-top'),
    up: $('layer-up'),
    down: $('layer-down'),
    bottom: $('layer-bottom'),
    copy: $('layer-copy'),
    remove: $('layer-remove'),
  },
  onDelete: askDelete,
  onDuplicate: duplicate,
});

/* ---------- Слои и свойства на узком экране: по очереди ----------
   Вкладку меняет сам человек. Редактор переключает её только там, где следующий шаг
   очевиден: источник только что добавили или по нему щёлкнули дважды — нужны его свойства. */
const grid = $('state-ready');

function showPanel(name) {
  grid.classList.toggle('show-layers', name === 'layers');
  grid.classList.toggle('show-props', name === 'props');
  for (const [key, id] of [['layers', 'tab-layers'], ['props', 'tab-props']]) {
    $(id).classList.toggle('active', key === name);
    $(id).setAttribute('aria-pressed', String(key === name));
  }
}
$('tab-layers').addEventListener('click', () => showPanel('layers'));
$('tab-props').addEventListener('click', () => showPanel('props'));

/* ---------- Новый источник ---------- */
$('add-list').replaceChildren(...SOURCE_LIST.map((module) => {
  const item = el('li');
  const button = el('button', 'type-tile');
  button.type = 'button';
  const text = el('span', 'type-tile-text');
  text.append(el('span', 'type-tile-title', module.title), el('span', 'type-tile-about', module.about));
  button.append(icon(module.icon), text);
  button.addEventListener('click', async () => {
    closeModal('modal-add');
    const created = await store.create(module.type);
    if (!created) return;
    store.select(created.id);
    showPanel('props');
    // Источнику нужен файл — сразу предлагаем его выбрать
    if (module.media) library.open({ sourceId: created.id });
    else stageApi.focus();
  });
  item.append(button);
  return item;
}));

$('add-open').addEventListener('click', () => openModal('modal-add'));
$('library-open').addEventListener('click', () => library.open());

/* ---------- Файл, перенесённый мимо сцены ----------
   Без этого браузер открыл бы файл вместо редактора — и несохранённое пропало бы. */
const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');

window.addEventListener('dragover', (event) => {
  if (!carriesFiles(event) || event.defaultPrevented) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = $('modal-library').classList.contains('open') ? 'copy' : 'none';
});
window.addEventListener('drop', (event) => {
  if (!carriesFiles(event) || event.defaultPrevented) return;
  event.preventDefault();
  // Окно файлов открыто — перенесённое в него загружается
  if ($('modal-library').classList.contains('open') && event.dataTransfer.files.length) {
    library.addFromDevice(event.dataTransfer.files);
  }
});

/* ---------- Живой канал ----------
   Перед каждым подключением страница получает одноразовый пропуск обычным запросом —
   там сервер проверяет вход и права. По каналу приходит только сигнал «сцена
   изменилась» с номером версии; саму сцену страница запрашивает заново. */
const showLiveStatus = liveBadge($('live-status'));
let live = null;
let liveState = '';

function startLive() {
  if (live) return;
  live = connectRealtime({
    channel: `workspace:${workspaceId}`,
    async ticket() {
      const res = await send(api('/live'));
      if (res.ok) return { ticket: res.data.ticket };
      if (res.status === 401 || res.status === 403 || res.status === 404) return { denied: true };
      return null; // сервер не ответил — канал попробует позже
    },
    onStatus(st) {
      showLiveStatus(st);
      // Пока связи не было, изменения могли пройти мимо — после каждого подключения сверяемся.
      // Отказ в доступе тоже проверяем обычным запросом: он скажет, что именно случилось
      const reconnected = st.state === 'connected' && liveState !== 'connected';
      liveState = st.state;
      if (reconnected) store.wake();
      if (reconnected || st.state === 'denied') store.refresh();
    },
    onMessage(msg) {
      if (msg?.type === 'workspace:changed') {
        // Сцену меняли — сверяем версию; меняли саму площадку (название, команда) — перечитываем
        if (msg.what === 'scene') store.signal(msg);
        else store.refresh();
      } else if (msg?.type === 'denied') {
        store.refresh();
      } else if (msg?.type === 'pong' && typeof msg.clientTs === 'number' && typeof msg.serverTime === 'number') {
        // Часы сервера: по ним идут таймеры на сцене
        store.syncClock(msg.serverTime, Math.max(0, Math.round(performance.now()) - msg.clientTs));
      }
    },
  });
}

function stopLive() {
  live?.close();
  live = null;
  liveState = '';
  showLiveStatus({ state: 'denied' });
}

/* ---------- Запуск ---------- */
async function start() {
  show('loading');
  const result = await store.load();
  if (result === 'ok') {
    show('ready');
    showSave(store.saveState);
    stageApi.fit();
    startLive();
  } else if (result === 'gone') {
    showGone();
  } else if (result === 'offline') {
    show('offline');
  }
  // 'login' — страница уже уходит на вход
}

$('state-retry').addEventListener('click', () => {
  withBusy($('state-retry'), 'Загружаем…', start);
});

async function showWhoIsHere() {
  const session = await fetchSession();
  if (session.reachable && !session.authenticated) goToLogin();
  else if (session.authenticated) showUserChip(session.user);
}

showWhoIsHere();
start();

/* ---------- Уход со страницы ---------- */
// Вкладку свернули или закрывают — отправляем правки, не дожидаясь паузы
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    store.flushUrgent();
  } else if (store.state.ready) {
    // Вкладку открыли снова — сверяемся: за это время сцену могли изменить
    store.wake();
    store.refresh();
  }
});
window.addEventListener('pagehide', () => store.flushUrgent());
window.addEventListener('online', () => store.wake());
// Страницу вернули кнопкой «Назад» из памяти браузера — сцена на ней могла устареть
window.addEventListener('pageshow', (event) => {
  if (event.persisted && store.state.ready) store.refresh();
});
// Осталось несохранённое или идёт загрузка файла — браузер переспросит, прежде чем закрыть
window.addEventListener('beforeunload', (event) => {
  if (!store.hasUnsaved() && !library.busy()) return;
  store.flushUrgent();
  event.preventDefault();
  event.returnValue = '';
});
