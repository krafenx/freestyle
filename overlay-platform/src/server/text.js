/* Короткий текст от человека: отображаемое имя, название площадки, подпись.
   На страницах такой текст показывается только как текст (textContent),
   а здесь он приводится к аккуратному виду перед сохранением. */

// Управляющие и невидимые символы: ими подделывают имена и ломают вёрстку
export const INVISIBLE_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

// Одна строка: без невидимых знаков, без переносов, без пробелов по краям и подряд
export function cleanLine(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').replace(INVISIBLE_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

// Длина в знаках, как её видит человек: смайлик считается одним знаком, а не двумя
export function lengthOf(text) {
  return [...text].length;
}
