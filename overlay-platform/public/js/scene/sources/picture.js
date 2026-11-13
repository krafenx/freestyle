import { el, placeholder } from '../dom.js';

/* Общая отрисовка картинки и GIF: и то и другое браузер показывает одним элементом. */

export const FIT_OPTIONS = [
  { value: 'contain', label: 'Целиком' },
  { value: 'cover', label: 'Заполнить' },
  { value: 'fill', label: 'Растянуть' },
];

export const fitField = (group) => ({
  kind: 'choice', options: FIT_OPTIONS, default: 'contain', label: 'Как вписать в рамку', control: 'pills', group,
  hint: '«Целиком» сохраняет пропорции, «Заполнить» обрезает лишнее, «Растянуть» пропорции меняет.',
});

export const radiusField = (group) => ({
  kind: 'int', min: 0, max: 500, default: 0, label: 'Скругление углов', unit: 'px', control: 'range', group,
});

export function renderPicture(node, source, ctx) {
  const s = source.settings;
  if (!node.parts) {
    const frame = el('div', 'kf-media');
    node.body.append(frame);
    node.parts = { frame, img: null, url: null, failed: false };
  }
  const parts = node.parts;

  // В редакторе на месте пустого источника видна подсказка; в эфире там просто пусто
  const note = () => {
    const text = !parts.url ? 'Файл не выбран' : parts.failed ? 'Файл не удалось показать' : '';
    placeholder(node.body, ctx.mode === 'editor' ? text : '');
  };

  const url = source.file ? ctx.mediaUrl(source.file) : null;
  if (url !== parts.url) {
    parts.url = url;
    parts.failed = false;
    parts.img?.remove();
    parts.img = null;
    if (url) {
      const img = el('img', 'kf-media-item');
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      img.addEventListener('error', () => {
        if (parts.img !== img) return;
        parts.failed = true;
        img.remove();
        parts.img = null;
        note();
      });
      img.src = url;
      parts.frame.append(img);
      parts.img = img;
    }
  }

  if (parts.img) {
    parts.img.style.objectFit = s.fit;
    parts.img.style.transform = s.flip ? 'scaleX(-1)' : 'none';
    parts.img.style.imageRendering = s.pixelated ? 'pixelated' : 'auto';
  }
  parts.frame.style.borderRadius = `${s.radius}px`;
  parts.frame.style.border = s.borderWidth > 0 ? `${s.borderWidth}px solid ${s.borderColor}` : 'none';
  note();
}
