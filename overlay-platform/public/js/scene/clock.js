/* ==========================================================================
   Часы сервера на странице.

   Таймеры на сцене считают время по часам сервера: тогда цифры совпадают
   у всех — в редакторе, у модераторов и в OBS, — даже если часы какого-то
   компьютера спешат или отстают.

   Страница не «переводит» свои часы, а помнит разницу: на сколько часы сервера
   впереди часов устройства. Разница уточняется при каждом ответе сервера,
   в котором есть его время. Замер тем точнее, чем быстрее пришёл ответ:
   ошибка не больше половины времени, за которое запрос сходил туда и обратно.
   ========================================================================== */

// Запас на то, что часы устройства понемногу уходят: старый замер со временем «дешевеет»
const DRIFT_PER_MS = 0.001;
// Разница изменилась заметнее, чем могли ошибиться оба замера, — значит, часы устройства перевели
const JUMP_MARGIN_MS = 250;

export function createServerClock({ localNow = () => Date.now(), steady = () => performance.now() } = {}) {
  let offset = 0; // на сколько часы сервера впереди часов устройства, мс
  let error = Infinity; // возможная ошибка действующего замера, мс
  let takenAt = 0;

  return {
    // Время сервера прямо сейчас, в миллисекундах
    now: () => localNow() + offset,

    /* Новый замер. serverTime — время сервера из ответа; tripMs — за сколько запрос
       сходил туда и обратно. Вызывать сразу, как пришёл ответ.
       Возвращает true, если замер принят. */
    sample(serverTime, tripMs) {
      if (!Number.isFinite(serverTime) || !Number.isFinite(tripMs) || tripMs < 0) return false;
      const fresh = serverTime + tripMs / 2 - localNow();
      const freshError = tripMs / 2;
      const currentError = error + (steady() - takenAt) * DRIFT_PER_MS;
      const jumped = Math.abs(fresh - offset) > freshError + currentError + JUMP_MARGIN_MS;
      // Менее точный замер не заменяет более точный — если только часы устройства не перевели
      if (freshError > currentError && !jumped) return false;
      offset = fresh;
      error = freshError;
      takenAt = steady();
      return true;
    },
  };
}
