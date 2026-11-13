import { el } from './dom.js';
import { sourceType } from './sources/index.js';

/* ==========================================================================
   Отрисовка сцены. Один и тот же код для редактора и для оверлея в OBS:
   поэтому то, что видно в редакторе, совпадает с тем, что попадает в эфир.

   Сцена — блок фиксированного размера (1920×1080 точек). Каждый источник —
   рамка с абсолютным положением; что внутри рамки, рисует модуль его типа.
   Под ширину окна сцену подгоняет страница (transform: scale), не этот модуль.

   ctx:
     mode            'editor' или 'overlay'. В редакторе пустой источник показывает
                     подсказку, а видео всегда беззвучно; в эфире подсказок нет
     mediaUrl(id)    адрес загруженного файла
     now()           время сервера в миллисекундах (для таймеров)
   ========================================================================== */

const TICK_MS = 100;

export function createSceneView(root, ctx) {
  const nodes = new Map(); // номер источника → его рамка и всё, что модуль типа в ней держит
  let clock = null;

  root.classList.add('kf-scene');

  function make(source) {
    const box = el('div', 'kf-src');
    box.dataset.id = source.id;
    box.dataset.type = source.type;
    const body = el('div', 'kf-src-body');
    box.append(body);
    root.append(box);
    const node = { id: source.id, type: source.type, el: box, body, parts: null, tick: null, dispose: null, last: null };
    nodes.set(source.id, node);
    return node;
  }

  function drop(node) {
    try {
      node.dispose?.();
    } catch (err) {
      console.error('[scene] Не удалось убрать источник:', err);
    }
    node.el.remove();
    nodes.delete(node.id);
  }

  /* Положение, размер, прозрачность и порядок. Порядок задаётся через z-index:
     сами рамки в разметке не переставляются — иначе видео и рамки виджетов
     перезапускались бы при каждом изменении порядка слоёв. */
  function place(node, source, index) {
    const style = node.el.style;
    style.left = `${source.x}px`;
    style.top = `${source.y}px`;
    style.width = `${source.width}px`;
    style.height = `${source.height}px`;
    style.opacity = String(source.opacity / 100);
    if (index !== undefined) style.zIndex = String(index + 1);
    node.el.hidden = !source.visible;
  }

  // Содержимое перерисовывается, только если изменилось то, от чего оно зависит
  function paint(node, source) {
    const module = sourceType(source.type);
    if (!module) return;
    const last = node.last;
    if (
      last && last.settings === source.settings && last.file === source.file && last.state === source.state
      && last.width === source.width && last.height === source.height && last.visible === source.visible
    ) return;
    node.last = {
      settings: source.settings, file: source.file, state: source.state,
      width: source.width, height: source.height, visible: source.visible,
    };
    try {
      module.render(node, source, ctx);
    } catch (err) {
      // Сбой одного источника не должен гасить всю сцену
      console.error(`[scene] Не удалось нарисовать источник «${source.type}»:`, err);
    }
  }

  function tick() {
    const now = ctx.now();
    for (const node of nodes.values()) node.tick?.(now);
  }

  function runClock() {
    const needed = [...nodes.values()].some((node) => node.tick);
    if (needed && !clock) clock = setInterval(tick, TICK_MS);
    if (!needed && clock) {
      clearInterval(clock);
      clock = null;
    }
  }

  return {
    setSize(width, height) {
      root.style.width = `${width}px`;
      root.style.height = `${height}px`;
    },

    // Сцена целиком: sources — снизу вверх
    setSources(sources) {
      const seen = new Set();
      sources.forEach((source, index) => {
        seen.add(source.id);
        let node = nodes.get(source.id);
        if (node && node.type !== source.type) {
          drop(node);
          node = null;
        }
        if (!node) node = make(source);
        place(node, source, index);
        paint(node, source);
      });
      for (const node of [...nodes.values()]) {
        if (!seen.has(node.id)) drop(node);
      }
      runClock();
    },

    // Один источник изменился (порядок слоёв прежний)
    updateSource(source) {
      const node = nodes.get(source.id);
      if (!node) return;
      place(node, source);
      paint(node, source);
      runClock();
    },

    destroy() {
      clearInterval(clock);
      clock = null;
      for (const node of [...nodes.values()]) drop(node);
      root.classList.remove('kf-scene');
    },
  };
}
