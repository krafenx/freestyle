import { el } from '../dom.js';
import { TYPE_GROUPS, applyType, setLabelText, typeFields } from './type-fields.js';

/* Источник «Текст»: заголовки, подписи и плашки. */
export default {
  type: 'text',
  title: 'Текст',
  about: 'Заголовки, подписи и плашки: шрифт, цвет, обводка, тень, подложка.',
  icon: 'M4 7V4h16v3M9 20h6M12 4v16',
  size: { width: 720, height: 180 },

  groups: [{ id: 'content', title: 'Текст' }, ...TYPE_GROUPS],
  fields: {
    text: {
      kind: 'text', max: 500, multiline: true, lines: 20, default: 'Новый текст',
      label: 'Что написано', control: 'area', group: 'content',
      hint: 'До 500 знаков и 20 строк. Перенос строки сохраняется.',
    },
    ...typeFields({ font: 'heading', size: 72 }),
  },

  render(node, source) {
    if (!node.parts) {
      const box = el('div', 'kf-text');
      const label = el('div', 'kf-text-label');
      box.append(label);
      node.body.append(box);
      node.parts = { box, label };
    }
    const { box, label } = node.parts;
    setLabelText(label, source.settings.text); // только как текст: разметка останется буквами
    applyType(box, label, source.settings);
  },
};
