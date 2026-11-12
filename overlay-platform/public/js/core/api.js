/* ==========================================================================
   Связь страницы с сервером: обычные запросы и живой канал (WebSocket).
   Адреса только относительные, поэтому страница одинаково работает на своём
   домене, за промежуточным сервером, в предпросмотре и внутри OBS.
   ========================================================================== */

export async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const isJsonBody =
    options.body && typeof options.body === 'object' && !(options.body instanceof FormData);

  if (isJsonBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
    body: isJsonBody ? JSON.stringify(options.body) : options.body,
  });

  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

/* Живой канал связи. Сам переподключается после обрыва: сначала быстро,
   потом реже (не чаще раза в 8 секунд), а при возвращении сети или вкладки —
   сразу. Раз в 10 секунд измеряет задержку до сервера. */
export function connectRealtime({ channel = 'system', onMessage, onStatus } = {}) {
  let ws = null;
  let closedManually = false;
  let reconnectTimer = null;
  let pingTimer = null;
  let attempt = 0;

  function buildWsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ channel });
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
    if (closedManually) return;
    clearTimeout(reconnectTimer);
    const delay = Math.min(8000, 700 * 2 ** Math.min(attempt, 4));
    attempt += 1;
    onStatus?.({ state: 'reconnecting', attempt, delay });
    reconnectTimer = setTimeout(openSocket, delay);
  }

  function openSocket() {
    if (closedManually) return;
    clearTimeout(reconnectTimer);
    onStatus?.({ state: 'connecting' });

    let socket;
    try {
      socket = new WebSocket(buildWsUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.addEventListener('open', () => {
      if (ws !== socket) return;
      attempt = 0;
      onStatus?.({ state: 'connected' });
      sendPing(socket);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => sendPing(socket), 10_000);
    });

    socket.addEventListener('message', (event) => {
      if (ws !== socket) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // повреждённое сообщение пропускаем, соединение не рвём
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
    if (closedManually || document.hidden) return;
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
    close() {
      closedManually = true;
      clearTimeout(reconnectTimer);
      clearInterval(pingTimer);
      window.removeEventListener('online', wakeUp);
      document.removeEventListener('visibilitychange', wakeUp);
      if (ws) ws.close();
      ws = null;
    },
  };
}
