import { initAtmosphere } from '../core/atmosphere.js';
import { initMobileNav } from '../core/ui.js';
import { connectRealtime } from '../core/api.js';

initAtmosphere();
initMobileNav();

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
const wsStatus = document.getElementById('shell-ws-status');

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
