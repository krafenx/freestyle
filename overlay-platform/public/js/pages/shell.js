import { initAtmosphere } from '../core/atmosphere.js';
import { bindModalDismiss, closeModal, initMobileNav, openModal, toast } from '../core/ui.js';
import { connectRealtime } from '../core/api.js';
import {
  bindPasswordToggles, clearErrors, clearErrorsOnInput, copyText, hidePasswords, setFieldError,
  showServerError, withBusy,
} from '../core/forms.js';
import { describeError, fetchSession, logout, send } from '../core/session.js';

initAtmosphere();
initMobileNav();
bindModalDismiss();
bindPasswordToggles();

const $ = (id) => document.getElementById(id);
const LOGIN_URL = '/login?next=%2Fapp';

/* ---------- Разделы боковой панели ---------- */
const tabs = [...document.querySelectorAll('.sidebar-nav [role="tab"]')];

function selectTab(tab, { focus = false } = {}) {
  tabs.forEach((t) => {
    const selected = t === tab;
    t.classList.toggle('active', selected);
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
    const pane = document.getElementById(t.getAttribute('aria-controls'));
    if (pane) pane.hidden = !selected;
  });
  if (focus) tab.focus();
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    selectTab(tabs[(index + step + tabs.length) % tabs.length], { focus: true });
  });
});

/* ---------- Индикатор живого канала связи в шапке ---------- */
const wsStatus = $('shell-ws-status');

function setStatus(tone, text) {
  if (!wsStatus) return;
  wsStatus.className = `status-badge ${tone}`;
  wsStatus.replaceChildren(Object.assign(document.createElement('span'), { className: 'dot' }), text);
}

connectRealtime({
  channel: 'workspace',
  onStatus(st) {
    if (st.state === 'connected') {
      setStatus('live', typeof st.rttMs === 'number' ? `на связи · ${st.rttMs} мс` : 'на связи');
    } else if (st.state === 'reconnecting') {
      setStatus('amber', 'переподключение');
    } else {
      setStatus('muted', 'связь…');
    }
  },
});

/* ---------- Кто вошёл ----------
   Имена вставляются как текст (textContent), а не как разметка: что бы человек
   ни написал в отображаемом имени, на странице это останется просто текстом. */
function showUser(user, activeSessions) {
  // «12 ноября 2026 года»: год дописываем сами, иначе браузер ставит «г.» и в конце фразы выходят две точки
  const createdAt = new Date(user.createdAt);
  const created = `${createdAt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} ${createdAt.getFullYear()} года`;
  $('me-name').textContent = user.displayName;
  $('me-login').textContent = `@${user.username}`;
  $('user-chip-name').textContent = user.displayName;
  $('user-chip-letter').textContent = [...user.displayName][0] || '?';
  $('user-chip').hidden = false;
  $('hello-title').textContent = `Здравствуйте, ${user.displayName}`;
  $('hello-text').textContent = `Вы вошли как ${user.username}. Аккаунт создан ${created}.`;
  $('profile-login').textContent = user.username;
  $('password-username').value = user.username;
  if (document.activeElement !== $('profile-display')) $('profile-display').value = user.displayName;
  if (typeof activeSessions === 'number') $('sessions-count').textContent = String(activeSessions);
}

async function loadAccount() {
  const session = await fetchSession();
  if (!session.reachable) {
    $('hello-text').textContent = 'Нет связи с сервером. Данные аккаунта появятся, когда связь вернётся.';
    return false;
  }
  if (!session.authenticated) {
    window.location.replace(LOGIN_URL);
    return false;
  }
  showUser(session.user, session.activeSessions);
  return true;
}

loadAccount();
// Вкладку открыли снова — сверяемся: вдруг вход закрыли с другого устройства
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadAccount();
});

// Вход устарел или закрыт с другого устройства — отправляем на страницу входа
function leaveIfSignedOut(res) {
  if (res.status !== 401) return false;
  window.location.assign(LOGIN_URL);
  return true;
}

/* ---------- Выход ---------- */
document.querySelectorAll('[data-logout]').forEach((btn) => {
  btn.addEventListener('click', () => {
    withBusy(btn, 'Выходим…', async () => {
      const result = await logout();
      if (!result.ok) {
        toast(result.message, 'error');
        return;
      }
      window.location.assign('/');
    });
  });
});

