/* ==========================================================================
   Атмосфера krafen.me: зерно, дождь, молнии и появление блоков.

   Зерно, дождь и вспышки повторяют оригинал (krafenz/app.js) по алгоритму
   и по числам. Отличие одно: в рабочей среде (body.studio) атмосфера по
   умолчанию выключена, а выключенный дождь не рисуется вообще, чтобы не
   отнимать ресурсы у компьютера, на котором идёт стрим.
   ========================================================================== */

const KEY_PUBLIC = 'krafen-overlay-atmo';
const KEY_STUDIO = 'krafen-overlay-atmo-studio';

const state = {
  studio: false,
  active: true,
  rain: null,
};

/* ---------- Зерно ----------
   Плитка 128×128: яркость каждой точки берётся из простого генератора
   псевдослучайных чисел с фиксированным стартом, поэтому рисунок зерна
   всегда один и тот же и совпадает с оригиналом точка в точку. */
let cachedGrainDataUrl = '';

export function initGrain() {
  const grainEl = document.querySelector('.grain');
  if (!grainEl) return;

  if (!cachedGrainDataUrl) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(128, 128);
      const d = img.data;
      let seed = 0x5f3759df;
      for (let i = 0; i < d.length; i += 4) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const v = (seed >>> 24) & 255;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
        d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      cachedGrainDataUrl = `url("${canvas.toDataURL('image/png')}")`;
    } catch {
      // Если холст недоступен, страница остаётся без зерна, но работает
    }
  }

  if (cachedGrainDataUrl) {
    grainEl.style.backgroundImage = cachedGrainDataUrl;
  }
}

/* ---------- Включение и выключение атмосферы ---------- */
function storageKey() {
  return state.studio ? KEY_STUDIO : KEY_PUBLIC;
}

export function isAtmosphereActive() {
  return state.active;
}

export function setAtmosphereActive(active, { persist = false } = {}) {
  state.active = Boolean(active);
  document.body.classList.toggle('calm', !state.active);

  document.querySelectorAll('[data-atmo-toggle]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(state.active));
  });
  document.querySelectorAll('[data-atmo-label]').forEach((el) => {
    el.textContent = state.active ? el.dataset.on : el.dataset.off;
  });

  if (persist) {
    try {
      localStorage.setItem(storageKey(), state.active ? '1' : '0');
    } catch {
      // Хранилище может быть запрещено настройками браузера — это не ошибка
    }
  }

  state.rain?.sync();
}

export function initAtmosphere() {
  state.studio = document.body.classList.contains('studio');
  initGrain();

  // Обычные страницы: гроза включена. Рабочая среда: спокойный фон.
  let active = !state.studio;
  try {
    const saved = localStorage.getItem(storageKey());
    if (saved !== null) active = saved === '1';
  } catch {
    // см. выше
  }

  state.rain = initRain();
  setAtmosphereActive(active);

  document.querySelectorAll('[data-atmo-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setAtmosphereActive(!state.active, { persist: true });
    });
  });

  observeReveals(document);
}

/* ---------- Дождь и молнии ---------- */
function initRain() {
  const cv = document.getElementById('rain');
  if (!cv) return null;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;

  const ctx = cv.getContext('2d', { alpha: true, desynchronized: true }) || cv.getContext('2d');
  if (!ctx) return null;

  let W = 0;
  let H = 0;
  const BUCKET_ALPHAS = [0.08, 0.14, 0.22];
  let buckets = [[], [], []];
  let rainRaf = null;
  let lastTs = 0;
  let resizeTimer = null;

  function spawn(anywhere) {
    return {
      x: Math.random() * W,
      y: anywhere ? Math.random() * H : -20 - Math.random() * 40,
      l: 10 + Math.random() * 18,
      v: 8.5 + Math.random() * 8.5,
    };
  }

  function rebuildDrops() {
    W = cv.width = window.innerWidth;
    H = cv.height = window.innerHeight;
    const total = Math.min(260, Math.max(48, Math.floor(W / 7)));
    buckets = [[], [], []];
    for (let i = 0; i < total; i += 1) {
      buckets[i % 3].push(spawn(true));
    }
  }

  window.addEventListener(
    'resize',
    () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(rebuildDrops, 100);
    },
    { passive: true }
  );
  rebuildDrops();

  // На обычных страницах «штиль» лишь приглушает дождь (как в оригинале),
  // в рабочей среде — останавливает отрисовку полностью.
  const shouldRun = () => !document.hidden && (state.active || !state.studio);

  function loop(now) {
    if (!shouldRun()) {
      rainRaf = null;
      ctx.clearRect(0, 0, W, H);
      return;
    }
    const dtScale = lastTs ? Math.min(2.4, Math.max(0.2, (now - lastTs) / 16.6667)) : 1;
    lastTs = now;

    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#9aa4b8';
    ctx.lineWidth = 1;

    const dx = 0.6 * dtScale;
    for (let b = 0; b < 3; b += 1) {
      const list = buckets[b];
      if (!list.length) continue;
      ctx.globalAlpha = BUCKET_ALPHAS[b];
      ctx.beginPath();
      for (let i = 0; i < list.length; i += 1) {
        const d = list[i];
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - 1.5, d.y + d.l);
        d.y += d.v * dtScale;
        d.x -= dx;
        if (d.y > H) {
          d.x = Math.random() * W;
          d.y = -20 - Math.random() * 30;
        }
      }
      ctx.stroke();
    }
    rainRaf = requestAnimationFrame(loop);
  }

  function sync() {
    if (!rainRaf && shouldRun()) {
      lastTs = 0;
      rainRaf = requestAnimationFrame(loop);
    }
  }
  document.addEventListener('visibilitychange', sync);

  const flash = document.getElementById('flash');
  function schedule() {
    setTimeout(lightning, 6000 + Math.random() * 14000);
  }
  function lightning() {
    if (!flash || document.hidden || !state.active) {
      schedule();
      return;
    }
    const bursts = 1 + Math.floor(Math.random() * 3);
    let n = 0;
    (function flick() {
      flash.style.transition = 'none';
      flash.style.opacity = String(0.18 + Math.random() * 0.3);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          flash.style.transition = 'opacity .6s ease-out';
          flash.style.opacity = '0';
        })
      );
      n += 1;
      if (n < bursts) setTimeout(flick, 90 + Math.random() * 140);
    })();
    schedule();
  }
  setTimeout(lightning, 2500);

  return { sync };
}

/* ---------- Появление блоков ----------
   На обычных страницах, как в оригинале, блок проявляется при входе в экран
   и снова прячется при уходе. В рабочей среде блок проявляется один раз:
   повторная анимация при каждой прокрутке мешала бы работе. */
let revealObserver = null;

export function observeReveals(root = document) {
  const nodes = root.querySelectorAll('.reveal:not(.visible)');
  if (!nodes.length) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !('IntersectionObserver' in window)) {
    nodes.forEach((el) => el.classList.add('visible'));
    return;
  }

  if (!revealObserver) {
    const once = document.body.classList.contains('studio');
    revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (once) {
            if (entry.isIntersecting) {
              entry.target.classList.add('visible');
              revealObserver.unobserve(entry.target);
            }
          } else {
            entry.target.classList.toggle('visible', entry.isIntersecting);
          }
        });
      },
      { threshold: 0.08, rootMargin: '0px 0px -6% 0px' }
    );
  }

  nodes.forEach((el) => revealObserver.observe(el));
}
