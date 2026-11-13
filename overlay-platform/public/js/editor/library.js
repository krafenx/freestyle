import { countOf, formatBytes } from '../core/format.js';
import { describeError } from '../core/session.js';
import { el, icon } from '../scene/dom.js';
import { ACCEPT_ATTRIBUTE, HEAD_BYTES, sniffFile } from '../scene/sniff.js';
import { sourceType } from '../scene/sources/index.js';
import { ICONS } from './icons.js';

/* ==========================================================================
   Файлы площадки: загрузка, список, выбор файла для источника, удаление.

   Перед отправкой страница сама смотрит на начало файла и на его размер — чтобы
   сразу сказать человеку, что не так, а не после минуты загрузки. Решает всё
   равно сервер: той же функцией, по тем байтам, которые реально пришли.
   ========================================================================== */

const KIND_TITLES = { image: 'Картинки', gif: 'GIF', video: 'Видео' };
const KIND_ONE = { image: 'картинка', gif: 'GIF', video: 'видео' };
const KEEP_DONE_MS = 4000; // сколько строка удачной загрузки остаётся в списке

export function createLibrary({ store, els, show, hide, notify, confirm, onPicked, onUploaded, onUploadsChange }) {
  let pickFor = null; // номер источника, для которого выбирают файл; null — просто список
  let kinds = null; // какие файлы подходят этому источнику
  let filter = 'all';
  let uploads = []; // { id, name, size, progress, status, message, seen }
  let uploadSerial = 0;
  let queue = Promise.resolve();

  // Пока окно закрыто, список не перерисовывается: он соберётся заново при открытии
  const modal = els.grid.closest('.modal');
  const isOpen = () => Boolean(modal?.classList.contains('open'));
  let drawnFiles = ''; // что сейчас нарисовано в списке файлов

  els.input.accept = ACCEPT_ATTRIBUTE;

  /* ---------- Сколько занято ---------- */
  function renderUsage() {
    const { usage, limits } = store.state;
    if (!usage || !limits) return;
    els.usageFiles.textContent = `${usage.files} из ${limits.files}`;
    els.usageBytes.textContent = `${formatBytes(usage.storageBytes)} из ${formatBytes(limits.storageBytes)}`;
    const share = limits.storageBytes > 0 ? Math.min(100, (usage.storageBytes / limits.storageBytes) * 100) : 0;
    els.meter.style.width = `${share}%`;
    els.meter.classList.toggle('full', share >= 90);
    const { image, gif, video } = limits.fileBytes;
    els.hint.textContent =
      `PNG, JPEG и WebP — до ${formatBytes(image)}, GIF — до ${formatBytes(gif)}, MP4 и WebM — до ${formatBytes(video)}. `
      + 'SVG не принимается: внутри него может быть код.';
  }

  /* ---------- Список файлов ---------- */
  const usedBy = (fileId) => store.state.sources.filter((source) => source.file === fileId).length;

  function describe(file) {
    const format = file.mime.split('/')[1].toUpperCase();
    const size = file.width && file.height ? ` · ${file.width} × ${file.height}` : '';
    return `${format}${size} · ${formatBytes(file.size)}`;
  }

  function tile(file) {
    const item = el('li', 'file-tile');
    const thumb = el('div', 'file-thumb large');
    if (file.kind === 'video') {
      thumb.append(icon(sourceType('video').icon));
    } else {
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = store.mediaUrl(file.id);
      thumb.append(img);
    }

    const used = usedBy(file.id);
    const info = el('div', 'file-info');
    info.append(
      el('div', 'file-name', file.name), // название — как текст
      el('div', 'file-meta', describe(file)),
      el('div', 'file-meta', used > 0 ? `на сцене: ${countOf(used, ['источник', 'источника', 'источников'])}` : 'на сцене не используется')
    );

    const actions = el('div', 'file-actions');
    if (pickFor) {
      const pick = el('button', 'btn-primary sm', 'Выбрать');
      pick.type = 'button';
      pick.setAttribute('aria-label', `Выбрать файл: ${file.name}`);
      pick.addEventListener('click', () => choose(file));
      actions.append(pick);
    }
    const remove = el('button', 'btn-action', 'Удалить');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Удалить файл: ${file.name}`);
    remove.addEventListener('click', () => askRemove(file));
    actions.append(remove);

    item.append(thumb, info, actions);
    return item;
  }

  /* Кнопки «все / картинки / GIF / видео». Создаются один раз, дальше меняются только
     отметка и числа: кнопка, на которой стоит фокус, остаётся той же кнопкой. */
  const filterPills = [['all', 'Все'], ...Object.entries(KIND_TITLES)].map(([value, label]) => {
    const pill = el('button', 'filter-pill');
    pill.type = 'button';
    const count = el('strong');
    pill.append(el('span', '', label), count);
    pill.addEventListener('click', () => {
      filter = value;
      renderFiles();
    });
    els.filter.append(pill);
    return { value, pill, count };
  });

  function renderFilter() {
    els.filter.hidden = Boolean(kinds);
    if (kinds) return;
    for (const { value, pill, count } of filterPills) {
      const active = filter === value;
      pill.classList.toggle('active', active);
      pill.setAttribute('aria-pressed', String(active));
      const n = value === 'all' ? store.state.media.length : store.state.media.filter((file) => file.kind === value).length;
      count.textContent = String(n);
    }
  }

  function renderFiles() {
    renderFilter();
    const fits = (file) => (kinds ? kinds.includes(file.kind) : filter === 'all' || file.kind === filter);
    const files = store.state.media.filter(fits);
    /* Плитки пересобираются, только когда изменилось то, что на них написано. Иначе при
       каждой правке сцены другим участником картинки в окне мигали бы, а фокус терялся. */
    const signature = JSON.stringify([pickFor, files.map((file) => [file.id, usedBy(file.id)])]);
    if (signature !== drawnFiles) {
      drawnFiles = signature;
      els.grid.replaceChildren(...files.map(tile));
    }
    els.empty.hidden = files.length > 0;
    if (!files.length) {
      els.empty.textContent = kinds
        ? `Подходящих файлов пока нет. Загрузите ${store.find(pickFor) ? sourceType(store.find(pickFor).type).media.formats : 'файл'} — он появится здесь.`
        : store.state.media.length
          ? 'Файлов такого вида нет.'
          : 'Файлов пока нет. Загрузите картинку, GIF или видео — и поставьте на сцену.';
    }
  }

  function render() {
    renderUsage();
    renderFiles();
  }

  /* ---------- Выбор файла для источника ---------- */
  function choose(file) {
    const source = store.find(pickFor);
    if (!source) {
      notify('Этого источника уже нет.', 'error');
      hide();
      return;
    }
    hide();
    onPicked(source.id, file);
  }

  /* ---------- Удаление ---------- */
  function askRemove(file) {
    const used = usedBy(file.id);
    if (used > 0) {
      notify(`Файл показывается на сцене (${countOf(used, ['источник', 'источника', 'источников'])}). Сначала уберите его оттуда.`, 'error');
      return;
    }
    confirm({
      eyebrow: 'это нельзя отменить',
      title: 'Удалить файл?',
      text: `Файл «${file.name}» будет удалён с сервера. Вернуть его можно будет только новой загрузкой.`,
      action: 'Удалить',
      busy: 'Удаляю…',
      run: () => store.removeMedia(file.id),
      done: () => notify('Файл удалён', 'ok'),
    });
  }

  /* ---------- Загрузка ---------- */
  function renderUploads() {
    onUploadsChange?.(uploads);
    els.uploads.hidden = uploads.length === 0;
    els.uploads.replaceChildren(...uploads.map((item) => {
      const row = el('li', `upload-row ${item.status}`);
      const head = el('div', 'upload-head');
      const state = {
        waiting: 'в очереди',
        uploading: `${Math.round(item.progress * 100)}%`,
        done: 'загружен',
        error: 'не загружен',
      }[item.status];
      head.append(el('span', 'upload-name', item.name), el('span', 'upload-state', state));
      const bar = el('div', 'meter');
      const fill = el('div', 'meter-fill');
      fill.style.width = `${item.status === 'done' ? 100 : Math.round(item.progress * 100)}%`;
      bar.append(fill);
      row.append(head, bar);
      if (item.message) row.append(el('div', 'upload-message', item.message));
      return row;
    }));
  }

  // Что не так с файлом — ещё до отправки. null — на вид всё в порядке.
  // wanted — какие виды файлов нужны (когда файл загружают для конкретного источника)
  async function precheck(file, wanted) {
    const { limits, usage } = store.state;
    if (!file.size) return 'Файл пустой.';
    let found = null;
    try {
      found = sniffFile(new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer()));
    } catch {
      return 'Не удалось прочитать файл с диска.';
    }
    if (!found) return 'Такой файл не подходит. Принимаются PNG, JPEG, WebP, GIF, MP4 и WebM.';
    if (wanted && !wanted.kinds.includes(found.kind)) return `Этому источнику нужен другой файл: ${wanted.formats}.`;
    const limit = limits.fileBytes[found.kind];
    if (file.size > limit) return `Файл слишком большой: ${formatBytes(file.size)}. Для этого вида (${KIND_ONE[found.kind]}) — до ${formatBytes(limit)}.`;
    if (usage.files >= limits.files) {
      return `На площадке уже ${countOf(limits.files, ['файл', 'файла', 'файлов'])} — больше нельзя. Удалите ненужные.`;
    }
    if (usage.storageBytes + file.size > limits.storageBytes) {
      return `Не хватает места: на площадку даётся ${formatBytes(limits.storageBytes)}. Удалите ненужные файлы.`;
    }
    return null;
  }

  // Загрузка не удалась. seen — видел ли человек эту строку: окно в этот момент могло быть закрыто
  function fail(item, message) {
    item.status = 'error';
    item.message = message;
    item.seen = isOpen();
    renderUploads();
    return null;
  }

  async function uploadOne(item, file, wanted) {
    const problem = await precheck(file, wanted);
    if (problem) return fail(item, problem);
    item.status = 'uploading';
    renderUploads();
    const res = await store.upload(file, {
      onProgress(share) {
        item.progress = share;
        renderUploads();
      },
    });
    if (!res.ok) return fail(item, describeError(res));
    item.status = 'done';
    item.progress = 1;
    renderUploads();
    // Удачная загрузка в списке не задерживается; неудачная остаётся, пока её не увидят в окне
    setTimeout(() => {
      uploads = uploads.filter((other) => other !== item);
      renderUploads();
    }, KEEP_DONE_MS);
    return res.data.file;
  }

  /* Файлы загружаются по одному, в том порядке, в каком их выбрали. Возвращает
     { files, failed }: что сервер принял и что не загрузилось (название и причина). */
  function uploadFiles(fileList, { wanted = null } = {}) {
    const files = [...fileList];
    if (!files.length) return Promise.resolve({ files: [], failed: [] });
    uploads = uploads.filter((item) => item.status !== 'error'); // новая загрузка — прежние неудачи уходят
    const items = files.map((file) => {
      uploadSerial += 1;
      return { id: uploadSerial, name: file.name || 'Без названия', size: file.size, progress: 0, status: 'waiting', message: '', seen: false };
    });
    uploads = [...uploads, ...items];
    renderUploads();

    const run = async () => {
      const done = [];
      const failed = [];
      for (let i = 0; i < files.length; i += 1) {
        const uploaded = await uploadOne(items[i], files[i], wanted);
        if (uploaded) done.push(uploaded);
        else failed.push({ name: items[i].name, message: items[i].message });
      }
      return { files: done, failed };
    };
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  }

  // Файлы, выбранные в окне или перенесённые на него мышью
  async function addFromDevice(fileList) {
    const forSource = pickFor;
    const module = forSource ? sourceType(store.find(forSource)?.type) : null;
    // Для источника нужен один файл: лишние не загружаем, чтобы не занимать место зря
    const files = forSource ? [...fileList].slice(0, 1) : [...fileList];
    const { files: done } = await uploadFiles(files, { wanted: module?.media || null });
    onUploaded?.(done, { forSource });
  }

  els.pickButton.addEventListener('click', () => els.input.click());
  els.input.addEventListener('change', () => {
    const files = [...els.input.files];
    els.input.value = ''; // тот же файл можно выбрать ещё раз
    addFromDevice(files);
  });

  store.on('change', (detail) => {
    if (detail.kind === 'select' || !isOpen()) return;
    render();
  });

  return {
    // sourceId — выбрать файл для этого источника; без него — просто список файлов
    open({ sourceId = null } = {}) {
      const source = sourceId ? store.find(sourceId) : null;
      const module = source ? sourceType(source.type) : null;
      pickFor = module?.media ? source.id : null;
      kinds = module?.media ? module.media.kinds : null;
      filter = 'all';
      // Неудачная загрузка показывается в окне один раз: виденное в прошлый раз убираем
      uploads = uploads.filter((item) => !(item.status === 'error' && item.seen));
      for (const item of uploads) {
        if (item.status === 'error') item.seen = true;
      }
      els.eyebrow.textContent = pickFor ? `файл для источника · ${module.title.toLowerCase()}` : 'файлы площадки';
      els.title.textContent = pickFor ? source.name : 'Файлы';
      els.pickButton.textContent = pickFor ? 'Загрузить с компьютера' : 'Загрузить файлы';
      els.input.multiple = !pickFor;
      render();
      renderUploads();
      show();
    },
    uploadFiles,
    addFromDevice,
    // Идёт ли загрузка: страница предупреждает, если её пытаются закрыть
    busy: () => uploads.some((item) => item.status === 'waiting' || item.status === 'uploading'),
  };
}
