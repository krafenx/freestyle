/* ==========================================================================
   Общее для страниц кабинета (/app и страница площадки): кто вошёл,
   кнопки выхода и индикатор живого канала связи в шапке.
   ========================================================================== */
import { initialOf } from './format.js';
import { withBusy } from './forms.js';
import { logout } from './session.js';
import { toast } from './ui.js';

// Имя вставляется как текст (textContent): что бы человек ни написал, это останется текстом
export function showUserChip(user) {
  const chip = document.getElementById('user-chip');
  if (!chip) return;
  document.getElementById('user-chip-name').textContent = user.displayName;
  document.getElementById('user-chip-letter').textContent = initialOf(user.displayName);
  chip.hidden = false;
}

export function bindLogout() {
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
}

/* Индикатор связи в шапке. Возвращает функцию для onStatus живого канала.
   Надписи короткие намеренно: на телефоне шириной 320 точек рядом с индикатором
   должны поместиться название сайта и кнопка меню. Замер задержки — отдельная часть:
   на самых узких экранах стили её скрывают. */
export function liveBadge(el) {
  function set(tone, text, extra = '', hint = '') {
    if (!el) return;
    el.className = `status-badge ${tone}`;
    const label = document.createElement('span');
    label.textContent = text;
    if (extra) label.append(Object.assign(document.createElement('span'), { className: 'badge-extra', textContent: extra }));
    el.replaceChildren(Object.assign(document.createElement('span'), { className: 'dot' }), label);
    el.title = hint;
  }
  return (st) => {
    if (st.state === 'connected') {
      set('live', 'на связи', typeof st.rttMs === 'number' ? ` · ${st.rttMs} мс` : '', 'Страница обновляется сама');
    } else if (st.state === 'reconnecting') {
      set('amber', 'нет связи', '', 'Связь с сервером потеряна. Страница переподключается сама');
    } else if (st.state === 'denied') {
      set('muted', 'отключено', '', 'Живое обновление этой страницы остановлено');
    } else {
      set('muted', 'связь…', '', 'Подключаемся к серверу');
    }
  };
}