$('logout-all-confirm').addEventListener('click', () => {
  withBusy($('logout-all-confirm'), 'Выходим…', async () => {
    const result = await logout({ everywhere: true });
    if (!result.ok) {
      toast(result.message, 'error');
      return;
    }
    window.location.assign('/login');
  });
});

/* ---------- Отображаемое имя ---------- */
const profileForm = $('profile-form');
const profileDisplay = $('profile-display');
const profileError = $('profile-error');
clearErrorsOnInput(profileForm, profileError);

profileForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearErrors(profileForm, profileError);
  if (!profileDisplay.value.trim()) {
    setFieldError(profileDisplay, 'Введите имя, которое будут видеть другие.');
    profileDisplay.focus();
    return;
  }
  withBusy($('profile-submit'), 'Сохраняем…', async () => {
    const res = await send('/api/account/profile', { displayName: profileDisplay.value }, 'PATCH');
    if (leaveIfSignedOut(res)) return;
    if (!res.ok) {
      showServerError({
        res, message: describeError(res), fieldMap: { displayName: profileDisplay }, formErrorBox: profileError,
      });
      return;
    }
    profileDisplay.blur();
    showUser(res.data.user);
    profileDisplay.value = res.data.user.displayName;
    toast('Имя сохранено', 'ok');
  });
});

/* ---------- Смена пароля ---------- */
const passwordForm = $('password-form');
const passwordCurrent = $('password-current');
const passwordNew = $('password-new');
const passwordError = $('password-error');
clearErrorsOnInput(passwordForm, passwordError);

passwordForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearErrors(passwordForm, passwordError);
  if (!passwordCurrent.value) {
    setFieldError(passwordCurrent, 'Введите текущий пароль.');
    passwordCurrent.focus();
    return;
  }
  if ([...passwordNew.value].length < 8) {
    setFieldError(passwordNew, 'Пароль слишком короткий: нужно не меньше 8 символов.');
    passwordNew.focus();
    return;
  }
  hidePasswords(passwordForm);
  withBusy($('password-submit'), 'Меняем пароль…', async () => {
    const res = await send('/api/account/password', {
      currentPassword: passwordCurrent.value,
      newPassword: passwordNew.value,
    });
    if (leaveIfSignedOut(res)) return;
    if (!res.ok) {
      showServerError({
        res,
        message: describeError(res),
        fieldMap: { currentPassword: passwordCurrent, newPassword: passwordNew },
        formErrorBox: passwordError,
      });
      return;
    }
    passwordForm.reset();
    const ended = Number(res.data.endedSessions) || 0;
    toast(ended > 0 ? `Пароль изменён. Закрыто входов на других устройствах: ${ended}` : 'Пароль изменён', 'ok');
    loadAccount();
  });
});

/* ---------- Новый код восстановления ---------- */
const recoveryForm = $('recovery-form');
const recoveryCurrent = $('recovery-current');
const recoveryError = $('recovery-error');
const codeValue = $('new-code-value');
const codeSaved = $('new-code-saved');
const codeDone = $('new-code-done');
clearErrorsOnInput(recoveryForm, recoveryError);

recoveryForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearErrors(recoveryForm, recoveryError);
  if (!recoveryCurrent.value) {
    setFieldError(recoveryCurrent, 'Введите текущий пароль.');
    recoveryCurrent.focus();
    return;
  }
  hidePasswords(recoveryForm);
  withBusy($('recovery-submit'), 'Создаём код…', async () => {
    const res = await send('/api/account/recovery-code', { currentPassword: recoveryCurrent.value });
    if (leaveIfSignedOut(res)) return;
    if (!res.ok) {
      showServerError({
        res, message: describeError(res), fieldMap: { currentPassword: recoveryCurrent }, formErrorBox: recoveryError,
      });
      return;
    }
    recoveryForm.reset();
    codeValue.textContent = res.data.recoveryCode;
    codeSaved.checked = false;
    codeDone.disabled = true;
    openModal('modal-recovery-code');
  });
});

$('new-code-copy').addEventListener('click', async () => {
  if (await copyText(codeValue.textContent)) toast('Код скопирован', 'ok');
  else toast('Не получилось скопировать — выделите код и скопируйте вручную', 'error');
});

codeSaved.addEventListener('change', () => {
  codeDone.disabled = !codeSaved.checked;
});

codeDone.addEventListener('click', () => {
  closeModal('modal-recovery-code');
  codeValue.textContent = ''; // код не остаётся в разметке страницы после закрытия окна
});
