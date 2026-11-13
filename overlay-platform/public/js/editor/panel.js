import { formatBytes } from '../core/format.js';
import { el, icon } from '../scene/dom.js';
import { isShown } from '../scene/schema.js';
import { sourceType } from '../scene/sources/index.js';
import { ICONS } from './icons.js';

/* ==========================================================================
   Панель свойств выбранного источника.

   Общая часть (название, положение, размер, прозрачность, видимость, защита,
   файл) одинакова для всех типов. Остальное панель собирает из описания
   настроек в модуле типа — тех же самых полей, по которым сервер проверяет
   присланное. Поэтому у нового типа панель появляется сама.

   Поле, в котором человек сейчас печатает, панель не трогает: ответ сервера
   обновляет остальные, а это — когда из него уйдут.
   ========================================================================== */

const POSITION_MAX = 8192;
const SIZE_MIN = 8;
const SIZE_MAX = 8192;
const NAME_MAX = 40;

/* Набранное с клавиатуры уходит на сервер после паузы подлиннее — или сразу, когда человек
   вышел из поля либо нажал Enter. Иначе в эфире мелькали бы недописанные значения:
   «12» на пути к «1200», половина слова. На странице правка видна сразу. */
const TYPING = { delay: 900 };

let serial = 0;
const nextId = () => `prop-${(serial += 1)}`;

const withUnit = (value, unit) => (!unit ? String(value) : unit === '%' || unit === '°' ? `${value}${unit}` : `${value} ${unit}`);

