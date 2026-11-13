/* ==========================================================================
   Слова, числа и даты в том виде, в каком их читает человек.
   ========================================================================== */

// «1 модератор», «2 модератора», «5 модераторов»
export function plural(n, [one, few, many]) {
  const tens = Math.abs(n) % 100;
  const units = tens % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

export const countOf = (n, forms) => `${n} ${plural(n, forms)}`;

/* «12 ноября 2026 года». Год дописывается вручную: иначе браузер ставит «г.»,
   и в конце фразы получаются две точки. */
export function formatDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} ${date.getFullYear()} года`;
}

// День и время: «19 ноября, 14:05» — по часам того, кто смотрит страницу
export function formatMoment(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

// Первая буква имени для кружка-аватара; смайлик считается одним знаком
export const initialOf = (name) => [...String(name || '')][0] || '?';

// Размер файла: «512 Б», «340 КБ», «1,2 МБ» — с запятой, как принято в русском тексте
export function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} Б`;
  const units = ['КБ', 'МБ', 'ГБ'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1).replace('.', ',');
  return `${text} ${units[unit]}`;
}
