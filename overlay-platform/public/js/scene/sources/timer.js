import { el } from '../dom.js';
import {
  TIMER_MAX_SECONDS, applyTimerCommand, initialTimerState, readTimerState, timerPhase, timerText,
} from '../timer.js';
import { TYPE_GROUPS, applyType, setLabelText, typeFields } from './type-fields.js';

/* Источник «Таймер»: обратный отсчёт, секундомер и часы.
   Как устроен счёт и почему цифры у всех совпадают — см. ../timer.js. */

// Смещения от UTC, которые реально используются в мире. У российских — города: в России
// нет перехода на летнее время, поэтому подпись не устаревает
const CITIES = {
  120: 'Калининград', 180: 'Москва', 240: 'Самара', 300: 'Екатеринбург', 360: 'Омск', 420: 'Новосибирск',
  480: 'Иркутск', 540: 'Якутск', 600: 'Владивосток', 660: 'Магадан', 720: 'Камчатка',
};
const UTC_OFFSETS = [
  -720, -660, -600, -570, -540, -480, -420, -360, -300, -240, -210, -180, -120, -60, 0,
  60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 525, 540, 570, 600, 630, 660, 720, 765, 780, 840,
].map((value) => {
  const abs = Math.abs(value);
  const text = `UTC${value < 0 ? '−' : '+'}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
  return { value, label: CITIES[value] ? `${text} · ${CITIES[value]}` : text };
});

export default {
  type: 'timer',
  title: 'Таймер',
  about: 'Обратный отсчёт, секундомер или часы. Цифры у всех совпадают.',
  icon: 'M12 5a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 9v4l2.5 2.5M9 2h6',
  size: { width: 440, height: 170 },

  groups: [{ id: 'mode', title: 'Режим' }, ...TYPE_GROUPS],
  fields: {
    mode: {
      kind: 'choice', default: 'countdown', label: 'Что показывает', group: 'mode',
      options: [
        { value: 'countdown', label: 'Обратный отсчёт' },
        { value: 'stopwatch', label: 'Секундомер' },
        { value: 'clock', label: 'Часы' },
      ],
    },
    duration: {
      kind: 'int', min: 1, max: TIMER_MAX_SECONDS, default: 300, label: 'Сколько отсчитывать',
      control: 'duration', group: 'mode', when: (s) => s.mode === 'countdown',
      hint: 'Если изменить время, отсчёт начнётся заново.',
    },
    endText: {
      kind: 'text', max: 60, default: '', label: 'Надпись, когда время вышло', group: 'mode',
      when: (s) => s.mode === 'countdown', hint: 'Если оставить пустым, останется 00:00.',
    },
    showSeconds: { kind: 'bool', default: true, label: 'Показывать секунды', group: 'mode', when: (s) => s.mode === 'clock' },
    utcOffset: {
      kind: 'choice', options: UTC_OFFSETS, default: 180, label: 'Часовой пояс', group: 'mode',
      when: (s) => s.mode === 'clock',
      hint: 'Часы идут по времени сервера с этим смещением — у всех одинаково. При переходе на летнее или зимнее время пояс меняют вручную.',
    },
    ...typeFields({ font: 'mono', size: 96 }),
  },

  /* Ход таймера хранит сервер. Страница может только попросить: пустить, остановить,
     сбросить — время при этом берётся по часам сервера. */
  commands: [
    { action: 'start', label: 'Пуск', enabled: (settings, state, now) => timerPhase(settings, state, now) !== 'running' },
    { action: 'pause', label: 'Пауза', enabled: (settings, state, now) => timerPhase(settings, state, now) === 'running' },
    { action: 'reset', label: 'Сброс' },
  ],
  hasCommands: (settings) => settings.mode !== 'clock',
  // Одной строкой для панели свойств: что с таймером сейчас
  status(settings, state, now) {
    const value = timerText({ ...settings, endText: '' }, state, now);
    const phase = timerPhase(settings, state, now);
    return `${phase === 'finished' ? 'время вышло' : phase === 'running' ? 'идёт' : 'стоит'} · ${value}`;
  },
  initialState: initialTimerState,
  readState: readTimerState,
  // Сменили режим или время отсчёта — прежний счёт теряет смысл
  stateAfterChange(previous, next, state) {
    return previous.mode !== next.mode || previous.duration !== next.duration ? initialTimerState(next) : state;
  },
  command(settings, state, action, now) {
    return settings.mode === 'clock' ? null : applyTimerCommand(settings, state, action, now);
  },

  render(node, source, ctx) {
    if (!node.parts) {
      const box = el('div', 'kf-text');
      const label = el('div', 'kf-text-label kf-timer-label');
      box.append(label);
      node.body.append(box);
      node.parts = { box, label, shown: null };
    }
    const { parts } = node;
    applyType(parts.box, parts.label, source.settings);

    const state = readTimerState(source.settings, source.state);
    node.tick = (now) => {
      const text = timerText(source.settings, state, now);
      if (text === parts.shown) return;
      parts.shown = text;
      setLabelText(parts.label, text);
    };
    node.tick(ctx.now());
  },
};
