import { el } from '../dom.js';
import { buildBlockPage } from '../html-block.js';

/* Источник «Виджет»: шкала цели, бегущая строка, карточка эфира и свой блок на HTML и CSS.

   Первые три собираются из обычных элементов, а текст в них вставляется как текст.
   Свой блок — единственное место платформы, куда человек пишет разметку сам. Он живёт
   в отдельной рамке-«песочнице»: без скриптов, без доступа к странице редактора
   и аккаунту, без обращений к чужим сайтам (подробно — в ../html-block.js). */

const HTML_SAMPLE = `<style>
  body {
    display: grid;
    place-items: center;
    height: 100vh;
    font: 600 34px/1.2 "Manrope", Arial, sans-serif;
    color: #fff;
    text-shadow: 0 2px 18px rgba(0, 0, 0, 0.85);
  }
  .pulse {
    animation: pulse 2.4s ease-in-out infinite;
  }
  @keyframes pulse {
    50% { opacity: 0.55; }
  }
</style>
<div class="pulse">Свой блок</div>`;

const number = (n) => n.toLocaleString('ru-RU');

/* ---------- Шкала цели ---------- */
function buildGoal(body) {
  const root = el('div', 'kf-widget kf-goal');
  const head = el('div', 'kf-goal-head');
  const title = el('span', 'kf-goal-title');
  const count = el('span', 'kf-goal-count');
  const bar = el('div', 'kf-goal-bar');
  const fill = el('div', 'kf-goal-fill');
  const percent = el('div', 'kf-goal-percent');
  head.append(title, count);
  bar.append(fill);
  root.append(head, bar, percent);
  body.append(root);
  return {
    root,
    update(s) {
      const share = Math.min(100, Math.round((s.goalCurrent / s.goalTarget) * 100));
      const unit = s.goalUnit ? ` ${s.goalUnit}` : '';
      title.textContent = s.goalTitle;
      count.textContent = `${number(s.goalCurrent)} / ${number(s.goalTarget)}${unit}`;
      fill.style.width = `${share}%`;
      percent.textContent = `${share}%`;
    },
  };
}

/* ---------- Бегущая строка ---------- */
function buildTicker(body) {
  const root = el('div', 'kf-widget kf-ticker');
  const run = el('div', 'kf-ticker-run');
  root.append(run);
  body.append(root);

  let speed = 120;
  let width = 0;
  // Строка проходит путь «ширина рамки + своя длина» с заданной скоростью
  const measure = () => {
    run.style.setProperty('--kf-ticker-from', `${width}px`);
    run.style.animationDuration = `${Math.max(1, (width + run.offsetWidth) / speed)}s`;
  };
  // Когда догрузится шрифт, длина строки изменится — пересчитываем один раз
  document.fonts?.ready.then(measure).catch(() => {});

  return {
    root,
    update(s, source) {
      run.textContent = s.tickerText;
      speed = s.tickerSpeed;
      width = source.width;
      measure();
    },
  };
}

/* ---------- Карточка эфира ---------- */
function buildCard(body) {
  const root = el('div', 'kf-widget kf-card');
  const badge = el('div', 'kf-card-badge');
  const title = el('div', 'kf-card-title');
  const text = el('div', 'kf-card-text');
  root.append(badge, title, text);
  body.append(root);
  return {
    root,
    update(s) {
      badge.textContent = s.cardBadge;
      badge.hidden = !s.cardBadge;
      title.textContent = s.cardTitle;
      text.textContent = s.cardText;
      text.hidden = !s.cardText;
    },
  };
}

/* ---------- Свой блок на HTML и CSS ----------
   Пустая пометка sandbox — самая строгая: в рамке не выполняются скрипты, не отправляются
   формы, не открываются окна, а её содержимое для браузера — посторонний сайт без имени.
   Разрешения (allow-scripts, allow-same-origin и другие) сюда добавлять нельзя. */
