/* ==========================================================================
   Вход и аккаунт со стороны страницы: кто сейчас вошёл, выход, понятные
   тексты ошибок и безопасное возвращение на нужную страницу после входа.
   ========================================================================== */
import { apiFetch } from './api.js';
import { countOf, plural } from './format.js';

/* Запрос к серверу, который не бросает исключений: обрыв связи превращается
   в обычный ответ с кодом network. Так форме не нужно ловить ошибки отдельно. */
export async function request(path, options = {}) {
  try {
    return await apiFetch(path, options);
  } catch {
    return { ok: false, status: 0, data: { error: 'network' } };
  }
}

export const send = (path, body = {}, method = 'POST') => request(path, { method, body });

/* Кто сейчас вошёл. Ответ: { authenticated, user?, activeSessions?, registrationOpen }.
   Если сервер недоступен — reachable: false. */
export async function fetchSession() {
  const res = await request('/api/auth/session');
  if (!res.ok) return { reachable: false, authenticated: false, registrationOpen: true };
  return { reachable: true, ...res.data };
}

function formatWait(seconds) {
  const s = Math.max(1, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} ${plural(s, ['секунду', 'секунды', 'секунд'])}`;
  const m = Math.ceil(s / 60);
  return `${m} ${plural(m, ['минуту', 'минуты', 'минут'])}`;
}

const MESSAGES = {
  network: 'Нет связи с сервером. Проверьте интернет и попробуйте снова.',
  server_error: 'На сервере произошла ошибка. Попробуйте ещё раз.',
  server_busy: 'Сервер занят. Попробуйте через несколько секунд.',
  cross_site_request: 'Запрос отклонён защитой сайта. Обновите страницу и попробуйте снова.',
  unauthorized: 'Вход устарел. Войдите снова.',

  credentials_required: 'Введите имя и пароль.',
  invalid_credentials: 'Неверное имя или пароль.',
  registration_closed: 'Регистрация новых аккаунтов сейчас закрыта.',

  username_invalid: 'Имя — от 3 до 24 символов: латинские буквы, цифры и знак подчёркивания.',
  username_reserved: 'Это имя занято самой платформой. Выберите другое.',
  username_taken: 'Это имя уже занято. Выберите другое.',
  display_name_required: 'Введите имя, которое будут видеть другие.',
  display_name_too_long: 'Отображаемое имя — не длиннее 40 символов.',

  password_required: 'Введите пароль.',
  password_too_short: 'Пароль слишком короткий: нужно не меньше 8 символов.',
  password_too_long: 'Пароль слишком длинный: не больше 200 символов.',
  password_too_common: 'Такой пароль подбирают в первую очередь. Придумайте другой.',
  password_like_username: 'Пароль не должен повторять имя пользователя.',
  password_same: 'Новый пароль совпадает с текущим.',
  current_password_required: 'Введите текущий пароль.',
  wrong_password: 'Текущий пароль введён неверно.',

  recovery_required: 'Введите имя и код восстановления.',
  invalid_recovery: 'Имя или код восстановления не подходят.',

  too_many_attempts: (data) => `Слишком много попыток. Попробуйте через ${formatWait(data.retryAfterSeconds)}.`,
  too_many_requests: (data) => `Слишком часто. Попробуйте через ${formatWait(data.retryAfterSeconds)}.`,

  // Площадки
  workspace_not_found: 'Площадка не найдена: её удалили или у вас больше нет к ней доступа.',
  owner_only: 'Это может сделать только владелец площадки.',
  workspace_name_required: 'Введите название площадки.',
  workspace_name_too_long: 'Название площадки — не длиннее 40 символов.',
  workspace_name_taken: 'У вас уже есть площадка с таким названием.',
  workspaces_limit: (data) => `У одного аккаунта может быть не больше ${countOf(data.limit, ['площадки', 'площадок', 'площадок'])}.`,
  confirm_name_mismatch: 'Название не совпадает. Введите его так, как оно написано выше.',

  // Команда и приглашения
  member_not_found: 'Этого человека уже нет в команде.',
  members_limit: (data) => `В команде уже ${countOf(data.limit, ['модератор', 'модератора', 'модераторов'])} — больше нельзя.`,
  owner_cannot_leave: 'Владелец не может выйти из своей площадки — её можно только удалить.',
  invite_label_too_long: 'Подпись — не длиннее 40 символов.',
  invites_limit: (data) =>
    `Неиспользованных приглашений уже ${data.limit}. Отзовите лишние или дождитесь, пока ими воспользуются.`,
  invite_not_found: 'Этого приглашения уже нет: его отозвали или им воспользовались.',
  invite_already_used: 'По этой ссылке уже вошли. Убрать человека можно в списке команды.',
  invite_invalid: 'Приглашение недействительно: ссылка отозвана, уже использована или её срок истёк.',
  invite_own_workspace: 'Это ваша собственная площадка — принимать приглашение не нужно.',

  // Сцена: источники
  source_not_found: 'Этого источника уже нет: его удалили.',
  source_type_unknown: 'Такого вида источников нет. Обновите страницу и попробуйте снова.',
  source_name_required: 'Введите название источника.',
  source_name_too_long: 'Название источника — не длиннее 40 символов.',
  source_geometry_invalid: 'Положение или размер вне допустимого: размер — от 8 до 8192 точек, положение — не дальше 8192 точек от края сцены.',
  source_field_invalid: 'Сервер не принял это значение. Обновите страницу и попробуйте снова.',
  source_setting_invalid: 'Сервер не принял одну из настроек: значение вне допустимого или слишком длинный текст.',
  source_locked: 'Источник защищён от сдвига. Снимите защиту (значок замка в списке слоёв), чтобы подвинуть его или изменить размер.',
  source_no_commands: 'У этого источника нет кнопок управления.',
  source_command_unknown: 'Источник не знает такой команды. Обновите страницу и попробуйте снова.',
  sources_limit: (data) => `На сцене уже ${countOf(data.limit, ['источник', 'источника', 'источников'])} — больше нельзя. Удалите ненужные.`,

  // Сцена: файлы
  media_not_found: 'Этого файла уже нет: его удалили.',
  media_kind_mismatch: 'Этот файл не подходит источнику: картинке нужна картинка, GIF — GIF, видео — видео.',
  media_in_use: (data) =>
    `Файл показывается на сцене (${countOf(data.count, ['источник', 'источника', 'источников'])}). Сначала уберите его оттуда.`,
  files_limit: (data) => `На площадке уже ${countOf(data.limit, ['файл', 'файла', 'файлов'])} — больше нельзя. Удалите ненужные.`,
  storage_limit: (data) => `Не хватает места: на файлы одной площадки даётся ${data.limit} МБ. Удалите ненужные.`,
  server_storage_full: 'На сервере закончилось место для файлов. Сообщите об этом тому, кто его обслуживает.',
  file_too_large: (data) => `Файл слишком большой: можно не больше ${data.limit} МБ.`,
  file_type_not_allowed: 'Такой файл не подходит. Принимаются PNG, JPEG, WebP, GIF, MP4 и WebM.',
  file_empty: 'Файл пустой.',
  file_required: 'Файл не дошёл до сервера. Попробуйте загрузить его ещё раз.',
  upload_interrupted: 'Загрузка оборвалась. Проверьте интернет и попробуйте ещё раз.',
  image_unreadable: 'Не удалось прочитать картинку: возможно, файл повреждён.',
  image_too_big: (data) =>
    `Картинка слишком большая: не больше ${data.limit} точек по каждой стороне и не больше ${data.megapixels} мегапикселей.`,
  payload_too_large: 'Слишком много данных за один раз. Сократите текст и попробуйте снова.',
};

/* Текст ошибки для человека по ответу сервера. */
export function describeError(res) {
  const text = MESSAGES[res?.data?.error];
  if (typeof text === 'function') return text(res.data);
  if (text) return text;
  if (res?.status >= 500) return MESSAGES.server_error;
  return 'Не удалось отправить данные. Обновите страницу и попробуйте снова.';
}

let signingOut = false;
let signingOutTimer = null;

/* Вход устарел или закрыт с другого устройства: отправляем на страницу входа,
   а после него человек вернётся на эту же страницу. Адрес заменяется, а не
   добавляется в историю: иначе кнопка «Назад» возвращала бы на страницу,
   которая тут же снова отправляет на вход. */
export function goToLogin() {
  // Человек сам нажал «Выйти» на этой странице: она уже уходит туда, куда нужно
  if (signingOut) return;
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.replace(`/login?next=${encodeURIComponent(here)}`);
}

/* Куда идти после входа: только путь внутри этого же сайта.
   Правила те же, что на сервере (src/server/auth/http.js). */
export function safeNextPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  let url;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  if (/^\/(?:login|register|recover)(?:\/|$)/.test(url.pathname)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function nextFromAddress() {
  return safeNextPath(new URLSearchParams(window.location.search).get('next'));
}

/* Ссылки между «Вход», «Регистрация» и «Восстановление» не должны терять,
   куда человек шёл изначально. */
export function keepNextInLinks(root = document) {
  const next = nextFromAddress();
  if (!next) return;
  root.querySelectorAll('a[data-keep-next]').forEach((a) => {
    const url = new URL(a.getAttribute('href'), window.location.origin);
    url.searchParams.set('next', next);
    a.setAttribute('href', `${url.pathname}${url.search}`);
  });
}

/* После удачного входа проверяем, что браузер действительно запомнил вход.
   Если сайт открыт внутри чужой страницы, браузер может отказаться хранить
   cookie — тогда честно объясняем это, а не водим человека по кругу. */
export async function enterOrExplain(hintEl) {
  const session = await fetchSession();
  if (session.authenticated) {
    window.location.assign(nextFromAddress() || '/app');
    return true;
  }
  if (hintEl) {
    hintEl.hidden = false;
    hintEl.scrollIntoView({ block: 'nearest' });
  }
  return false;
}

export async function logout({ everywhere = false } = {}) {
  /* Сервер закрывает вход и тут же отключает страницу от живого канала. Страница не должна
     принять это за «вход закрыли с другого устройства» и увести человека на страницу входа:
     он вышел сам. Пометка снимается через несколько секунд — на случай, если страница остаётся. */
  signingOut = true;
  clearTimeout(signingOutTimer);
  const res = await send(everywhere ? '/api/auth/logout-all' : '/api/auth/logout');
  // 401 при «выйти везде» значит, что сеанса уже нет — это тоже выход
  const ok = res.ok || res.status === 401;
  if (ok) signingOutTimer = setTimeout(() => { signingOut = false; }, 5000);
  else signingOut = false;
  return ok ? { ok: true } : { ok: false, message: describeError(res) };
}
