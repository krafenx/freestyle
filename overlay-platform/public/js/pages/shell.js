import { initAtmosphere } from '../core/atmosphere.js';
import { bindModalDismiss, closeModal, initMobileNav, initTabs, openModal, toast } from '../core/ui.js';
import { connectRealtime } from '../core/api.js';
import { bindLogout, liveBadge, showUserChip } from '../core/cabinet.js';
import { countOf, formatDay } from '../core/format.js';
import {
  bindPasswordToggles, clearErrors, clearErrorsOnInput, copyText, hidePasswords, setFieldError,
  showServerError, withBusy,
} from '../core/forms.js';
import { describeError, fetchSession, goToLogin, logout, request, send } from '../core/session.js';

initAtmosphere();
initMobileNav();
bindModalDismiss();
bindPasswordToggles();
bindLogout();
initTabs();

const $ = (id) => document.getElementById(id);

/* ---------- Индикатор живого канала связи в шапке ---------- */
connectRealtime({ channel: 'workspace', onStatus: liveBadge($('shell-ws-status')) });

/* ---------- Кто вошёл ----------
   Имена вставляются как текст (textContent), а не как разметка: что бы человек
   ни написал в отображаемом имени, на странице это останется просто текстом. */
function showUser(user, activeSessions) {
  showUserChip(user);
  $('me-name').textContent = user.displayName;
  $('me-login').textContent = `@${user.username}`;
  $('hello-title').textContent = `Здравствуйте, ${user.displayName}`;
  $('hello-text').textContent = `Вы вошли как ${user.username}. Аккаунт создан ${formatDay(user.createdAt)}.`;
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
    goToLogin();
    return false;
  }
  showUser(session.user, session.activeSessions);
  return true;
}

// Вход устарел или закрыт с другого устройства — отправляем на страницу входа
function leaveIfSignedOut(res) {
  if (res.status !== 401) return false;
  goToLogin();
  return true;
}

/* ---------- Площадки ----------
   Карточки собираются из отдельных элементов, а названия и имена вставляются
   как текст: разметка в названии площадки останется просто буквами. */
const workspaceList = $('workspace-list');
const newWorkspaceBtn = $('workspace-new-btn');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function workspaceCard(workspace) {
  const isOwner = workspace.role === 'owner';
  const address = `/app/w/${encodeURIComponent(workspace.id)}`;
  const card = el('article', 'glass workspace-card');

  const top = el('div', 'row');
  top.append(el('span', `status-badge ${isOwner ? 'crimson' : 'muted'}`, isOwner ? 'владелец' : 'модератор'));

  const name = el('a', 'workspace-card-name', workspace.name);
  name.href = address;

  const team = workspace.moderators > 0
    ? countOf(workspace.moderators, ['модератор', 'модератора', 'модераторов'])
    : 'без модераторов';
  const meta = isOwner
    ? `${team} · создана ${formatDay(workspace.createdAt)}`
    : `владелец: ${workspace.ownerName} · вы в команде с ${formatDay(workspace.joinedAt)}`;

  // Два входа: редактор сцены и страница площадки (команда, приглашения, настройки)
  const actions = el('div', 'workspace-card-actions');
  const editor = el('a', 'btn-primary sm', 'Редактор сцены');
  editor.href = `${address}/editor`;
  editor.setAttribute('aria-label', `Редактор сцены: ${workspace.name}`);
  const teamPage = el('a', 'btn-action', 'Команда');
  teamPage.href = address;
  teamPage.setAttribute('aria-label', `Команда и настройки: ${workspace.name}`);
  actions.append(editor, teamPage);

  card.append(top, name, el('div', 'workspace-card-meta', meta), actions);
  return card;
}

async function loadWorkspaces() {
  const res = await request('/api/workspaces');
  if (leaveIfSignedOut(res)) return;
  $('workspace-load-error').hidden = res.ok;
  if (!res.ok) return;

  const { workspaces, owned, ownedLimit } = res.data;
  workspaceList.replaceChildren(...workspaces.map(workspaceCard));
  $('workspace-empty').hidden = workspaces.length > 0;
  $('workspaces-count').textContent = String(workspaces.length);

  const full = owned >= ownedLimit;
  newWorkspaceBtn.disabled = full;
  $('workspace-quota').textContent = full
    ? `Создано ${owned} из ${ownedLimit} — это предел. Чтобы создать новую площадку, удалите одну из своих.`
    : `Ваших площадок: ${owned} из ${ownedLimit}`;
}

$('workspace-reload').addEventListener('click', () => {
  withBusy($('workspace-reload'), 'Загружаем…', loadWorkspaces);
});

const newWorkspaceForm = $('workspace-new-form');
const newWorkspaceName = $('workspace-new-name');
const newWorkspaceError = $('workspace-new-error');
clearErrorsOnInput(newWorkspaceForm, newWorkspaceError);

// Окно открывается чистым: без прошлого названия и прошлой ошибки
newWorkspaceBtn.addEventListener('click', () => {
  newWorkspaceForm.reset();
  clearErrors(newWorkspaceForm, newWorkspaceError);
});

newWorkspaceForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearErrors(newWorkspaceForm, newWorkspaceError);
  if (!newWorkspaceName.value.trim()) {
    setFieldError(newWorkspaceName, 'Введите название площадки.');
    newWorkspaceName.focus();
    return;
  }
  withBusy($('workspace-new-submit'), 'Создаём…', async () => {
    const res = await send('/api/workspaces', { name: newWorkspaceName.value });
    if (leaveIfSignedOut(res)) return;
    if (!res.ok) {
      showServerError({
        res, message: describeError(res), fieldMap: { name: newWorkspaceName }, formErrorBox: newWorkspaceError,
      });
      return;
    }
    // Сразу открываем новую площадку: следующий шаг — пригласить в неё модераторов
    window.location.assign(`/app/w/${encodeURIComponent(res.data.workspace.id)}`);
  });
});

function loadEverything() {
  loadAccount();
  loadWorkspaces();
}

loadEverything();
// Вкладку открыли снова — сверяемся: вдруг вход закрыли с другого устройства,
// а в площадку за это время пригласили или из неё убрали
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadEverything();
});
// Страницу вернули кнопкой «Назад» из памяти браузера — данные на ней могли устареть
window.addEventListener('pageshow', (event) => {
  if (event.persisted) loadEverything();
});

/* ---------- Выход на всех устройствах ---------- */
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
