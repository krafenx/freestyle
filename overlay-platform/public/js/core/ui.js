/* ==========================================================================
   Общие помощники интерфейса: уведомления, окна, вкладки, мобильное меню,
   ползунки и боковой указатель секций.
   ========================================================================== */

/* Текст от пользователя или с сервера вставляется на страницу только через
   textContent — как текст, а не как разметка. Страницы не собирают разметку из строк
   (innerHTML и подобное): это проверяется тестом. Единственное место, где разметку
   пишет сам человек, — свой блок виджета; он показывается в отдельной рамке без
   скриптов (js/scene/html-block.js). */

/* ---------- Всплывающее уведомление ---------- */
let toastTimer = null;
let toastFrame = null;

// Сколько уведомление держится на экране: короткое — около трёх секунд, длинное — дольше,
// чтобы его успели прочитать
const toastDuration = (text) => Math.min(9000, 2800 + Math.max(0, text.length - 50) * 50);

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
  cancelAnimationFrame(toastFrame);
  // Даём браузеру кадр, чтобы уведомление выехало плавно даже при первом показе.
  // Время показа отсчитываем от самого появления: если вкладка была свёрнута, человек
  // увидит уведомление, когда вернётся, и оно не останется висеть на экране навсегда.
  toastFrame = requestAnimationFrame(() => {
    el.classList.add('show');
    toastTimer = setTimeout(() => el.classList.remove('show'), toastDuration(String(message)));
  });
}

/* ---------- Окна поверх страницы ---------- */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const modalReturnFocus = new Map();

export function openModal(id) {
  const el = document.getElementById(id);
  if (!el || el.classList.contains('open')) return;
  modalReturnFocus.set(id, document.activeElement);
  el.classList.add('open');
  document.documentElement.classList.add('modal-open'); // страница под окном не прокручивается (tokens.css)
  // Фокус переносим внутрь окна, чтобы клавиатура работала с ним, а не со страницей под ним
  const target = el.querySelector('[data-autofocus]') || el.querySelector(FOCUSABLE);
  target?.focus({ preventScroll: true });
}

export function closeModal(id) {
  const el = document.getElementById(id);
  if (!el || !el.classList.contains('open')) return;
  el.classList.remove('open');
  if (!document.querySelector('.modal.open')) {
    document.documentElement.classList.remove('modal-open');
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
    // Окно с пометкой data-sticky закрывается только своей кнопкой: в нём показывают
    // то, что нельзя увидеть повторно, и случайный щелчок мимо не должен это стирать
    if (
      e.target === pressedOnBackdrop &&
      e.target.classList.contains('open') &&
      !e.target.hasAttribute('data-sticky')
    ) {
      closeModal(e.target.id);
    }
  });

  document.addEventListener('keydown', (e) => {
    const opened = [...document.querySelectorAll('.modal.open')].pop();
    if (!opened) return;

    if (e.key === 'Escape') {
      if (!opened.hasAttribute('data-sticky')) closeModal(opened.id);
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

/* ---------- Вкладки боковой панели ----------
   Вкладка с id="tab-plan" открывает блок из aria-controls и запоминается в адресе
   как #plan: после обновления страницы человек остаётся на том же разделе,
   и на раздел можно дать ссылку. Первая вкладка — раздел по умолчанию, без #. */
export function initTabs({ selector = '.sidebar-nav [role="tab"]', onSelect } = {}) {
  const tabs = [...document.querySelectorAll(selector)];
  if (!tabs.length) return;
  const keyOf = (tab) => tab.id.replace(/^tab-/, '');

  function select(tab, { focus = false, remember = true } = {}) {
    tabs.forEach((t) => {
      const selected = t === tab;
      t.classList.toggle('active', selected);
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      const pane = document.getElementById(t.getAttribute('aria-controls'));
      if (pane) pane.hidden = !selected;
    });
    if (focus) tab.focus();
    if (remember) {
      const hash = tab === tabs[0] ? '' : `#${keyOf(tab)}`;
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    }
    onSelect?.(keyOf(tab));
  }

  const fromAddress = () => tabs.find((t) => keyOf(t) === window.location.hash.slice(1)) || tabs[0];

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (e) => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      select(tabs[(index + step + tabs.length) % tabs.length], { focus: true });
    });
  });

  window.addEventListener('hashchange', () => select(fromAddress(), { remember: false }));
  if (fromAddress() !== tabs[0]) select(fromAddress(), { remember: false });
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
    document.documentElement.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus({ preventScroll: true });
  };

  const open = () => {
    drawer.classList.add('open');
    document.documentElement.classList.add('nav-open');
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
