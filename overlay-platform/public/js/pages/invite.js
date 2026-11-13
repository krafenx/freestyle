import { initAtmosphere } from '../core/atmosphere.js';
import { formatMoment } from '../core/format.js';
import { setFormError, withBusy } from '../core/forms.js';
import { describeError, fetchSession, logout, request, send } from '../core/session.js';
import { toast } from '../core/ui.js';

/* Страница ссылки-приглашения. Открывается и гостю: человек должен увидеть,
   куда его зовут, до того как входить или создавать аккаунт. Что показать,
   решает сервер: он знает, действует ли ссылка и кем человек приходится площадке. */

initAtmosphere();

const $ = (id) => document.getElementById(id);

// Ссылка — последняя часть адреса /invite/<ссылка>. В разметке страницы её нет
const here = window.location.pathname;
const api = `/api/invites/${here.split('/').filter(Boolean).pop() || ''}`;
const workspaceAddress = (id) => `/app/w/${encodeURIComponent(id)}`;

const SECTIONS = ['loading', 'pending', 'known', 'invalid', 'offline'];

function show(name) {
  for (const section of SECTIONS) $(`invite-${section}`).hidden = section !== name;
  // Заголовок нового состояния получает фокус: его прочитает программа экранного доступа
  $(`invite-${name}`).querySelector('h1[tabindex]')?.focus({ preventScroll: true });
}

function showNav(signedIn) {
  const link = $('nav-action');
  link.textContent = signedIn ? 'Кабинет' : 'Войти';
  link.href = signedIn ? '/app' : `/login?next=${encodeURIComponent(here)}`;
  link.hidden = false;
}

// Названия и имена вставляются как текст (textContent): разметка в них останется буквами
function showKnown({ title, text, workspace }) {
  $('known-title').textContent = title;
  $('known-text').textContent = text;
  $('known-open').href = workspaceAddress(workspace.id);
  show('known');
}

function render(invite, session) {
  const { workspace } = invite;

  if (invite.state === 'joined') {
    showKnown({
      title: 'Вы уже в команде',
      text: `Вы приняли это приглашение и модерируете площадку «${workspace.name}».`,
      workspace,
    });
    return;
  }
  if (invite.viewer === 'owner') {
    showKnown({
      title: 'Это ваша площадка',
      text: `Эта ссылка — приглашение в вашу площадку «${workspace.name}». Отправьте её человеку, `
        + 'которого хотите сделать модератором: принять приглашение может только он.',
      workspace,
    });
    return;
  }
  if (invite.viewer === 'member') {
    showKnown({
      title: 'Вы уже в команде',
      text: `Вы уже модерируете площадку «${workspace.name}». Эта ссылка осталась неиспользованной.`,
      workspace,
    });
    return;
  }

  const guest = invite.viewer === 'guest';
  $('invite-lead').textContent = `${invite.ownerName} приглашает вас стать модератором площадки «${workspace.name}».`;
  $('invite-expires').textContent = `Приглашение действует до ${formatMoment(invite.expiresAt)}.`;
  $('invite-guest').hidden = !guest;
  $('invite-invitee').hidden = guest;

  if (guest) {
    // После входа или регистрации человек вернётся на эту же страницу
    const next = `?next=${encodeURIComponent(here)}`;
    $('invite-login').href = `/login${next}`;
    $('invite-register').href = `/register${next}`;
    $('invite-register').hidden = !session.registrationOpen;
    $('invite-guest-note').textContent = session.registrationOpen
      ? 'Чтобы принять приглашение, войдите или создайте аккаунт — после этого вы вернётесь на эту страницу.'
      : 'Чтобы принять приглашение, войдите — после этого вы вернётесь на эту страницу. '
        + 'Регистрация новых аккаунтов сейчас закрыта.';
  } else {
    setFormError($('invite-error'), '');
    $('invite-me').textContent = session.user?.displayName || '';
  }
  show('pending');
}

async function load() {
  const [session, res] = await Promise.all([fetchSession(), request(api)]);
  if (session.reachable) showNav(session.authenticated);

  if (res.ok) {
    render(res.data.invite, session);
  } else if (res.status >= 400 && res.status < 500) {
    show('invalid');
  } else {
    show('offline');
  }
}

/* ---------- Принять ---------- */
$('invite-accept').addEventListener('click', () => {
  setFormError($('invite-error'), '');
  withBusy($('invite-accept'), 'Принимаем…', async () => {
    const res = await send(`${api}/accept`);
    if (res.ok) {
      window.location.assign(workspaceAddress(res.data.workspace.id));
      return;
    }
    const code = res.data?.error;
    if (code === 'invite_invalid') {
      show('invalid'); // пока человек читал страницу, ссылку отозвали или ею воспользовался другой
    } else if (res.status === 401 || code === 'invite_own_workspace') {
      await load(); // вход закончился или сменился аккаунт — показываем страницу заново
    } else {
      setFormError($('invite-error'), describeError(res));
    }
  });
});

/* ---------- Войти под другим именем ---------- */
$('invite-switch').addEventListener('click', () => {
  withBusy($('invite-switch'), 'Выходим…', async () => {
    const result = await logout();
    if (!result.ok) {
      toast(result.message, 'error');
      return;
    }
    await load(); // теперь страница предложит войти или создать аккаунт
  });
});

$('invite-retry').addEventListener('click', () => {
  withBusy($('invite-retry'), 'Проверяем…', load);
});

load();

// Страницу вернули кнопкой «Назад» из памяти браузера: за это время человек мог войти
window.addEventListener('pageshow', (event) => {
  if (event.persisted) load();
});
