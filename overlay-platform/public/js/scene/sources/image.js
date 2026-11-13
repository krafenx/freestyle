import { fitField, radiusField, renderPicture } from './picture.js';

/* Источник «Картинка»: PNG, JPEG и WebP, в том числе с прозрачностью. */
export default {
  type: 'image',
  title: 'Картинка',
  about: 'PNG, JPEG или WebP, в том числе с прозрачным фоном: рамки, логотипы, фоны.',
  icon: 'M4 4h16v16H4zM8.5 7a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM20 15l-5-5L5 20',
  size: { width: 480, height: 270 },
  // Какой файл нужен источнику; при выборе файла рамка принимает его пропорции
  media: { kinds: ['image'], formats: 'PNG, JPEG или WebP' },
  keepAspect: true,

  groups: [{ id: 'look', title: 'Вид' }, { id: 'border', title: 'Рамка' }],
  fields: {
    fit: fitField('look'),
    radius: radiusField('look'),
    flip: { kind: 'bool', default: false, label: 'Отразить по горизонтали', group: 'look' },
    borderWidth: { kind: 'int', min: 0, max: 40, default: 0, label: 'Толщина рамки', unit: 'px', control: 'range', group: 'border' },
    borderColor: { kind: 'color', default: '#ffffff', label: 'Цвет рамки', group: 'border', when: (s) => s.borderWidth > 0 },
  },

  render: renderPicture,
};
