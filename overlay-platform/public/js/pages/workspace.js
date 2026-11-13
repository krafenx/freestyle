import { initAtmosphere } from '../core/atmosphere.js';
import { connectRealtime } from '../core/api.js';
import { bindLogout, liveBadge, showUserChip } from '../core/cabinet.js';
import { countOf, formatDay, formatMoment, initialOf } from '../core/format.js';
import {
  clearErrors, clearErrorsOnInput, copyText, setFieldError, setFormError, showServerError, withBusy,
} from '../core/forms.js';
import { describeError, fetchSession, goToLogin, request, send } from '../core/session.js';
import { bindModalDismiss, closeModal, initMobileNav, openModal, toast } from '../core/ui.js';

/* Страница площадки: команда, приглашения, название, удаление.
   Страница только показывает то, что прислал сервер, и прячет кнопки, которые
   человеку недоступны. Права проверяет сервер — при каждом действии. */

initAtmosphere();
initMobileNav();
bindModalDismiss();
bindLogout();

const $ = (id) => document.getElementById(id);

// Номер площадки — последняя часть адреса /app/w/<номер>
const workspaceId = window.location.pathname.split('/').filter(Boolean).pop() || '';
const api = (suffix = '') => `/api/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;

// Редактор сцены этой площадки. Откроется ли он, решает сервер — так же, как эта страница
$('editor-link').setAttribute('href', `/app/w/${encodeURIComponent(workspaceId)}/editor`);

let current = null; // то, что сервер прислал в последний раз: { workspace, members, invites?, limits? }
let live = null; // живой канал площадки
let departing = false; // площадку удаляют или покидают: страница вот-вот сменится

/* ---------- Состояния страницы ---------- */
function show(state) {
  for (const name of ['loading', 'ready', 'gone', 'offline']) {
    $(`state-${name}`).hidden = name !== state;
  }
}

function showGone() {
  current = null;
  stopLive();
  // Открытые окна относились к площадке, которой для этого человека больше нет
  document.querySelectorAll('.modal.open').forEach((modal) => closeModal(modal.id));
  $('invite-link-value').textContent = '';
  $('ws-name').textContent = 'Площадка недоступна';
  $('ws-facts').hidden = true;
  $('ws-note').hidden = true;
  document.title = 'Площадка недоступна — krafen studio';
  show('gone');
}

/* ---------- Сборка списков ----------
   Строки собираются из отдельных элементов, а имена, названия и подписи
   вставляются как текст (textContent): разметка в них останется буквами. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function roleBadge(role) {
  return role === 'owner'
    ? el('span', 'status-badge crimson', 'владелец')
    : el('span', 'status-badge muted', 'модератор');
}

function memberRow(member, viewerIsOwner) {
  const row = el('li', 'member-row');
  const avatar = el('span', 'member-avatar', initialOf(member.displayName));
  avatar.setAttribute('aria-hidden', 'true');

  const name = el('div', 'member-name');
  name.append(el('span', 'member-name-text', member.displayName));
  if (member.isYou) name.append(el('span', 'you-mark', 'вы'));

  // Имя для входа и подпись приглашения сервер присылает только владельцу
  const facts = [];
  if (member.username) facts.push(`@${member.username}`);
  if (member.joinedAt) facts.push(`в команде с ${formatDay(member.joinedAt)}`);
  if (member.inviteLabel) facts.push(`приглашение «${member.inviteLabel}»`);

  const main = el('div', 'member-main');
  main.append(name);
  if (facts.length) main.append(el('div', 'member-meta', facts.join(' · ')));

  row.append(avatar, main, roleBadge(member.role));

  if (viewerIsOwner && member.role === 'moderator') {
    const remove = el('button', 'btn-action', 'Убрать');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Убрать из команды: ${member.displayName}`);
    remove.addEventListener('click', () => askRemoveMember(member));
    row.append(remove);
  }
  return row;
}