export function createPanel({ store, body, empty, onPickFile, onDelete, onDuplicate }) {
  let shownId = null;
  let shownType = null;
  let syncers = []; // функции, приводящие поля панели в соответствие с источником
  let statusTimer = null;
  const openGroups = new Map(); // какие группы человек развернул или свернул

  const current = () => store.find(shownId);
  const setCommon = (patch, options) => store.change(shownId, patch, options);
  const setSetting = (key, value, options) => store.change(shownId, { settings: { [key]: value } }, options);
  const idle = (input) => document.activeElement !== input;

  /* ---------- Кирпичики ---------- */

  function labeled(labelText, control, { hint, readout } = {}) {
    const wrap = el('div', 'field');
    const label = el('label', 'field-label');
    label.htmlFor = control.id;
    label.append(el('span', '', labelText));
    if (readout) label.append(readout);
    wrap.append(label, control);
    if (hint) wrap.append(el('div', 'field-hint', hint));
    return wrap;
  }

  /* Число. Пока человек печатает, применяются только допустимые значения: пустое поле,
     «-» или число вне границ ошибкой не считаются. Когда он выходит из поля или нажимает
     Enter, набранное приводится к границам (99999 → наибольшее допустимое), а пустое поле
     возвращается к сохранённому. */
  function numberInput({ min, max, get, set, signed = false, disabledWhen }) {
    const input = el('input', 'kf-input studio mono-val');
    input.id = nextId();
    input.type = 'number';
    input.step = '1';
    input.min = String(min);
    input.max = String(max);
    if (!signed) input.inputMode = 'numeric';
    const typed = () => (input.value.trim() === '' ? NaN : Math.round(Number(input.value)));
    input.addEventListener('input', () => {
      const value = typed();
      if (!Number.isFinite(value) || value < min || value > max) return;
      set(value, TYPING);
    });
    const commit = () => {
      const source = current();
      // Поле уже убрано со страницы (панель показывает другой источник) — его значение никому не нужно
      if (!source || !input.isConnected) return;
      const value = typed();
      if (Number.isFinite(value) && !input.disabled) {
        const bounded = Math.min(max, Math.max(min, value));
        if (bounded !== get(source)) set(bounded, TYPING);
      }
      input.value = String(get(current()));
      store.flush();
    };
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    syncers.push((source) => {
      if (idle(input)) input.value = String(get(source));
      if (disabledWhen) input.disabled = disabledWhen(source);
    });
    return input;
  }

  function rangeInput({ label, min, max, unit, get, set, hint }) {
    const input = el('input', 'kf-range');
    input.id = nextId();
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    const readout = el('strong', 'field-value');
    const paint = (value) => {
      input.style.setProperty('--fill', `${max > min ? ((value - min) / (max - min)) * 100 : 0}%`);
      readout.textContent = withUnit(value, unit);
    };
    input.addEventListener('input', () => {
      const value = Number(input.value);
      paint(value);
      set(value);
    });
    syncers.push((source) => {
      const value = get(source);
      if (idle(input)) input.value = String(value);
      paint(idle(input) ? value : Number(input.value));
    });
    return labeled(label, input, { hint, readout });
  }

  function switchInput({ label, get, set, hint }) {
    const wrap = el('div', 'field');
    const row = el('label', 'kf-switch');
    const input = el('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => set(input.checked));
    row.append(input, el('span', 'kf-switch-track'), el('span', '', label));
    wrap.append(row);
    if (hint) wrap.append(el('div', 'field-hint', hint));
    syncers.push((source) => {
      input.checked = Boolean(get(source));
    });
    return wrap;
  }

  function selectInput({ label, options, get, set, hint }) {
    const input = el('select', 'kf-select studio');
    input.id = nextId();
    options.forEach((option, index) => {
      const item = el('option', '', option.label);
      item.value = String(index); // значение может быть числом — восстанавливаем его по номеру
      input.append(item);
    });
    input.addEventListener('change', () => set(options[Number(input.value)].value));
    syncers.push((source) => {
      if (idle(input)) input.value = String(Math.max(0, options.findIndex((option) => option.value === get(source))));
    });
    return labeled(label, input, { hint });
  }

  function pillsInput({ label, options, get, set, hint }) {
    const wrap = el('div', 'field');
    const title = el('div', 'field-label', label);
    title.id = nextId();
    const row = el('div', 'pill-row');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-labelledby', title.id);
    const pills = options.map((option) => {
      const pill = el('button', 'filter-pill', option.label);
      pill.type = 'button';
      pill.addEventListener('click', () => set(option.value));
      row.append(pill);
      return pill;
    });
    wrap.append(title, row);
    if (hint) wrap.append(el('div', 'field-hint', hint));
    syncers.push((source) => {
      const value = get(source);
      pills.forEach((pill, index) => {
        const active = options[index].value === value;
        pill.classList.toggle('active', active);
        pill.setAttribute('aria-pressed', String(active));
      });
    });
    return wrap;
  }

  function colorInput({ label, get, set, hint }) {
    const picker = el('input', 'kf-color');
    picker.id = nextId();
    picker.type = 'color';
    const text = el('input', 'kf-input studio mono-val');
    text.type = 'text';
    text.maxLength = 7;
    text.spellcheck = false;
    text.autocomplete = 'off';
    text.setAttribute('aria-label', `${label}: код цвета`);
    picker.addEventListener('input', () => {
      text.value = picker.value;
      set(picker.value);
    });
    text.addEventListener('input', () => {
      const value = text.value.trim().toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(value)) return;
      picker.value = value;
      set(value);
    });
    text.addEventListener('blur', () => {
      const source = current();
      if (source) text.value = get(source);
    });
    const row = el('div', 'color-row');
    row.append(picker, text);
    const wrap = labeled(label, row, { hint });
    wrap.querySelector('label').htmlFor = picker.id;
    syncers.push((source) => {
      const value = get(source);
      if (idle(picker)) picker.value = value;
      if (idle(text)) text.value = value;
    });
    return wrap;
  }

  function textInput({ label, max, area = false, code = false, get, set, hint }) {
    const input = el(area || code ? 'textarea' : 'input', area || code ? `kf-area studio${code ? ' code' : ''}` : 'kf-input studio');
    input.id = nextId();
    if (!area && !code) input.type = 'text';
    if (code) {
      input.spellcheck = false;
      input.setAttribute('autocapitalize', 'off');
    }
    input.maxLength = max;
    input.autocomplete = 'off';
    const counter = code ? el('strong', 'field-value') : null;
    const count = () => {
      if (counter) counter.textContent = `${[...input.value].length.toLocaleString('ru-RU')} / ${max.toLocaleString('ru-RU')}`;
    };
    input.addEventListener('input', () => {
      count();
      set(input.value, TYPING);
    });
    input.addEventListener('change', () => store.flush()); // вышли из поля — сохраняем, не дожидаясь паузы
    syncers.push((source) => {
      if (idle(input)) input.value = get(source);
      count();
    });
    return labeled(label, input, { hint, readout: counter });
  }

  // Время отсчёта: часы, минуты, секунды → одно число секунд
  function durationInput({ label, min, max, get, set, hint }) {
    const wrap = el('div', 'field');
    const title = el('div', 'field-label', label);
    title.id = nextId();
    const grid = el('div', 'duration-row');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-labelledby', title.id);
    const parts = [['ч', 99], ['мин', 59], ['с', 59]].map(([unit, top]) => {
      const input = el('input', 'kf-input studio mono-val');
      input.type = 'number';
      input.inputMode = 'numeric';
      input.min = '0';
      input.max = String(top);
      input.setAttribute('aria-label', `${label}: ${unit}`);
      const cell = el('label', 'duration-cell');
      cell.append(input, el('span', 'duration-unit', unit));
      grid.append(cell);
      return { input, top };
    });
    const read = () => {
      const [h, m, s] = parts.map(({ input, top }) => Math.min(top, Math.max(0, Math.round(Number(input.value)) || 0)));
      return h * 3600 + m * 60 + s;
    };
    const write = (total) => {
      const values = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
      parts.forEach(({ input }, index) => {
        if (idle(input)) input.value = String(values[index]);
      });
    };
    for (const { input } of parts) {
      input.addEventListener('input', () => {
        const total = read();
        if (total >= min && total <= max) set(total, TYPING);
      });
      input.addEventListener('blur', () => {
        const source = current();
        if (!source || !input.isConnected) return;
        write(get(source));
        store.flush();
      });
    }
    wrap.append(title, grid);
    if (hint) wrap.append(el('div', 'field-hint', hint));
    syncers.push((source) => write(get(source)));
    return wrap;
  }

  // Поле по его описанию из модуля типа
  function settingControl(key, field) {
    const common = {
      label: field.label,
      hint: field.hint,
      get: (source) => source.settings[key],
      set: (value, options) => setSetting(key, value, options),
    };
    if (field.kind === 'bool') return switchInput(common);
    if (field.kind === 'color') return colorInput(common);
    if (field.kind === 'choice') {
      return field.control === 'pills' ? pillsInput({ ...common, options: field.options }) : selectInput({ ...common, options: field.options });
    }
    if (field.kind === 'text') return textInput({ ...common, max: field.max, area: Boolean(field.multiline) });
    if (field.kind === 'code') return textInput({ ...common, max: field.max, code: true });
    if (field.control === 'range') return rangeInput({ ...common, min: field.min, max: field.max, unit: field.unit });
    if (field.control === 'duration') return durationInput({ ...common, min: field.min, max: field.max });
    const input = numberInput({ min: field.min, max: field.max, get: common.get, set: common.set, signed: field.min < 0 });
    return labeled(field.unit ? `${field.label}, ${field.unit}` : field.label, input, { hint: field.hint });
  }

  // Группа полей, которую можно свернуть. Что человек свернул, запоминается до конца работы
  function group(title, key, collapsed = false) {
    const details = el('details', 'props-group');
    const memo = `${shownType}:${key}`;
    details.open = openGroups.has(memo) ? openGroups.get(memo) : !collapsed;
    details.addEventListener('toggle', () => openGroups.set(memo, details.open));
    const content = el('div', 'props-group-body');
    details.append(el('summary', 'props-group-title', title), content);
    return { details, content };
  }

  function button(className, text, onClick) {
    const node = el('button', className, text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  /* ---------- Части панели ---------- */

  function buildHead(module) {
    const head = el('div', 'props-head');
    const kind = el('div', 'props-kind');
    kind.append(icon(module?.icon || ICONS.unknown), el('span', 'card-label', module?.title || 'неизвестный тип'));

    const name = el('input', 'kf-input studio');
    name.id = nextId();
    name.type = 'text';
    name.maxLength = NAME_MAX;
    name.autocomplete = 'off';
    name.addEventListener('input', () => {
      if (name.value.trim()) setCommon({ name: name.value }, TYPING);
    });
    name.addEventListener('blur', () => {
      const source = current();
      if (!source || !name.isConnected) return;
      name.value = source.name;
      store.flush();
    });
    syncers.push((source) => {
      if (idle(name)) name.value = source.name;
    });
    head.append(kind, labeled('Название', name));
    return head;
  }

  function buildPlacement(module) {
    const { details, content } = group('Положение и размер', 'placement');
    const grid = el('div', 'field-grid-4');
    const cells = [
      ['x', 'X', -POSITION_MAX, POSITION_MAX, true],
      ['y', 'Y', -POSITION_MAX, POSITION_MAX, true],
      ['width', 'Ширина', SIZE_MIN, SIZE_MAX, false],
      ['height', 'Высота', SIZE_MIN, SIZE_MAX, false],
    ];
    for (const [key, label, min, max, signed] of cells) {
      const input = numberInput({
        min, max, signed,
        get: (source) => source[key],
        set: (value, options) => setCommon({ [key]: value }, options),
        disabledWhen: (source) => source.locked,
      });
      grid.append(labeled(label, input));
    }

    const quick = el('div', 'props-actions');
    const center = button('btn-action', 'По центру', () => {
      const source = current();
      const { width, height } = store.state.scene;
      setCommon({ x: Math.round((width - source.width) / 2), y: Math.round((height - source.height) / 2) }, { soon: true });
    });
    const fill = button('btn-action', 'На всю сцену', () => {
      const { width, height } = store.state.scene;
      setCommon({ x: 0, y: 0, width, height }, { soon: true });
    });
    quick.append(center, fill);
    let natural = null;
    if (module?.media) {
      // Размер как у самого файла; для видео сервер размеров не знает, и кнопки нет
      natural = button('btn-action', 'Размер файла', () => {
        const file = store.mediaById(current()?.file);
        if (file?.width && file?.height) {
          setCommon({ width: Math.min(SIZE_MAX, file.width), height: Math.min(SIZE_MAX, file.height) }, { soon: true });
        }
      });
      quick.append(natural);
    }
    syncers.push((source) => {
      center.disabled = source.locked;
      fill.disabled = source.locked;
      if (natural) {
        const file = store.mediaById(source.file);
        natural.hidden = !(file?.width && file?.height);
        natural.disabled = source.locked;
      }
    });

    content.append(
      grid,
      quick,
      rangeInput({
        label: 'Непрозрачность', min: 0, max: 100, unit: '%',
        get: (source) => source.opacity,
        set: (value) => setCommon({ opacity: value }),
      }),
      switchInput({
        label: 'Показывать в эфире',
        get: (source) => source.visible,
        set: (value) => setCommon({ visible: value }, { soon: true }),
      }),
      switchInput({
        label: 'Защита от случайного сдвига',
        hint: 'Пока включена, источник нельзя подвинуть и изменить его размер — ни вам, ни другим модераторам.',
        get: (source) => source.locked,
        set: (value) => setCommon({ locked: value }, { soon: true }),
      })
    );
    return details;
  }

  function buildFile(module) {
    const { details, content } = group('Файл', 'file');
    const card = el('div', 'file-card');
    const thumb = el('div', 'file-thumb');
    const info = el('div', 'file-info');
    const name = el('div', 'file-name');
    const meta = el('div', 'file-meta');
    info.append(name, meta);
    card.append(thumb, info);

    const actions = el('div', 'props-actions');
    const pick = button('btn-action', 'Выбрать файл', () => onPickFile(current()));
    const clear = button('btn-action', 'Убрать файл', () => setCommon({ file: null }, { soon: true }));
    actions.append(pick, clear);
    content.append(card, actions, el('div', 'field-hint', `Подходит ${module.media.formats}. Файл можно загрузить с компьютера или выбрать из уже загруженных.`));

    let shown; // какой файл сейчас нарисован в карточке
    syncers.push((source) => {
      const file = store.mediaById(source.file);
      clear.hidden = !source.file;
      pick.textContent = source.file ? 'Заменить файл' : 'Выбрать файл';
      const key = file ? file.id : source.file ? 'missing' : 'none';
      if (key === shown) return;
      shown = key;
      thumb.replaceChildren();
      if (!file) {
        thumb.append(icon(ICONS.file));
        name.textContent = source.file ? 'Файл недоступен' : 'Файл не выбран';
        meta.textContent = source.file ? 'Возможно, его удалили' : 'На сцене на этом месте пусто';
        return;
      }
      if (file.kind === 'video') {
        thumb.append(icon(sourceType('video').icon));
      } else {
        const img = el('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = store.mediaUrl(file.id);
        thumb.append(img);
      }
      name.textContent = file.name; // как текст
      const size = file.width && file.height ? ` · ${file.width} × ${file.height}` : '';
      meta.textContent = `${file.mime.split('/')[1].toUpperCase()}${size} · ${formatBytes(file.size)}`;
    });
    return details;
  }

  // Команды источнику: у таймера — пуск, пауза, сброс. Время считает сервер
  function buildCommands(module) {
    const { details, content } = group('Управление', 'commands');
    const status = el('div', 'props-status'); // меняется каждую секунду — вслух его объявлять не нужно
    const row = el('div', 'props-actions');
    const buttons = module.commands.map((command) => {
      const node = button('btn-action', command.label, () => store.command(shownId, command.action));
      row.append(node);
      return { node, command };
    });
    content.append(status, row, el('div', 'field-hint', 'Таймер идёт по часам сервера: у вас, у модераторов и в эфире цифры совпадают.'));

    // Что доступно, зависит и от времени: отсчёт доходит до нуля сам, без чьей-либо правки
    const refresh = () => {
      const source = current();
      if (!source?.state) return;
      const now = store.now();
      const text = module.status ? module.status(source.settings, source.state, now) : '';
      if (status.textContent !== text) status.textContent = text;
      for (const { node, command } of buttons) {
        const off = Boolean(command.enabled && !command.enabled(source.settings, source.state, now));
        if (node.disabled !== off) node.disabled = off;
      }
    };
    syncers.push((source) => {
      details.hidden = !(module.hasCommands ? module.hasCommands(source.settings) : true);
      refresh();
    });
    statusTimer = setInterval(refresh, 250);
    return details;
  }

  function buildSettings(module) {
    const sections = [];
    for (const info of module.groups) {
      const keys = Object.keys(module.fields).filter((key) => module.fields[key].group === info.id);
      if (!keys.length) continue;
      const { details, content } = group(info.title, info.id, Boolean(info.collapsed));
      const rows = keys.map((key) => {
        const row = settingControl(key, module.fields[key]);
        row.dataset.key = key;
        content.append(row);
        return { row, field: module.fields[key] };
      });
      // Поля, которым сейчас не до дела (цвет обводки при нулевой обводке), прячутся
      syncers.push((source) => {
        let visible = 0;
        for (const { row, field } of rows) {
          row.hidden = !isShown(field, source.settings);
          if (!row.hidden) visible += 1;
        }
        details.hidden = visible === 0;
      });
      sections.push(details);
    }
    return sections;
  }

  function build(source) {
    clearInterval(statusTimer);
    statusTimer = null;
    syncers = [];
    shownId = source.id;
    shownType = source.type;
    const module = sourceType(source.type);

    const parts = [buildHead(module), buildPlacement(module)];
    if (module?.media) parts.push(buildFile(module));
    if (module?.commands) parts.push(buildCommands(module));
    if (module) parts.push(...buildSettings(module));
    else parts.push(el('div', 'notice-box', 'Этот источник создан более новой версией платформы. Его можно переместить, скрыть или удалить.'));

    const foot = el('div', 'props-foot');
    foot.append(
      button('btn-ghost sm', 'Дублировать', () => onDuplicate(shownId)),
      button('btn-ghost sm danger', 'Удалить', () => onDelete(shownId))
    );
    parts.push(foot);
    body.replaceChildren(...parts);
  }

  function sync() {
    const source = current();
    if (!source) return;
    for (const apply of syncers) apply(source);
  }

  function render() {
    const source = store.find(store.state.selectedId);
    empty.hidden = Boolean(source);
    body.hidden = !source;
    if (!source) {
      clearInterval(statusTimer);
      statusTimer = null;
      shownId = null;
      shownType = null;
      syncers = [];
      body.replaceChildren();
      return;
    }
    if (source.id !== shownId || source.type !== shownType) build(source);
    sync();
  }

  store.on('change', (detail) => {
    if (detail.kind === 'source' && detail.id !== shownId) return;
    render();
  });
  render();

  return {
    // Перевести курсор в главное поле источника (двойной щелчок по тексту на сцене)
    focusMain() {
      const field = body.querySelector('.props-group[open] textarea, .props-group[open] .props-group-body input[type="text"]');
      field?.focus();
      field?.select?.();
    },
  };
}
