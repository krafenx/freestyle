/* ==========================================================================
   Вход и аккаунт со стороны страницы: кто сейчас вошёл, выход, понятные
   тексты ошибок и безопасное возвращение на нужную страницу после входа.
   ========================================================================== */
import { apiFetch } from './api.js';

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

function plural(n, [one, few, many]) {
  const tens = n % 100;
  const units = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
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
};

/* Текст ошибки для человека по ответу сервера. */
export function describeError(res) {
  const code = res?.data?.error;
  if (code === 'too_many_attempts') {
    return `Слишком много попыток. Попробуйте через ${formatWait(res.data.retryAfterSeconds)}.`;
  }
  if (MESSAGES[code]) return MESSAGES[code];
  if (res?.status >= 500) return MESSAGES.server_error;
  return 'Не удалось отправить данные. Обновите страницу и попробуйте снова.';
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
  const res = await send(everywhere ? '/api/auth/logout-all' : '/api/auth/logout');
  // 401 при «выйти везде» значит, что сеанса уже нет — это тоже выход
  return res.ok || res.status === 401 ? { ok: true } : { ok: false, message: describeError(res) };
}
