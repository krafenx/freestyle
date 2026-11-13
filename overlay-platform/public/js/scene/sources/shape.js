import { el, rgba } from '../dom.js';

/* Источник «Фигура»: подложки под камеру и чат, рамки, разделители, градиенты
   и «тёмное стекло» — полупрозрачная тёмная заливка с тонкой рамкой. */
export default {
  type: 'shape',
  title: 'Фигура',
  about: 'Прямоугольник или эллипс: подложка под камеру и чат, рамка, градиент.',
  icon: 'M3 9a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z',
  size: { width: 520, height: 300 },

  groups: [{ id: 'shape', title: 'Форма' }, { id: 'fill', title: 'Заливка' }, { id: 'border', title: 'Рамка' }],
  fields: {
    shape: {
      kind: 'choice', default: 'rect', label: 'Вид фигуры', control: 'pills', group: 'shape',
      options: [{ value: 'rect', label: 'Прямоугольник' }, { value: 'ellipse', label: 'Эллипс' }],
    },
    radius: { kind: 'int', min: 0, max: 500, default: 18, label: 'Скругление углов', unit: 'px', control: 'range', group: 'shape', when: (s) => s.shape === 'rect' },

    fill: {
      kind: 'choice', default: 'solid', label: 'Чем залить', control: 'pills', group: 'fill',
      options: [{ value: 'solid', label: 'Цвет' }, { value: 'gradient', label: 'Градиент' }, { value: 'none', label: 'Нет' }],
    },
    color: { kind: 'color', default: '#0c0c10', label: 'Цвет', group: 'fill', when: (s) => s.fill !== 'none' },
    color2: { kind: 'color', default: '#7c0a0a', label: 'Второй цвет', group: 'fill', when: (s) => s.fill === 'gradient' },
    angle: { kind: 'int', min: 0, max: 360, default: 135, label: 'Направление', unit: '°', control: 'range', group: 'fill', when: (s) => s.fill === 'gradient' },
    fillOpacity: { kind: 'int', min: 0, max: 100, default: 78, label: 'Непрозрачность заливки', unit: '%', control: 'range', group: 'fill', when: (s) => s.fill !== 'none' },

    borderWidth: { kind: 'int', min: 0, max: 40, default: 1, label: 'Толщина рамки', unit: 'px', control: 'range', group: 'border' },
    borderColor: { kind: 'color', default: '#a0a0a0', label: 'Цвет рамки', group: 'border', when: (s) => s.borderWidth > 0 },
    borderOpacity: { kind: 'int', min: 0, max: 100, default: 26, label: 'Непрозрачность рамки', unit: '%', control: 'range', group: 'border', when: (s) => s.borderWidth > 0 },
  },

  render(node, source) {
    if (!node.parts) {
      const box = el('div', 'kf-shape');
      node.body.append(box);
      node.parts = { box };
    }
    const s = source.settings;
    const style = node.parts.box.style;
    style.borderRadius = s.shape === 'ellipse' ? '50%' : `${s.radius}px`;
    if (s.fill === 'gradient') {
      style.background = `linear-gradient(${s.angle}deg, ${rgba(s.color, s.fillOpacity)}, ${rgba(s.color2, s.fillOpacity)})`;
    } else {
      style.background = s.fill === 'solid' ? rgba(s.color, s.fillOpacity) : 'none';
    }
    style.border = s.borderWidth > 0 ? `${s.borderWidth}px solid ${rgba(s.borderColor, s.borderOpacity)}` : 'none';
  },
};
