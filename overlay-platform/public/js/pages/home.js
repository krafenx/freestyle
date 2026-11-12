import { initAtmosphere } from '../core/atmosphere.js';
import { bindModalDismiss, bindRangeFill, initMobileNav, initRail, toast } from '../core/ui.js';
import { apiFetch, connectRealtime } from '../core/api.js';
import { fetchSession } from '../core/session.js';

initAtmosphere();
initMobileNav();
initRail();
bindModalDismiss();
bindRangeFill();

const $ = (id) => document.getElementById(id);

function setBadge(el, tone, text) {
  if (!el) return;
  el.className = `status-badge ${tone}`;
  el.replaceChildren(Object.assign(document.createElement('span'), { className: 'dot' }), text);
}

/* ---------- Кто вошёл: вместо «Войти» показываем имя со ссылкой в кабинет ---------- */
fetchSession().then((session) => {
  if (!session.authenticated) return;
  $('nav-login').hidden = true;
  $('mobile-login').hidden = true;
  $('nav-user-name').textContent = session.user.displayName; // как текст, не как разметка
  $('nav-user-letter').textContent = [...session.user.displayName][0] || '?';
  $('nav-user').hidden = false;
});

/* ---------- Состояние сервера и базы данных (настоящий ответ сервера) ---------- */
async function loadServerHealth() {
  try {
    const { ok, data } = await apiFetch('/api/health');
    if (!ok || !data?.ok || !data.db?.ok) throw new Error('health_failed');

    setBadge($('hero-health-badge'), 'live', 'сервер на связи');
    setBadge($('db-badge'), 'ok', 'готово');
    $('db-state-val').textContent = 'Работает';
    $('db-safe-val').textContent = data.db.journalMode === 'wal' ? 'включена' : 'выключена';

    setBadge($('schema-badge'), 'ok', 'актуальна');
    $('schema-ver-val').textContent = `Версия ${data.db.schemaVersion}`;
    $('db-fk-val').textContent = data.db.foreignKeys ? 'включён' : 'выключен';
  } catch {
    setBadge($('hero-health-badge'), 'crimson', 'сервер не отвечает');
    setBadge($('db-badge'), 'crimson', 'нет связи');
    setBadge($('schema-badge'), 'crimson', 'нет связи');
    $('db-state-val').textContent = 'Нет ответа';
    $('schema-ver-val').textContent = '—';
  }
}

loadServerHealth();

/* ---------- Живой канал связи: подключение и замер задержки ---------- */
let wasDisconnected = false;
let pingRequested = false;
let pingTimeout = null;

const rt = connectRealtime({
  channel: 'home',
  onStatus(st) {
    if (st.state === 'connected') {
      setBadge($('ws-badge'), 'live', 'онлайн');
      if (typeof st.rttMs === 'number') {
        $('ws-rtt-val').textContent = `${st.rttMs} мс`;
        if (pingRequested) {
          // Ответ сервера на замер по кнопке — сообщаем настоящую цифру
          pingRequested = false;
          clearTimeout(pingTimeout);
          toast(`Задержка до сервера: ${st.rttMs} мс`, 'ok');
        }
      }
      if (typeof st.activeClients === 'number') $('ws-clients-val').textContent = String(st.activeClients);
      if (wasDisconnected) {
        // Связь вернулась — заново спрашиваем сервер о его состоянии
        wasDisconnected = false;
        loadServerHealth();
      }
    } else if (st.state === 'reconnecting') {
      wasDisconnected = true;
      setBadge($('ws-badge'), 'amber', 'переподключение');
      setBadge($('hero-health-badge'), 'amber', 'связь потеряна');
      $('ws-rtt-val').textContent = '— мс';
    } else if (!wasDisconnected) {
      setBadge($('ws-badge'), 'muted', 'подключение');
    }
  },
});

$('ws-ping-btn')?.addEventListener('click', () => {
  if (!rt.pingNow()) {
    toast('Связь с сервером восстанавливается, попробуйте через пару секунд', 'error');
    return;
  }
  pingRequested = true;
  clearTimeout(pingTimeout);
  pingTimeout = setTimeout(() => {
    if (!pingRequested) return;
    pingRequested = false;
    toast('Сервер не ответил на замер', 'error');
  }, 4000);
});

/* ---------- Образцы элементов управления ---------- */
const opacityInput = $('demo-opacity');
opacityInput?.addEventListener('input', () => {
  $('demo-opacity-label').textContent = `${opacityInput.value}%`;
});

$('demo-toast-btn')?.addEventListener('click', () => {
  const name = $('demo-source-name')?.value.trim() || 'Источник';
  toast(`«${name}» — так выглядит уведомление`, 'ok');
});

/* ---------- Проба настроек текста: образец меняется по мере ввода ---------- */
const textInput = $('demo-text');
const fontSelect = $('demo-font');
const textSample = $('demo-text-sample');
const textWarn = $('demo-text-warn');
const alignPills = [...document.querySelectorAll('[data-align]')];

const FONT_BY_KEY = {
  heading: 'var(--font-heading)',
  serif: 'var(--font-serif)',
  sans: 'var(--font-sans)',
  mono: 'var(--font-mono)',
};

function renderTextSample() {
  const text = textInput.value.trim();
  textSample.textContent = text; // textContent: введённое показывается как текст, а не как разметка
  textWarn.hidden = text.length > 0;
  textSample.style.fontFamily = FONT_BY_KEY[fontSelect.value] || FONT_BY_KEY.heading;
}

function setTextAlign(value) {
  alignPills.forEach((pill) => {
    const on = pill.dataset.align === value;
    pill.classList.toggle('active', on);
    pill.setAttribute('aria-pressed', String(on));
  });
  textSample.style.textAlign = value;
}

if (textInput && fontSelect && textSample && textWarn) {
  textInput.addEventListener('input', renderTextSample);
  fontSelect.addEventListener('change', renderTextSample);
  alignPills.forEach((pill) => pill.addEventListener('click', () => setTextAlign(pill.dataset.align)));

  $('demo-text-reset')?.addEventListener('click', () => {
    textInput.value = textInput.defaultValue;
    fontSelect.value = 'heading';
    setTextAlign('center');
    renderTextSample();
    toast('Настройки образца сброшены');
  });

  renderTextSample();
}
