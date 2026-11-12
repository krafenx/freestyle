/* ==========================================================================
   Общие помощники интерфейса: уведомления, окна, мобильное меню,
   ползунки и боковой указатель секций.
   ========================================================================== */

/* Любой текст, пришедший от пользователя или с сервера, перед вставкой
   в разметку страницы пропускается через эту функцию. */
export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

/* ---------- Всплывающее уведомление ---------- */
let toastTimer = null;

export function toast(message, tone = 'default') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }

  el.textContent = message;
  el.className = `toast ${tone === 'ok' || tone === 'error' ? tone : ''}`.trim();

  clearTimeout(toastTimer);
  // Даём браузеру кадр, чтобы уведомление выехало плавно даже при первом показе
  requestAnimationFrame(() => el.classList.add('show'));
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ---------- Окна поверх страницы ---------- */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const modalReturnFocus = new Map();

export function openModal(id) {
  const el = document.getElementById(id);
  if (!el || el.classList.contains('open')) return;
  modalReturnFocus.set(id, document.activeElement);
  el.classList.add('open');
  document.body.classList.add('modal-open');
  // Фокус переносим внутрь окна, чтобы клавиатура работала с ним, а не со страницей под ним
  const target = el.querySelector('[data-autofocus]') || el.querySelector(FOCUSABLE);
  target?.focus({ preventScroll: true });
}

export function closeModal(id) {
  const el = document.getElementById(id);
  if (!el || !el.classList.contains('open')) return;
  el.classList.remove('open');
  if (!document.querySelector('.modal.open')) {
    document.body.classList.remove('modal-open');
  }
  const back = modalReturnFocus.get(id);
  modalReturnFocus.delete(id);
  if (back && document.contains(back)) back.focus({ preventScroll: true });
}

let modalEventsBound = false;

export function bindModalDismiss() {
  if (modalEventsBound) return;
  modalEventsBound = true;

  // Закрытие — только если и нажатие, и отпускание пришлись на затемнённый фон.
  // Иначе окно закрывалось бы, когда человек выделяет текст и уводит курсор за край.
  let pressedOnBackdrop = null;
  document.addEventListener('pointerdown', (e) => {
    pressedOnBackdrop = e.target.classList?.contains('modal') ? e.target : null;
  });

  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close-modal]');
    if (closeBtn) {
      const targetId = closeBtn.getAttribute('data-close-modal') || closeBtn.closest('.modal')?.id;
      if (targetId) closeModal(targetId);
      return;
    }
    const openBtn = e.target.closest('[data-open-modal]');
    if (openBtn) {
      openModal(openBtn.getAttribute('data-open-modal'));
      return;
    }
    if (e.target === pressedOnBackdrop && e.target.classList.contains('open')) {
      closeModal(e.target.id);
    }
  });

  document.addEventListener('keydown', (e) => {
    const opened = [...document.querySelectorAll('.modal.open')].pop();
    if (!opened) return;

    if (e.key === 'Escape') {
      closeModal(opened.id);
      return;
    }
    if (e.key === 'Tab') {
      // Tab ходит по кругу внутри открытого окна
      const items = [...opened.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!opened.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

/* ---------- Мобильное меню ---------- */
export function initMobileNav() {
  const toggle = document.getElementById('menu-toggle');
  const drawer = document.getElementById('mobile-nav');
  if (!toggle || !drawer) return;
  const closeBtn = drawer.querySelector('.mobile-nav-close');

  const close = () => {
    if (!drawer.classList.contains('open')) return;
    drawer.classList.remove('open');
    document.body.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus({ preventScroll: true });
  };

  const open = () => {
    drawer.classList.add('open');
    document.body.classList.add('nav-open');
    toggle.setAttribute('aria-expanded', 'true');
    closeBtn?.focus({ preventScroll: true });
  };

  toggle.addEventListener('click', () => {
    if (drawer.classList.contains('open')) close();
    else open();
  });

  closeBtn?.addEventListener('click', close);
  drawer.querySelectorAll('a').forEach((a) => a.addEventListener('click', close));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  window.addEventListener(
    'resize',
    () => {
      if (window.innerWidth > 980) close();
    },
    { passive: true }
  );
}

/* ---------- Ползунки ----------
   Закрашенная часть дорожки рисуется через переменную --fill. */
export function bindRangeFill(root = document) {
  const paint = (input) => {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const val = Number(input.value);
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', `${Math.min(100, Math.max(0, pct))}%`);
  };
  root.querySelectorAll('input[type="range"].kf-range').forEach((input) => {
    paint(input);
    input.addEventListener('input', () => paint(input));
  });
  return paint;
}

/* ---------- Боковой указатель секций ----------
   Подсвечивает точку текущей секции и двигает багровую метку вдоль линии
   пропорционально прокрутке страницы. */
export function initRail() {
  const links = [...document.querySelectorAll('.rail a[data-sec]')];
  if (!links.length) return;

  const sections = links
    .map((a) => document.getElementById(a.dataset.sec))
    .filter(Boolean);
  const progress = document.getElementById('rail-progress');
  const line = document.querySelector('.rail-line');

  const setActive = (id) => {
    links.forEach((a) => a.classList.toggle('active', a.dataset.sec === id));
  };

  let ticking = false;
  const update = () => {
    ticking = false;
    const y = window.scrollY;
    const vh = window.innerHeight || 1;
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - vh);

    // Активной считается секция, занимающая середину экрана
    const mid = y + vh * 0.45;
    let current = sections[0]?.id;
    for (const sec of sections) {
      if (sec.getBoundingClientRect().top + y <= mid) current = sec.id;
    }
    if (y >= maxScroll - 2) current = sections[sections.length - 1]?.id;
    setActive(current);

    if (progress && line) {
      const span = Math.max(0, line.offsetHeight - progress.offsetHeight);
      progress.style.transform = `translate3d(0, ${span * Math.min(1, y / maxScroll)}px, 0)`;
    }
  };

  const onScroll = () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  update();
}