function buildHtml(body) {
  let frame = null;
  let shown = null;
  let timer = null;

  const mount = (html) => {
    frame?.remove();
    frame = el('iframe', 'kf-frame');
    frame.setAttribute('sandbox', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('title', 'Свой блок');
    frame.tabIndex = -1;
    frame.srcdoc = buildBlockPage(html);
    body.append(frame);
  };

  return {
    root: null,
    update(s) {
      if (s.html === shown) return;
      const first = shown === null;
      shown = s.html;
      clearTimeout(timer);
      // Пока человек печатает, рамка не перезапускается на каждую букву
      if (first) mount(shown);
      else timer = setTimeout(() => mount(shown), 400);
    },
    dispose() {
      clearTimeout(timer);
      frame?.remove();
    },
  };
}

const BUILDERS = { goal: buildGoal, ticker: buildTicker, card: buildCard, html: buildHtml };
const only = (kind) => (s) => s.kind === kind;

export default {
  type: 'widget',
  title: 'Виджет',
  about: 'Шкала цели, бегущая строка, карточка эфира или свой блок на HTML и CSS.',
  icon: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  size: { width: 640, height: 150 },

  groups: [
    { id: 'kind', title: 'Виджет' },
    { id: 'goal', title: 'Цель' },
    { id: 'ticker', title: 'Бегущая строка' },
    { id: 'card', title: 'Карточка' },
    { id: 'html', title: 'Свой блок' },
    { id: 'look', title: 'Вид' },
  ],
  fields: {
    kind: {
      kind: 'choice', default: 'goal', label: 'Какой виджет', group: 'kind',
      options: [
        { value: 'goal', label: 'Шкала цели' },
        { value: 'ticker', label: 'Бегущая строка' },
        { value: 'card', label: 'Карточка эфира' },
        { value: 'html', label: 'Свой блок на HTML и CSS' },
      ],
    },

    goalTitle: { kind: 'text', max: 60, default: 'Цель стрима', label: 'Название цели', group: 'goal', when: only('goal') },
    goalCurrent: { kind: 'int', min: 0, max: 999_999_999, default: 0, label: 'Собрано', group: 'goal', when: only('goal') },
    goalTarget: { kind: 'int', min: 1, max: 999_999_999, default: 100, label: 'Цель', group: 'goal', when: only('goal') },
    goalUnit: {
      kind: 'text', max: 8, default: '', label: 'Единица', group: 'goal', when: only('goal'),
      hint: 'Например ₽ или «подписчиков». Число «Собрано» меняют вручную: к сервисам доната платформа не подключена.',
    },

    tickerText: { kind: 'text', max: 300, default: 'Добро пожаловать на стрим', label: 'Текст строки', group: 'ticker', when: only('ticker') },
    tickerSpeed: { kind: 'int', min: 20, max: 600, default: 120, label: 'Скорость', unit: 'px/с', control: 'range', group: 'ticker', when: only('ticker') },

    cardBadge: { kind: 'text', max: 24, default: 'в эфире', label: 'Метка', group: 'card', when: only('card') },
    cardTitle: { kind: 'text', max: 60, default: 'Название эфира', label: 'Заголовок', group: 'card', when: only('card') },
    cardText: { kind: 'text', max: 160, default: 'Коротко о том, что сейчас происходит', label: 'Подпись', group: 'card', when: only('card') },

    html: {
      kind: 'code', max: 20_000, default: HTML_SAMPLE, label: 'Код блока (HTML и CSS)', group: 'html', when: only('html'),
      hint: 'Блок показывается в отдельной рамке. Скрипты в нём не выполняются, а с других сайтов ничего не загружается — ни картинки, ни шрифты: иначе автор блока узнал бы сетевой адрес компьютера, где открыт OBS. Шрифты платформы доступны по названиям: Alice, Cormorant Infant, Manrope, JetBrains Mono, Medula One. Движение задаётся средствами CSS (animation).',
    },

    accent: { kind: 'color', default: '#a31313', label: 'Цвет акцента', group: 'look', when: (s) => s.kind !== 'html' },
    fontSize: { kind: 'int', min: 12, max: 160, default: 30, label: 'Размер текста', unit: 'px', control: 'range', group: 'look', when: (s) => s.kind !== 'html' },
  },

  render(node, source, ctx) {
    const s = source.settings;
    if (node.parts?.kind !== s.kind) {
      node.parts?.view.dispose?.();
      node.body.replaceChildren();
      node.parts = { kind: s.kind, view: BUILDERS[s.kind](node.body) };
      node.dispose = () => node.parts?.view.dispose?.();
    }
    const { view } = node.parts;
    if (view.root) {
      view.root.style.setProperty('--kf-accent', s.accent);
      view.root.style.setProperty('--kf-size', `${s.fontSize}px`);
    }
    view.update(s, source);
  },
};
