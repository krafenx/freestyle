/* ==========================================================================
   Описание настроек источника сцены.

   Этот файл выполняется и в браузере, и на сервере — один и тот же, без копий.
   Модуль типа описывает свои настройки списком полей; из этого списка получаются
   сразу три вещи: значения по умолчанию, проверка присланных значений на сервере
   и поля панели свойств в редакторе. Разойтись между собой они не могут.

   Виды полей:
     text   — строка: max знаков; multiline — можно с переносами (lines — не больше строк)
     code   — текст как есть (свой HTML-блок): max знаков
     int    — целое число от min до max
     bool   — да / нет
     choice — одно значение из options: [{ value, label }]
     color  — цвет в виде #rrggbb

   Остальное в описании поля — подсказки для панели: label, group, control, unit,
   hint и when (при каких настройках поле показывается).
   ========================================================================== */

// Управляющие символы: в тексте сцены им делать нечего. Перенос строки и табуляция
// обрабатываются отдельно, а «склейки» и направление письма не трогаем — без них
// ломаются составные смайлики и текст справа налево
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;

// Длина в знаках, как её видит человек: смайлик считается одним знаком
export const lengthOf = (text) => [...text].length;

function cleanText(value, multiline) {
  const text = value
    .normalize('NFC')
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL_CHARS, '');
  return multiline ? text : text.replace(/\n+/g, ' ');
}

const FAIL = Object.freeze({ ok: false });
const pass = (value) => ({ ok: true, value });

const CHECKS = {
  text(field, value) {
    if (typeof value !== 'string') return FAIL;
    const text = cleanText(value, Boolean(field.multiline));
    if (lengthOf(text) > field.max) return FAIL;
    if (field.multiline && field.lines && text.split('\n').length > field.lines) return FAIL;
    return pass(text);
  },

  code(field, value) {
    if (typeof value !== 'string') return FAIL;
    const text = value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
    if (lengthOf(text) > field.max) return FAIL;
    return pass(text);
  },

  int(field, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return FAIL;
    const number = Math.round(value);
    if (number < field.min || number > field.max) return FAIL;
    return pass(number);
  },

  bool(_field, value) {
    return typeof value === 'boolean' ? pass(value) : FAIL;
  },

  choice(field, value) {
    return field.options.some((option) => option.value === value) ? pass(value) : FAIL;
  },

  color(_field, value) {
    if (typeof value !== 'string') return FAIL;
    const color = value.toLowerCase();
    return COLOR_PATTERN.test(color) ? pass(color) : FAIL;
  },
};

export const FIELD_KINDS = Object.freeze(Object.keys(CHECKS));

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Одно значение: { ok: true, value } — уже приведённое к аккуратному виду, либо { ok: false }.
// Вид поля ищется только среди перечисленных выше: «toString» и подобные названия — не вид поля
export function checkValue(field, value) {
  const kind = field?.kind;
  return typeof kind === 'string' && own(CHECKS, kind) ? CHECKS[kind](field, value) : FAIL;
}

// Настройки по умолчанию: то, с чем источник появляется на сцене
export function defaultsOf(fields) {
  const result = {};
  for (const [key, field] of Object.entries(fields)) result[key] = field.default;
  return result;
}

/* Проверка присланных настроек. Присылать можно часть полей: проверяются те, что
   пришли. Незнакомое поле или негодное значение — отказ с названием поля:
   молча отбросить его значило бы сказать странице «сохранено», ничего не сохранив. */
export function checkSettings(fields, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, field: '' };
  const value = {};
  for (const key of Object.keys(input)) {
    if (!own(fields, key)) return { ok: false, field: key };
    const checked = checkValue(fields[key], input[key]);
    if (!checked.ok) return { ok: false, field: key };
    value[key] = checked.value;
  }
  return { ok: true, value };
}

/* Настройки из базы: полный набор полей. Чего в записи нет (поле появилось в более
   новой версии платформы) или что перестало быть допустимым — берётся по умолчанию. */
export function readSettings(fields, stored) {
  const source = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const result = {};
  for (const [key, field] of Object.entries(fields)) {
    const checked = own(source, key) ? checkValue(field, source[key]) : FAIL;
    result[key] = checked.ok ? checked.value : field.default;
  }
  return result;
}

// Показывать ли поле в панели при текущих настройках
export function isShown(field, settings) {
  return typeof field.when === 'function' ? Boolean(field.when(settings)) : true;
}
