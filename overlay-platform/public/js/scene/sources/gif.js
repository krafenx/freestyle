import { fitField, radiusField, renderPicture } from './picture.js';

/* Источник «GIF»: анимированные картинки. Отдельный тип, потому что у анимации
   свои настройки — например, чёткие пиксели для пиксельной графики. */
export default {
  type: 'gif',
  title: 'GIF',
  about: 'Анимированная картинка: стикеры, значки, пиксельная графика.',
  icon: 'M3 5h18v14H3zM7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4',
  size: { width: 320, height: 320 },
  media: { kinds: ['gif'], formats: 'GIF' },
  keepAspect: true,

  groups: [{ id: 'look', title: 'Вид' }],
  fields: {
    fit: fitField('look'),
    radius: radiusField('look'),
    flip: { kind: 'bool', default: false, label: 'Отразить по горизонтали', group: 'look' },
    pixelated: {
      kind: 'bool', default: false, label: 'Чёткие пиксели', group: 'look',
      hint: 'Для пиксельной графики: при увеличении картинка не размывается.',
    },
  },

  render: renderPicture,
};
