import { el, icon } from '../scene/dom.js';
import { sourceType } from '../scene/sources/index.js';
import { ICONS } from './icons.js';

/* ==========================================================================
   Список слоёв: порядок источников, видимость и защита от сдвига.
   Верхняя строка списка — источник, который на сцене лежит поверх остальных.
   ========================================================================== */

export function createLayers({ store, list, empty, count, buttons, onDelete, onDuplicate }) {
  const selected = () => store.find(store.state.selectedId);

  function flag({ kind, pressed, label, on, off, toggle }) {
    const button = el('button', `layer-flag ${kind}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(pressed));
    button.setAttribute('aria-label', label);
    button.title = label;
    button.append(icon(pressed ? on : off));
    button.addEventListener('click', toggle);
    return button;
  }

  function row(source) {
    const module = sourceType(source.type);
    const item = el('li', 'layer-row');
    item.dataset.id = source.id;
    item.classList.toggle('selected', source.id === store.state.selectedId);
    item.classList.toggle('unseen', !source.visible);

    const pick = el('button', 'layer-pick');
    pick.type = 'button';
    pick.setAttribute('aria-current', String(source.id === store.state.selectedId));
    pick.title = module ? `${module.title}: ${source.name}` : source.name;
    // Название — как текст: разметка в нём останется буквами
    pick.append(icon(module?.icon || ICONS.unknown), el('span', 'layer-name', source.name));
    pick.addEventListener('click', () => store.select(source.id));

    item.append(
      pick,
      flag({
        kind: 'eye',
        pressed: source.visible,
        label: source.visible ? `Скрыть из эфира: ${source.name}` : `Показать в эфире: ${source.name}`,
        on: ICONS.eye,
        off: ICONS.eyeOff,
        toggle: () => store.change(source.id, { visible: !source.visible }, { soon: true }),
      }),
      flag({
        kind: 'lock',
        pressed: source.locked,
        label: source.locked ? `Снять защиту от сдвига: ${source.name}` : `Защитить от сдвига: ${source.name}`,
        on: ICONS.lock,
        off: ICONS.unlock,
        toggle: () => store.change(source.id, { locked: !source.locked }, { soon: true }),
      })
    );
    return item;
  }

  let drawn = '';

  function render() {
    const { sources, limits } = store.state;
    // Список зависит только от порядка, названий, двух флажков и выбора. Пока источник
    // тащат по сцене, ничего из этого не меняется — и список не пересобирается
    const signature = JSON.stringify([
      store.state.selectedId, limits?.sources, sources.map((s) => [s.id, s.type, s.name, s.visible, s.locked]),
    ]);
    if (signature === drawn) return;
    drawn = signature;

    const focusedId = document.activeElement?.closest?.('.layer-row')?.dataset.id;
    const focusedFlag = [...(document.activeElement?.parentElement?.children || [])].indexOf(document.activeElement);

    // Сверху списка — то, что на сцене сверху
    list.replaceChildren(...[...sources].reverse().map(row));
    empty.hidden = sources.length > 0;
    count.textContent = limits ? `${sources.length} из ${limits.sources}` : String(sources.length);

    // Список пересобран — возвращаем фокус туда, где он был, чтобы клавиатура не «терялась»
    if (focusedId) {
      const again = [...list.children].find((item) => item.dataset.id === focusedId);
      again?.children[Math.max(0, focusedFlag)]?.focus({ preventScroll: true });
    }

    const index = store.indexOf(store.state.selectedId);
    const has = index >= 0;
    buttons.up.disabled = !has || index === sources.length - 1;
    buttons.top.disabled = buttons.up.disabled;
    buttons.down.disabled = !has || index === 0;
    buttons.bottom.disabled = buttons.down.disabled;
    buttons.copy.disabled = !has;
    buttons.remove.disabled = !has;

    // Кнопка, на которой стоял фокус, стала недоступной (слой дошёл до верха) — клавиатуре
    // нужно куда-то вернуться: в строку выбранного слоя
    const active = document.activeElement;
    if (active?.disabled && Object.values(buttons).includes(active)) {
      list.querySelector('.layer-row.selected .layer-pick')?.focus({ preventScroll: true });
    }
  }

  const move = (where) => () => {
    const source = selected();
    if (!source) return;
    const index = store.indexOf(source.id);
    const last = store.state.sources.length - 1;
    store.move(source.id, { up: index + 1, down: index - 1, top: last, bottom: 0 }[where]);
  };
  buttons.up.addEventListener('click', move('up'));
  buttons.down.addEventListener('click', move('down'));
  buttons.top.addEventListener('click', move('top'));
  buttons.bottom.addEventListener('click', move('bottom'));
  buttons.copy.addEventListener('click', () => selected() && onDuplicate(selected().id));
  buttons.remove.addEventListener('click', () => selected() && onDelete(selected().id));

  // В списке Delete удаляет выбранный источник — как на сцене
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete') return;
    const id = event.target.closest?.('.layer-row')?.dataset.id;
    if (!id) return;
    event.preventDefault();
    store.select(id);
    onDelete(id);
  });

  store.on('change', (detail) => {
    if (detail.kind !== 'media') render();
  });
  render();
}
