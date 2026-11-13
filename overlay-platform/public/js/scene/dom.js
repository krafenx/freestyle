/* ==========================================================================
   Мелкие помощники отрисовки сцены. Разметка собирается из отдельных элементов,
   а текст вставляется только как текст (textContent): что бы человек ни написал
   в источнике, на сцене это останется буквами.
   ========================================================================== */

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Значок из одной линии (viewBox 24×24), как на остальных страницах платформы
export function icon(pathData, className = 'ico') {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  path.setAttribute('d', pathData);
  svg.append(path);
  return svg;
}

// Цвет #rrggbb с непрозрачностью в процентах
export function rgba(hex, percent) {
  const n = Number.parseInt(String(hex).slice(1), 16) || 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.min(100, Math.max(0, percent)) / 100})`;
}

/* Заглушка в редакторе: источник есть, а показать пока нечего (файл не выбран).
   В эфире на этом месте пусто. */
export function placeholder(body, text) {
  let box = body.querySelector(':scope > .kf-placeholder');
  if (!text) {
    box?.remove();
    return;
  }
  if (!box) {
    box = el('div', 'kf-placeholder');
    body.append(box);
  }
  box.textContent = text;
}
