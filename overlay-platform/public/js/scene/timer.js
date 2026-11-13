/* ==========================================================================
   Счёт таймера. Выполняется и в браузере, и на сервере.

   Таймер не «тикает» ни на сервере, ни на странице. Хранится только то, от чего
   считать: идёт ли он, сколько было на счётчике в момент пуска и когда его пустили
   (по часам сервера). Что показать прямо сейчас, каждая страница вычисляет сама.
   Поэтому у всех, кто смотрит сцену, цифры совпадают, а перезагрузка страницы
   или OBS таймер не сбивает.

   state = { running, base, since }
     running — идёт ли счёт
     base    — миллисекунды на счётчике в момент пуска или остановки
     since   — когда пустили (время сервера, миллисекунды); 0, если стоит
   ========================================================================== */

export const TIMER_MAX_SECONDS = 359_999; // 99:59:59
const MAX_MS = TIMER_MAX_SECONDS * 1000;

const clamp = (ms) => Math.min(MAX_MS, Math.max(0, ms));

// С чего начинает таймер с такими настройками
export function initialTimerState(settings) {
  return {
    running: false,
    base: settings.mode === 'countdown' ? clamp(settings.duration * 1000) : 0,
    since: 0,
  };
}

// Запись из базы или с сервера → гарантированно годное состояние
export function readTimerState(settings, stored) {
  const fresh = initialTimerState(settings);
  if (!stored || typeof stored !== 'object') return fresh;
  const { running, base, since } = stored;
  if (typeof running !== 'boolean' || !Number.isFinite(base) || !Number.isFinite(since)) return fresh;
  return { running, base: clamp(base), since: Math.max(0, since) };
}

/* Сколько сейчас на счётчике, в миллисекундах: для обратного отсчёта — сколько
   осталось, для секундомера — сколько прошло. */
export function timerValue(settings, state, now) {
  if (!state.running) return clamp(state.base);
  const passed = Math.max(0, now - state.since);
  return clamp(settings.mode === 'countdown' ? state.base - passed : state.base + passed);
}

// Обратный отсчёт дошёл до нуля. Сам он при этом не «останавливается»: останавливать некому
export function isTimerFinished(settings, state, now) {
  return settings.mode === 'countdown' && timerValue(settings, state, now) <= 0;
}

/* Что с таймером сейчас: 'running' — идёт, 'finished' — отсчёт дошёл до нуля,
   'idle' — стоит. По этому редактор решает, какие кнопки доступны. */
export function timerPhase(settings, state, now) {
  if (isTimerFinished(settings, state, now)) return 'finished';
  return state.running ? 'running' : 'idle';
}

/* Команда таймеру. Возвращает новое состояние или null, если такой команды нет.
   Время берётся у того, кто вызывает: на сервере это часы сервера. */
export function applyTimerCommand(settings, state, action, now) {
  if (action === 'reset') return initialTimerState(settings);

  if (action === 'start') {
    // Отсчёт, дошедший до нуля, запускается заново с полного времени
    if (isTimerFinished(settings, state, now)) {
      return { running: true, base: clamp(settings.duration * 1000), since: now };
    }
    if (state.running) return state;
    return { running: true, base: timerValue(settings, state, now), since: now };
  }

  if (action === 'pause') {
    if (!state.running) return state;
    return { running: false, base: timerValue(settings, state, now), since: 0 };
  }

  return null;
}

const two = (n) => String(n).padStart(2, '0');

// «05:00», а от часа и больше — «1:05:00»
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

// Часы: время сервера плюс выбранное смещение от UTC — одинаково у всех, кто смотрит
export function formatClock(now, utcOffsetMinutes, showSeconds) {
  const date = new Date(now + utcOffsetMinutes * 60_000);
  const text = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
  return showSeconds ? `${text}:${two(date.getUTCSeconds())}` : text;
}

// Что таймер показывает прямо сейчас
export function timerText(settings, state, now) {
  if (settings.mode === 'clock') return formatClock(now, settings.utcOffset, settings.showSeconds);
  const ms = timerValue(settings, state, now);
  if (settings.mode === 'countdown') {
    if (ms <= 0 && settings.endText) return settings.endText;
    // Округление вверх: «00:01» держится всю последнюю секунду, ноль появляется ровно в ноль
    return formatDuration(Math.ceil(ms / 1000));
  }
  return formatDuration(ms / 1000);
}