function inviteRow(invite) {
  const row = el('li', 'member-row');
  const main = el('div', 'member-main');
  main.append(
    el('div', invite.label ? 'member-name' : 'member-name unnamed', invite.label || 'без подписи'),
    el('div', 'member-meta', `создано ${formatMoment(invite.createdAt)} · действует до ${formatMoment(invite.expiresAt)}`)
  );
  const revoke = el('button', 'btn-action', 'Отозвать');
  revoke.type = 'button';
  revoke.setAttribute('aria-label', `Отозвать приглашение: ${invite.label || 'без подписи'}`);
  revoke.addEventListener('click', () => askRevokeInvite(invite));
  row.append(main, revoke);
  return row;
}

/* ---------- Показ данных ---------- */
const renameInput = $('rename-name');
let renameShown = ''; // название, которое страница сама поставила в поле

function render({ workspace, members, invites = [], limits = null }) {
  const isOwner = workspace.role === 'owner';
  const moderators = members.filter((member) => member.role === 'moderator').length;

  document.title = `${workspace.name} — krafen studio`;
  $('ws-name').textContent = workspace.name;
  $('ws-role').className = `status-badge ${isOwner ? 'crimson' : 'muted'}`;
  $('ws-role').textContent = isOwner ? 'владелец' : 'модератор';
  $('ws-owner').textContent = isOwner ? `${workspace.ownerName} (вы)` : workspace.ownerName;
  $('ws-created').textContent = formatDay(workspace.createdAt);
  $('ws-moderators').textContent = limits ? `${moderators} из ${limits.moderators}` : String(moderators);
  $('ws-facts').hidden = false;
  $('ws-note').hidden = false;

  // Команда
  $('team-count').textContent = countOf(members.length, ['человек', 'человека', 'человек']);
  $('team-text').textContent = isOwner
    ? 'Модераторы управляют сценой наравне с вами. '
      + 'Приглашать и убирать людей, переименовывать и удалять площадку можете только вы.'
    : 'Вы управляете сценой наравне с владельцем. '
      + 'Приглашает и убирает модераторов только владелец.';
  $('team-list').replaceChildren(...members.map((member) => memberRow(member, isOwner)));

  // Что доступно только владельцу, а что — только модератору
  $('invites-card').hidden = !isOwner;
  $('owner-settings').hidden = !isOwner;
  $('leave-card').hidden = isOwner;

  if (isOwner) {
    $('invite-list').replaceChildren(...invites.map(inviteRow));
    $('invite-empty').hidden = invites.length > 0;
    $('invite-quota').textContent = limits ? `${invites.length} из ${limits.pendingInvites}` : String(invites.length);

    // Поле названия обновляем, только если человек ничего в нём не менял: начатую правку
    // не затираем. А вот устаревшее название оставлять нельзя — его можно сохранить по ошибке
    if (renameInput.value === renameShown) {
      renameInput.value = workspace.name;
      renameShown = workspace.name;
    }
  }
}

/* ---------- Загрузка ----------
   Один запрос за раз: если во время загрузки пришла новая причина обновиться,
   после неё выполняется ещё одна загрузка — и только одна. */
let loading = false;
let again = false;

async function refresh() {
  if (departing) return;
  if (loading) {
    again = true;
    return;
  }
  loading = true;
  try {
    const res = await request(api());
    if (departing) return;
    if (res.status === 401) {
      goToLogin();
    } else if (res.ok) {
      current = res.data;
      render(current);
      show('ready');
      startLive();
    } else if (res.status >= 400 && res.status < 500) {
      // Удалена, или человека убрали из команды — для него это выглядит одинаково
      showGone();
    } else if (!current) {
      show('offline');
    }
    // Если данные уже на экране, а сервер временно не ответил — оставляем их как есть:
    // индикатор связи в шапке показывает, что соединения нет
  } finally {
    loading = false;
    if (again) {
      again = false;
      refresh();
    }
  }
}

// Общий разбор ответа на действие: true — действие обработано здесь, дальше делать нечего
function handledElsewhere(res) {
  if (res.status === 401) {
    goToLogin();
    return true;
  }
  if (res.data?.error === 'workspace_not_found') {
    departing = false;
    showGone();
    return true;
  }
  return false;
}

/* ---------- Живой канал ----------
   Перед каждым подключением страница получает одноразовый пропуск обычным
   запросом — там сервер проверяет вход и права. По каналу приходит только
   сигнал «что-то изменилось»; сами данные страница запрашивает заново. */
const showLiveStatus = liveBadge($('live-status'));
let liveState = '';

