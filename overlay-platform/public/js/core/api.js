/* ==========================================================================
   Связь страницы с сервером: обычные запросы и живой канал (WebSocket).
   Адреса только относительные, поэтому страница одинаково работает на своём
   домене, за промежуточным сервером, в предпросмотре и внутри OBS.
   ========================================================================== */

/* Сколько ждать ответа сервера. Без предела запрос при «зависшей» связи мог бы
   висеть минутами, а кнопка всё это время оставалась бы в состоянии «отправляется». */
const REQUEST_TIMEOUT_MS = 20_000;

export async function apiFetch(path, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers || {});
  const isJsonBody =
    fetchOptions.body && typeof fetchOptions.body === 'object' && !(fetchOptions.body instanceof FormData);

  if (isJsonBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  // Истёкшее ожидание обрывает запрос; для вызывающего это выглядит как обрыв связи
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(path, {
      ...fetchOptions,
      headers,
      credentials: 'same-origin',
      body: isJsonBody ? JSON.stringify(fetchOptions.body) : fetchOptions.body,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/* Живой канал связи. Сам переподключается после обрыва: сначала быстро,
   потом реже, а при возвращении сети или вкладки — сразу. Раз в 10 секунд
   измеряет задержку до сервера.

   Каналу площадки нужен одноразовый пропуск. Его добывает функция ticket —
   обычным запросом, где сервер проверяет вход и права. Она возвращает
   { ticket } — пропуск получен, { denied: true } — доступа нет (тогда канал
   больше не подключается), а всё остальное значит «попробовать позже».

   Каналу оверлея вместо пропуска нужен ключ — ссылка оверлея (key): страница
   в OBS не входит в аккаунт, и получить пропуск ей не на что. */
export function connectRealtime({ channel = 'system', ticket, key, onMessage, onStatus } = {}) {
  let ws = null;
  let stopped = false;
  let waitingTicket = false;
  let reconnectTimer = null;
  let pingTimer = null;
  let attempt = 0;
  let turn = 0; // номер попытки: ответ на устаревшую попытку не учитывается

  function buildWsUrl(pass) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ channel });
    if (pass) params.set('ticket', pass);
    if (key) params.set('key', key);
    return `${proto}//${window.location.host}/ws?${params.toString()}`;
  }

  function sendPing(socket) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping', clientTs: Math.round(performance.now()) }));
      return true;
    }
    return false;
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    // С пропуском каждая попытка — ещё и запрос к серверу, поэтому паузы растут дольше
    const delay = Math.min(ticket ? 30_000 : 8000, 700 * 2 ** Math.min(attempt, 6));
    attempt += 1;
    onStatus?.({ state: 'reconnecting', attempt, delay });
    reconnectTimer = setTimeout(openSocket, delay);
  }

  function stop() {
    stopped = true;
    turn += 1;
    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);
    window.removeEventListener('online', wakeUp);
    document.removeEventListener('visibilitychange', wakeUp);
    if (ws) ws.close();
    ws = null;
  }

  async function openSocket() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    turn += 1;
    const mine = turn;
    onStatus?.({ state: 'connecting' });

    let pass = null;
    if (ticket) {
      waitingTicket = true;
      let answer = null;
      try {
        answer = await ticket();
      } catch {
        answer = null;
      }
      if (mine !== turn) return; // пока ждали ответа, канал закрыли или начали новую попытку
      waitingTicket = false;
      if (answer?.denied) {
        stop();
        onStatus?.({ state: 'denied' });
        return;
      }
      if (!answer?.ticket) {
        scheduleReconnect();
        return;
      }
      pass = answer.ticket;
    }

    let socket;
    try {
      socket = new WebSocket(buildWsUrl(pass));
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.addEventListener('message', (event) => {
      if (ws !== socket) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // повреждённое сообщение пропускаем, соединение не рвём
      }
      if (msg?.type === 'hello') {
        // Сервер принял подключение. Счётчик попыток сбрасывается только здесь:
        // соединение, которое открылось и тут же получило отказ, удачным не считается
        attempt = 0;
        onStatus?.({ state: 'connected' });
        sendPing(socket);
        clearInterval(pingTimer);
        pingTimer = setInterval(() => sendPing(socket), 10_000);
      }
      if (msg?.type === 'pong' && typeof msg.clientTs === 'number') {
        onStatus?.({
          state: 'connected',
          rttMs: Math.max(1, Math.round(performance.now()) - msg.clientTs),
          activeClients: msg.activeClients,
        });
      }
      onMessage?.(msg);
    });

    socket.addEventListener('close', () => {
      if (ws !== socket) return; // событие от старого соединения — уже неактуально
      clearInterval(pingTimer);
      ws = null;
      scheduleReconnect();
    });
    // Отдельно ошибку не обрабатываем: за ней всегда следует событие close
  }

  // Сеть вернулась или вкладку снова открыли — не ждём таймера, подключаемся сразу
  function wakeUp() {
    if (stopped || document.hidden || waitingTicket) return;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      attempt = 0;
      openSocket();
    }
  }
  window.addEventListener('online', wakeUp);
  document.addEventListener('visibilitychange', wakeUp);

  openSocket();

  return {
    pingNow() {
      return sendPing(ws);
    },
    close: stop,
  };
}
