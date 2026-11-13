import gif from './gif.js';
import image from './image.js';
import shape from './shape.js';
import text from './text.js';
import timer from './timer.js';
import video from './video.js';
import widget from './widget.js';

/* ==========================================================================
   Типы источников сцены. Этот список читают и сервер, и редактор, и оверлей.

   Каждый тип — отдельный модуль с четырьмя частями:
     fields        — описание настроек: из него получаются значения по умолчанию,
                     проверка на сервере и поля панели свойств (см. ../schema.js);
     render        — отрисовка на сцене, одна и та же в редакторе и в эфире;
     title, about, icon, size, groups — как тип называется и выглядит в редакторе;
     media, commands и прочее — необязательное: нужен ли файл, есть ли команды.

   Новый тип — это новый модуль и одна строка здесь. Ни сервер, ни редактор
   при этом не переписываются.
   ========================================================================== */
export const SOURCE_LIST = Object.freeze([text, image, gif, video, shape, timer, widget]);

export const SOURCE_TYPES = Object.freeze(Object.fromEntries(SOURCE_LIST.map((module) => [module.type, module])));

// Модуль типа по названию; чужое или испорченное название — undefined
export function sourceType(type) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(SOURCE_TYPES, type) ? SOURCE_TYPES[type] : undefined;
}
