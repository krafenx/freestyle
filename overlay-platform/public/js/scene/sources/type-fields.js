import { rgba } from '../dom.js';

/* ==========================================================================
   Оформление надписи: шрифт, цвет, обводка, тень, подложка. Общая часть для
   источников, которые показывают текст (сам текст и таймер): один набор полей
   и одна функция, которая применяет их к элементу.
   ========================================================================== */

// Шрифты платформы — те же пять, что на страницах; раздаются с нашего сервера
export const FONTS = [
  { value: 'heading', label: 'Alice', css: '"Alice", "Cormorant Infant", Georgia, serif' },
  { value: 'serif', label: 'Cormorant Infant', css: '"Cormorant Infant", Georgia, serif' },
  { value: 'sans', label: 'Manrope', css: '"Manrope", Arial, sans-serif' },
  { value: 'mono', label: 'JetBrains Mono', css: '"JetBrains Mono", monospace' },
  { value: 'display', label: 'Medula One (латиница)', css: '"Medula One", "Arial Narrow", sans-serif' },
];

const FONT_CSS = Object.fromEntries(FONTS.map((font) => [font.value, font.css]));

const ALIGN = [
  { value: 'left', label: 'Слева' },
  { value: 'center', label: 'Центр' },
  { value: 'right', label: 'Справа' },
];
const VALIGN = [
  { value: 'top', label: 'Сверху' },
  { value: 'middle', label: 'Середина' },
  { value: 'bottom', label: 'Снизу' },
];

// collapsed — в панели свойств группа изначально свёрнута: это не первое, что настраивают
export const TYPE_GROUPS = [
  { id: 'type', title: 'Шрифт и выравнивание' },
  { id: 'effects', title: 'Обводка и тень', collapsed: true },
  { id: 'plate', title: 'Подложка', collapsed: true },
];

export function typeFields({ font = 'heading', size = 72, shadow = true } = {}) {
  return {
    font: { kind: 'choice', options: FONTS.map(({ value, label }) => ({ value, label })), default: font, label: 'Шрифт', group: 'type' },
    size: { kind: 'int', min: 8, max: 400, default: size, label: 'Размер', unit: 'px', group: 'type' },
    color: { kind: 'color', default: '#ffffff', label: 'Цвет', group: 'type' },
    bold: { kind: 'bool', default: false, label: 'Жирный', group: 'type' },
    italic: { kind: 'bool', default: false, label: 'Курсив', group: 'type' },
    uppercase: { kind: 'bool', default: false, label: 'Все буквы прописные', group: 'type' },
    align: { kind: 'choice', options: ALIGN, default: 'center', label: 'По горизонтали', control: 'pills', group: 'type' },
    valign: { kind: 'choice', options: VALIGN, default: 'middle', label: 'По вертикали', control: 'pills', group: 'type' },
    lineHeight: { kind: 'int', min: 80, max: 300, default: 120, label: 'Высота строки', unit: '%', control: 'range', group: 'type' },
    letterSpacing: { kind: 'int', min: -10, max: 60, default: 0, label: 'Между буквами', unit: 'px', control: 'range', group: 'type' },

    strokeWidth: { kind: 'int', min: 0, max: 24, default: 0, label: 'Обводка', unit: 'px', control: 'range', group: 'effects' },
    strokeColor: { kind: 'color', default: '#000000', label: 'Цвет обводки', group: 'effects', when: (s) => s.strokeWidth > 0 },
    shadow: { kind: 'bool', default: shadow, label: 'Тень', group: 'effects' },
    shadowColor: { kind: 'color', default: '#000000', label: 'Цвет тени', group: 'effects', when: (s) => s.shadow },
    shadowBlur: { kind: 'int', min: 0, max: 80, default: 18, label: 'Размытие тени', unit: 'px', control: 'range', group: 'effects', when: (s) => s.shadow },
    shadowOffset: { kind: 'int', min: 0, max: 40, default: 2, label: 'Сдвиг тени вниз', unit: 'px', control: 'range', group: 'effects', when: (s) => s.shadow },

    plate: { kind: 'bool', default: false, label: 'Подложка под текстом', group: 'plate' },
    plateColor: { kind: 'color', default: '#0c0c10', label: 'Цвет подложки', group: 'plate', when: (s) => s.plate },
    plateOpacity: { kind: 'int', min: 0, max: 100, default: 72, label: 'Непрозрачность', unit: '%', control: 'range', group: 'plate', when: (s) => s.plate },
    plateRadius: { kind: 'int', min: 0, max: 200, default: 18, label: 'Скругление', unit: 'px', control: 'range', group: 'plate', when: (s) => s.plate },
    platePadding: { kind: 'int', min: 0, max: 200, default: 24, label: 'Отступ от краёв', unit: 'px', control: 'range', group: 'plate', when: (s) => s.plate },
  };
}

const FLEX_ALIGN = { left: 'flex-start', center: 'center', right: 'flex-end', top: 'flex-start', middle: 'center', bottom: 'flex-end' };

/* box — рамка источника (в ней выравнивание и подложка), label — сама надпись.

   Обводка рисуется отдельным слоем под буквами (см. .kf-stroked в scene.css): так она
   идёт наружу и не «съедает» буквы, и выглядит одинаково и в свежем браузере, и во
   встроенном браузере OBS, который новее свойства paint-order для текста не знает. */
export function applyType(box, label, s) {
  const b = box.style;
  b.justifyContent = FLEX_ALIGN[s.align];
  b.alignItems = FLEX_ALIGN[s.valign];
  b.padding = s.plate ? `${s.platePadding}px` : '0';
  b.background = s.plate ? rgba(s.plateColor, s.plateOpacity) : 'none';
  b.borderRadius = s.plate ? `${s.plateRadius}px` : '0';

  const t = label.style;
  t.fontFamily = FONT_CSS[s.font] || FONT_CSS.heading;
  t.fontSize = `${s.size}px`;
  t.fontWeight = s.bold ? '700' : '400';
  t.fontStyle = s.italic ? 'italic' : 'normal';
  t.textTransform = s.uppercase ? 'uppercase' : 'none';
  t.textAlign = s.align;
  t.lineHeight = String(s.lineHeight / 100);
  t.letterSpacing = `${s.letterSpacing}px`;
  t.color = s.color;
  t.setProperty('--kf-shadow', s.shadow ? `0 ${s.shadowOffset}px ${s.shadowBlur}px ${s.shadowColor}` : 'none');
  // Цвет обводки нужен, только пока обводка есть: выключенное на вид надписи не влияет никак
  if (s.strokeWidth > 0) {
    t.setProperty('--kf-stroke', `${s.strokeWidth * 2}px ${s.strokeColor}`);
    t.setProperty('--kf-stroke-color', s.strokeColor);
  } else {
    t.removeProperty('--kf-stroke');
    t.removeProperty('--kf-stroke-color');
  }
  label.classList.toggle('kf-stroked', s.strokeWidth > 0);
}

// Текст надписи — только как текст. Копия в data-text нужна слою обводки
export function setLabelText(label, text) {
  label.textContent = text;
  label.dataset.text = text;
}