function startLive() {
  if (live) return;
  live = connectRealtime({
    channel: `workspace:${workspaceId}`,
    async ticket() {
      const res = await send(api('/live'));
      if (res.ok) return { ticket: res.data.ticket };
      if (res.status === 401 || res.status === 403 || res.status === 404) return { denied: true };
      return null; // сервер не ответил — канал попробует позже
    },
    onStatus(st) {
      showLiveStatus(st);
      // Пока связи не было, изменения могли пройти мимо — после каждого подключения сверяемся.
      // Отказ в доступе тоже проверяем обычным запросом: он скажет, что именно случилось
      const reconnected = st.state === 'connected' && liveState !== 'connected';
      liveState = st.state;
      if (reconnected || st.state === 'denied') refresh();
    },
    onMessage(msg) {
      if (msg?.type === 'workspace:changed' || msg?.type === 'denied') refresh();
    },
  });
}

function stopLive() {
  live?.close();
  live = null; // если доступ вернётся (новое приглашение), канал откроется заново
  liveState = '';
  showLiveStatus({ state: 'denied' });
}

/* ---------- Окно подтверждения ---------- */
const confirmSubmit = $('confirm-submit');
const confirmError = $('confirm-error');
let confirmJob = null;

function askConfirm({ eyebrow, title, text, action, busy, run, done }) {
  $('confirm-eyebrow').textContent = eyebrow;
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  confirmSubmit.textContent = action;
  setFormError(confirmError, '');
  confirmJob = { busy, run, done };
  openModal('modal-confirm');
}

confirmSubmit.addEventListener('click', () => {
  const job = confirmJob;
  if (!job) return;
  withBusy(confirmSubmit, job.busy, async () => {
    const res = await job.run();
    if (handledElsewhere(res)) return;
    if (!res.ok) {
      departing = false;
      setFormError(confirmError, describeError(res));
      refresh(); // список мог устареть: например, человека уже убрали с другой вкладки
      return;
    }
    confirmJob = null;
    closeModal('modal-confirm');
    job.done(res);
  });
});

function askRemoveMember(member) {
  askConfirm({
    eyebrow: 'команда',
    title: 'Убрать модератора',
    text: `${member.displayName} (@${member.username}) сразу потеряет доступ к площадке. `
      + 'Вернуть его можно будет только новым приглашением.',
    action: 'Убрать',
    busy: 'Убираем…',
    run: () => send(api('/members/remove'), { username: member.username }),
    done() {
      toast('Модератор убран из команды', 'ok');
      refresh();
    },
  });
}

function askRevokeInvite(invite) {
  askConfirm({
    eyebrow: 'приглашения',
    title: 'Отозвать приглашение',
    text: `${invite.label ? `Ссылка «${invite.label}»` : 'Ссылка'} перестанет действовать. `
      + 'Если вы уже отправили её человеку, войти по ней он не сможет.',
    action: 'Отозвать',
    busy: 'Отзываем…',
    run: () => send(api(`/invites/${encodeURIComponent(invite.id)}/revoke`)),
    done() {
      toast('Приглашение отозвано', 'ok');
      refresh();
    },
  });
}

$('leave-open').addEventListener('click', () => {
  if (!current) return;
  askConfirm({
    eyebrow: 'участие',
    title: 'Выйти из команды',
    text: `Вы перестанете быть модератором площадки «${current.workspace.name}». `
      + 'Вернуться можно будет только по новому приглашению от владельца.',
    action: 'Выйти',
    busy: 'Выходим…',
    run() {
      departing = true; // сервер тут же отключит страницу от канала — это не повод показывать «недоступна»
      return send(api('/leave'));
    },
    done() {
      window.location.assign('/app');
    },
  });
});

/* ---------- Новое приглашение ---------- */
const inviteForm = $('invite-form');
const inviteLabel = $('invite-label');
const inviteError = $('invite-error');
const inviteLink = $('invite-link-value');
clearErrorsOnInput(inviteForm, inviteError);

inviteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearErrors(inviteForm, inviteError);
  withBusy($('invite-submit'), 'Создаём…', async () => {
    const res = await send(api('/invites'), { label: inviteLabel.value });
    if (handledElsewhere(res)) return;
    if (!res.ok) {
      showServerError({ res, message: describeError(res), fieldMap: { label: inviteLabel }, formErrorBox: inviteError });
      return;
    }
    const { invite, token } = res.data;
    inviteForm.reset();
    // Адрес сайта берётся у самой страницы: ссылка ведёт туда же, где открыт кабинет
    inviteLink.textContent = `${window.location.origin}/invite/${token}`;
    $('invite-link-note').textContent = invite.label
      ? `Приглашение «${invite.label}» действует до ${formatMoment(invite.expiresAt)}.`
      : `Приглашение действует до ${formatMoment(invite.expiresAt)}.`;
    openModal('modal-invite-link');
    refresh();
  });
});

$('invite-link-copy').addEventListener('click', async () => {
  if (await copyText(inviteLink.textContent)) toast('Ссылка скопирована', 'ok');
  else toast('Не получилось скопировать — выделите ссылку и скопируйте вручную', 'error');
});

$('invite-link-done').addEventListener('click', () => {
  closeModal('modal-invite-link');
  inviteLink.textContent = ''; // ссылка не остаётся в разметке страницы после закрытия окна
});

/* ---------- Название ---------- */
const renameForm = $('rename-form');
const renameError = $('rename-error');
clearErrorsOnInput(renameForm, renameError);

renameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearErrors(renameForm, renameError);
  if (!current) return;
  const name = renameInput.value.trim();
  if (!name) {
    setFieldError(renameInput, 'Введите название площадки.');
    renameInput.focus();
    return;
  }
  if (name === current.workspace.name) {
    toast('Название не изменилось');
    return;
  }
  withBusy($('rename-submit'), 'Сохраняем…', async () => {
    const res = await send(api(), { name }, 'PATCH');
    if (handledElsewhere(res)) return;
    if (!res.ok) {
      showServerError({ res, message: describeError(res), fieldMap: { name: renameInput }, formErrorBox: renameError });
      return;
    }
    renameInput.blur();
    renameShown = renameInput.value; // поле снова «нетронутое»: его можно заменить названием с сервера
    toast('Название сохранено', 'ok');
    refresh();
  });
});

/* ---------- Удаление ----------
   Необратимо, поэтому нужно набрать название площадки. Сервер сверяет его сам:
   без верного названия запрос на удаление ничего не удалит. */
const deleteForm = $('delete-form');
const deleteName = $('delete-confirm-name');
const deleteError = $('delete-error');
clearErrorsOnInput(deleteForm, deleteError);

$('delete-open').addEventListener('click', () => {
  if (!current) return;
  deleteForm.reset();
  clearErrors(deleteForm, deleteError);
  $('delete-text').textContent = `Площадка «${current.workspace.name}» будет удалена вместе с командой и приглашениями. `
    + 'Чтобы подтвердить, введите её название.';
  openModal('modal-delete');
});

deleteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearErrors(deleteForm, deleteError);
  if (!deleteName.value.trim()) {
    setFieldError(deleteName, 'Введите название площадки.');
    deleteName.focus();
    return;
  }
  withBusy($('delete-submit'), 'Удаляем…', async () => {
    departing = true; // сервер тут же отключит страницу от канала — это не повод показывать «недоступна»
    const res = await send(api('/delete'), { confirmName: deleteName.value });
    if (handledElsewhere(res)) return;
    if (!res.ok) {
      departing = false;
      showServerError({ res, message: describeError(res), fieldMap: { confirmName: deleteName }, formErrorBox: deleteError });
      return;
    }
    window.location.assign('/app');
  });
});

/* ---------- Запуск ---------- */
$('state-retry').addEventListener('click', () => {
  withBusy($('state-retry'), 'Загружаем…', refresh);
});

async function showWhoIsHere() {
  const session = await fetchSession();
  if (session.reachable && !session.authenticated) goToLogin();
  else if (session.authenticated) showUserChip(session.user);
}

showWhoIsHere();
refresh();

// Вкладку открыли снова — сверяемся: за это время площадку могли переименовать или удалить
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
// Вернулась сеть
window.addEventListener('online', () => refresh());
// Страницу вернули кнопкой «Назад» из памяти браузера — данные на ней могли устареть
window.addEventListener('pageshow', (event) => {
  if (event.persisted) refresh();
});
