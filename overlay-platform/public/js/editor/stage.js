import { el } from '../scene/dom.js';
import { sourceType } from '../scene/sources/index.js';

/* ==========================================================================
   Сцена в редакторе: выбор источника, перетаскивание, изменение размера,
   привязка к краям, клавиши и перенос файлов мышью.

   Сама сцена рисуется общим модулем (js/scene/view.js) и ничего не знает
   о редакторе. Рамка выделения и её ручки — отдельный слой поверх сцены:
   он считается в точках экрана, поэтому ручки одного размера при любом масштабе.
   ========================================================================== */

const MIN_SIZE = 8;
const MAX_SIZE = 8192;
const MAX_POSITION = 8192;
const SNAP_PX = 7; // на каком расстоянии (в точках экрана) край «прилипает»
const KEEP_PX = 24; // сколько источника (в точках экрана) должно оставаться на сцене, когда его тащат
const DRAG_START_PX = 3; // меньшее движение считается щелчком, а не перетаскиванием
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function createStage({ store, stage, frame, sceneRoot, overlay, onEdit, onDelete, onDuplicate, onFiles }) {
  let scale = 1;
  let drag = null;

  /* ---------- Слой выделения ---------- */
  const box = el('div', 'sel-box');
  box.hidden = true;
  for (const dir of HANDLES) {
    const handle = el('div', `sel-handle ${dir}`);
    handle.dataset.dir = dir;
    box.append(handle);
  }
  const sizeTag = el('div', 'sel-size');
  box.append(sizeTag);
  const guideX = el('div', 'snap-line vertical');
  const guideY = el('div', 'snap-line horizontal');
  guideX.hidden = true;
  guideY.hidden = true;
  overlay.append(guideX, guideY, box);

  const selected = () => store.find(store.state.selectedId);

  function fit() {
    const { width, height } = store.state.scene;
    scale = frame.clientWidth / width || 1;
    sceneRoot.style.transform = `scale(${scale})`;
    // Рамка сцены держит пропорции сама; здесь только сверяем высоту на случай иного размера сцены
    frame.style.aspectRatio = `${width} / ${height}`;
    draw();
  }

  function draw() {
    const source = selected();
    box.hidden = !source;
    if (!source) return;
    const style = box.style;
    style.left = `${frame.clientLeft + source.x * scale}px`;
    style.top = `${frame.clientTop + source.y * scale}px`;
    style.width = `${source.width * scale}px`;
    style.height = `${source.height * scale}px`;
    box.classList.toggle('locked', source.locked);
    box.classList.toggle('unseen', !source.visible);
    // У маленькой рамки ручки на серединах сторон только мешают — остаются угловые
    box.classList.toggle('small', Math.min(source.width, source.height) * scale < 34);
    sizeTag.textContent = `${source.width} × ${source.height}`;
  }

  function showGuides(x, y) {
    guideX.hidden = x === null;
    guideY.hidden = y === null;
    if (x !== null) guideX.style.left = `${frame.clientLeft + x * scale}px`;
    if (y !== null) guideY.style.top = `${frame.clientTop + y * scale}px`;
  }

  /* ---------- Геометрия ---------- */
  function toScene(event) {
    const rect = frame.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - frame.clientLeft) / scale,
      y: (event.clientY - rect.top - frame.clientTop) / scale,
    };
  }

  const contains = (source, point) =>
    point.x >= source.x && point.x <= source.x + source.width && point.y >= source.y && point.y <= source.y + source.height;

  // Самый верхний видимый и не защищённый источник под точкой
  function topmostAt(point) {
    const { sources } = store.state;
    for (let i = sources.length - 1; i >= 0; i -= 1) {
      const source = sources[i];
      if (source.visible && !source.locked && contains(source, point)) return source;
    }
    return null;
  }

  // К чему можно «прилипнуть»: края и середина сцены, края и середины других источников
  function snapLines(exceptId) {
    const { width, height } = store.state.scene;
    const xs = [0, width / 2, width];
    const ys = [0, height / 2, height];
    for (const source of store.state.sources) {
      if (source.id === exceptId || !source.visible) continue;
      xs.push(source.x, source.x + source.width / 2, source.x + source.width);
      ys.push(source.y, source.y + source.height / 2, source.y + source.height);
    }
    return { xs, ys };
  }

  // Ближайшая линия к одному из краёв: { shift, line } или null
  function nearest(edges, lines) {
    const reach = SNAP_PX / scale;
    let best = null;
    for (const edge of edges) {
      for (const line of lines) {
        const shift = line - edge;
        if (Math.abs(shift) <= reach && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, line };
      }
    }
    return best;
  }

  function moved(dx, dy, free) {
    const { rect, lines } = drag;
    let x = rect.x + dx;
    let y = rect.y + dy;
    let lineX = null;
    let lineY = null;
    if (!free) {
      const sx = nearest([x, x + rect.width / 2, x + rect.width], lines.xs);
      const sy = nearest([y, y + rect.height / 2, y + rect.height], lines.ys);
      if (sx) {
        x += sx.shift;
        lineX = sx.line;
      }
      if (sy) {
        y += sy.shift;
        lineY = sy.line;
      }
    }
    showGuides(lineX, lineY);
    // Утащить источник за край целиком нельзя: его потом было бы не за что ухватить.
    // Числами в панели свойств положение можно задать любое
    const { width: sceneWidth, height: sceneHeight } = store.state.scene;
    const keepX = Math.min(KEEP_PX / scale, rect.width);
    const keepY = Math.min(KEEP_PX / scale, rect.height);
    return {
      x: clamp(Math.round(clamp(x, keepX - rect.width, sceneWidth - keepX)), -MAX_POSITION, MAX_POSITION),
      y: clamp(Math.round(clamp(y, keepY - rect.height, sceneHeight - keepY)), -MAX_POSITION, MAX_POSITION),
    };
  }

  function resized(dx, dy, { keepRatio, free }) {
    const { rect, dir, lines } = drag;
    let left = rect.x;
    let top = rect.y;
    let right = rect.x + rect.width;
    let bottom = rect.y + rect.height;
    let lineX = null;
    let lineY = null;

    if (dir.includes('w')) left += dx;
    if (dir.includes('e')) right += dx;
    if (dir.includes('n')) top += dy;
    if (dir.includes('s')) bottom += dy;

    const corner = dir.length === 2;
    if (corner && keepRatio) {
      // Пропорции сохраняются: размер задаёт та сторона, которую потянули сильнее
      const grow = Math.max((right - left) / rect.width, (bottom - top) / rect.height, MIN_SIZE / Math.min(rect.width, rect.height));
      const width = rect.width * grow;
      const height = rect.height * grow;
      if (dir.includes('w')) left = right - width;
      else right = left + width;
      if (dir.includes('n')) top = bottom - height;
      else bottom = top + height;
    } else if (!free) {
      const sx = dir.includes('w') ? nearest([left], lines.xs) : dir.includes('e') ? nearest([right], lines.xs) : null;
      const sy = dir.includes('n') ? nearest([top], lines.ys) : dir.includes('s') ? nearest([bottom], lines.ys) : null;
      if (sx) {
        if (dir.includes('w')) left += sx.shift;
        else right += sx.shift;
        lineX = sx.line;
      }
      if (sy) {
        if (dir.includes('n')) top += sy.shift;
        else bottom += sy.shift;
        lineY = sy.line;
      }
    }

    // Сторона не «выворачивается» наизнанку и не становится тоньше допустимого
    if (dir.includes('w')) left = Math.min(left, right - MIN_SIZE);
    else right = Math.max(right, left + MIN_SIZE);
    if (dir.includes('n')) top = Math.min(top, bottom - MIN_SIZE);
    else bottom = Math.max(bottom, top + MIN_SIZE);

    showGuides(lineX, lineY);
    const x = clamp(Math.round(left), -MAX_POSITION, MAX_POSITION);
    const y = clamp(Math.round(top), -MAX_POSITION, MAX_POSITION);
    return {
      x,
      y,
      width: clamp(Math.round(right) - x, MIN_SIZE, MAX_SIZE),
      height: clamp(Math.round(bottom) - y, MIN_SIZE, MAX_SIZE),
    };
  }

  /* ---------- Мышь и палец ---------- */
  function begin(event, source, kind, dir = '') {
    drag = {
      kind,
      dir,
      id: source.id,
      pointerId: event.pointerId,
      start: toScene(event),
      rect: { x: source.x, y: source.y, width: source.width, height: source.height },
      lines: snapLines(source.id),
      keepRatio: Boolean(sourceType(source.type)?.keepAspect),
      active: false,
    };
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      // указатель уже отпущен
    }
  }

  stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!store.state.ready || drag) return;
    stage.focus({ preventScroll: true });

    const current = selected();
    const handle = event.target.closest?.('.sel-handle');
    if (handle && current && !current.locked) {
      begin(event, current, 'resize', handle.dataset.dir);
      event.preventDefault();
      return;
    }

    const point = toScene(event);
    if (current && current.visible && !current.locked && contains(current, point)) {
      begin(event, current, 'move');
      event.preventDefault();
      return;
    }

    const hit = topmostAt(point);
    store.select(hit?.id ?? null);
    /* Мышью источник можно схватить и сразу потащить. Пальцем первое касание только
       выбирает: иначе, прокручивая страницу, человек двигал бы источники нечаянно. */
    if (hit && event.pointerType !== 'touch') {
      begin(event, hit, 'move');
      event.preventDefault();
    }
  });

  // Перетаскивание пальцем не должно одновременно прокручивать страницу
  stage.addEventListener('touchstart', (event) => {
    if (drag) event.preventDefault();
  }, { passive: false });

  stage.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const point = toScene(event);
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    if (!drag.active) {
      if (Math.hypot(dx, dy) * scale < DRAG_START_PX) return;
      drag.active = true;
      stage.classList.add('dragging');
    }
    const free = event.altKey || event.ctrlKey || event.metaKey; // с Alt или Ctrl привязка отключается
    const patch = drag.kind === 'move'
      ? moved(dx, dy, free)
      : resized(dx, dy, { keepRatio: drag.keepRatio !== event.shiftKey, free }); // Shift меняет правило пропорций на обратное
    // Пока тянут — только показываем; на сервер уйдёт итог, когда отпустят
    store.change(drag.id, patch, { save: false });
  });

  function finish(event) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    const wasActive = drag.active;
    drag = null;
    stage.classList.remove('dragging');
    showGuides(null, null);
    if (wasActive) store.flush();
  }
  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', finish);
  stage.addEventListener('lostpointercapture', finish);

  stage.addEventListener('dblclick', (event) => {
    const hit = topmostAt(toScene(event));
    if (hit) onEdit?.(hit.id);
  });

  /* ---------- Клавиши ----------
     Работают, когда выбрана сама сцена: в полях ввода стрелки и Delete заняты своим делом. */
  stage.addEventListener('keydown', (event) => {
    const source = selected();
    if (!source || event.target !== stage) return;

    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (step) {
      event.preventDefault();
      if (source.locked) return;
      const size = event.shiftKey ? 10 : 1;
      store.change(source.id, {
        x: clamp(source.x + step[0] * size, -MAX_POSITION, MAX_POSITION),
        y: clamp(source.y + step[1] * size, -MAX_POSITION, MAX_POSITION),
      });
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onDelete?.(source.id);
    } else if (event.key === 'Escape') {
      store.select(null);
    } else if ((event.ctrlKey || event.metaKey) && (event.key === 'd' || event.key === 'D' || event.key === 'в' || event.key === 'В')) {
      event.preventDefault();
      onDuplicate?.(source.id);
    }
  });

  /* ---------- Файлы, перенесённые мышью на сцену ---------- */
  const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');

  stage.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    stage.classList.add('dropping');
  });
  stage.addEventListener('dragleave', () => stage.classList.remove('dropping'));
  stage.addEventListener('drop', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    stage.classList.remove('dropping');
    const files = [...event.dataTransfer.files];
    if (files.length) onFiles?.(files, toScene(event));
  });

  /* ---------- Обновление ---------- */
  new ResizeObserver(fit).observe(frame);
  store.on('change', (detail) => {
    if (detail.kind === 'media') return;
    if (detail.kind === 'all') fit();
    else draw();
  });
  fit();

  return { fit, focus: () => stage.focus({ preventScroll: true }) };
}
