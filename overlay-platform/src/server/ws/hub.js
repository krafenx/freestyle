import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { isLinkToken, newLinkToken } from '../auth/tokens.js';

/* Живой канал связи (/ws).

   Открытые каналы (home, system и другие) принимают любого: по ним идут только
   приветствие и замер задержки, личных данных там нет.

   Каналы площадок (workspace:<номер>) — только для владельца и модераторов этой
   площадки. Cookie при подключении не используются вовсе. Страница сначала
   получает одноразовый пропуск обычным запросом — там проверяются и вход, и права,
   и то, что запрос пришёл с нашего сайта, — и уже с пропуском открывает канал.
   Поэтому чужой сайт не может подключиться от имени вошедшего человека, а проверка
   не зависит от того, как браузер и промежуточные серверы обращаются с cookie.

   Права проверяются не только при подключении, но и перед каждой отправкой,
   а когда чей-то вход заканчивается — сразу у всех открытых страниц площадок.
   Убранный модератор и человек, вышедший из аккаунта, отключаются немедленно,
   а не «когда переподключатся».

   Канал оверлея (overlay) — для страницы, открытой в OBS. Она не входит в аккаунт,
   поэтому вместо пропуска предъявляет ссылку оверлея. По каналу она получает
   только сигнал «сцена изменилась» с номером версии; о команде, приглашениях
   и названии площадки ей не сообщается. Действует ли ссылка, проверяется при
   подключении и перед каждой отправкой: стоит владельцу выпустить новую ссылку
   или удалить площадку — оверлеи, открытые по прежней, отключаются сразу. */

const WORKSPACE_PREFIX = 'workspace:';
const OVERLAY_CHANNEL = 'overlay';
const TICKET_LENGTH = 26; // 130 бит
const DENIED_CLOSE_CODE = 4403;
const BUSY_CLOSE_CODE = 4429;

export const workspaceChannel = (workspaceId) => `${WORKSPACE_PREFIX}${workspaceId}`;
/* Оверлеи одной площадки. Попросить такой канал по названию нельзя: всё, что начинается
   с overlay, пускается только по ссылке оверлея (см. ниже) — название назначает сервер. */
const overlayChannel = (workspaceId) => `${OVERLAY_CHANNEL}:${workspaceId}`;
const isOverlayChannel = (channel) => channel === OVERLAY_CHANNEL || channel.startsWith(`${OVERLAY_CHANNEL}:`);

export function createRealtimeHub(httpServer, {
  now = Date.now,
  // Кем человек приходится площадке прямо сейчас: owner, moderator или null. Задаётся в app.js
  guard = null,
  // Куда ведёт ссылка оверлея прямо сейчас: номер площадки или null. Тоже задаётся в app.js
  overlayGuard = null,
  ticketTtlMs = 30_000,
  ticketsPerSession = 4,
  maxTickets = 10_000,
  /* Сколько оверлеев одной площадки держат канал одновременно. Стримеру хватает нескольких
     (OBS, вкладка проверки, второй компьютер); предел — на случай, если ссылка утекла
     и её открыли сотни людей. Лишние страницы сцену всё равно показывают: без канала
     они сверяют её обычными запросами. */
  overlaysPerWorkspace = 20,
} = {}) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: 256 * 1024,
  });

  const clients = new Map(); // соединение → сведения о нём
  const channels = new Map(); // канал → его соединения
  const tickets = new Map(); // пропуск → для кого и куда он выдан

  function safeSend(ws, payload) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function register(ws, meta) {
    clients.set(ws, meta);
    if (!channels.has(meta.channel)) channels.set(meta.channel, new Set());
    channels.get(meta.channel).add(ws);
  }

  function unregister(ws) {
    const meta = clients.get(ws);
    if (!meta) return;
    clients.delete(ws);
    const members = channels.get(meta.channel);
    members?.delete(ws);
    if (members?.size === 0) channels.delete(meta.channel);
  }

  /* Отказ без объяснения причин: не вошёл, нет прав или площадки не существует —
     снаружи это неотличимо. Что именно случилось, страница узнаёт обычным запросом. */
  function deny(ws) {
    safeSend(ws, { type: 'denied' });
    ws.close(DENIED_CLOSE_CODE, 'denied');
  }

  // Любой сбой проверки считается отказом: лучше не доставить, чем доставить не тому
  function roleFor({ workspaceId, userId, sessionId }) {
    if (!guard) return null;
    try {
      return guard({ workspaceId, userId, sessionId }) || null;
    } catch (err) {
      console.error('[krafen-overlay] Не удалось проверить права в живом канале:', err);
      return null;
    }
  }

  // То же для оверлея: площадка, к которой ссылка ведёт прямо сейчас, или null
  function overlayTargetOf(token) {
    if (!overlayGuard) return null;
    try {
      return overlayGuard(token) || null;
    } catch (err) {
      console.error('[krafen-overlay] Не удалось проверить ссылку оверлея в живом канале:', err);
      return null;
    }
  }

  // Есть ли у соединения право на свой канал прямо сейчас
  function stillAllowed(meta) {
    if (meta.kind === 'team') return Boolean(roleFor(meta));
    if (meta.kind === 'overlay') return overlayTargetOf(meta.overlayToken) === meta.workspaceId;
    return true; // открытые каналы принимают любого
  }

  /* ---------- Одноразовые пропуска ---------- */

  function sweepTickets() {
    const time = now();
    for (const [value, ticket] of tickets) {
      if (ticket.expiresAt <= time) tickets.delete(value);
    }
  }

  // Вызывается только после проверки прав (см. workspaces/http.js)
  function issueTicket({ workspaceId, userId, sessionId }) {
    // У одного входа ждёт своей очереди лишь несколько пропусков: старые сгорают
    const own = [];
    for (const [value, ticket] of tickets) {
      if (ticket.sessionId === sessionId) own.push(value);
    }
    while (own.length >= ticketsPerSession) tickets.delete(own.shift());

    if (tickets.size >= maxTickets) {
      sweepTickets();
      while (tickets.size >= maxTickets) tickets.delete(tickets.keys().next().value);
    }

    const value = newLinkToken(TICKET_LENGTH);
    tickets.set(value, {
      channel: workspaceChannel(workspaceId),
      workspaceId,
      userId,
      sessionId,
      expiresAt: now() + ticketTtlMs,
    });
    return { ticket: value, expiresInSeconds: Math.floor(ticketTtlMs / 1000) };
  }

  function takeTicket(value, channel) {
    if (!isLinkToken(value, TICKET_LENGTH)) return null;
    const ticket = tickets.get(value);
    if (!ticket) return null;
    tickets.delete(value); // сгорает при первом же предъявлении, даже неудачном
    if (ticket.expiresAt <= now() || ticket.channel !== channel) return null;
    return ticket;
  }

  /* ---------- Подключения ---------- */

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/ws', 'http://localhost');
    const channel = (url.searchParams.get('channel') || 'system').slice(0, 64);

    const meta = {
      id: crypto.randomUUID(),
      // open — открытый канал, team — страница площадки (вход и роль), overlay — оверлей (ссылка)
      kind: 'open',
      channel,
      isAlive: true,
      connectedAt: now(),
      workspaceId: null,
      userId: null,
      sessionId: null,
      overlayToken: null,
    };

    ws.on('error', () => {
      unregister(ws);
    });

    if (channel.startsWith(WORKSPACE_PREFIX)) {
      // Пропуск выдан сервером после проверки прав; перед входом права проверяются ещё раз
      const ticket = takeTicket(url.searchParams.get('ticket'), channel);
      if (!ticket || !roleFor(ticket)) {
        deny(ws);
        return;
      }
      meta.kind = 'team';
      meta.workspaceId = ticket.workspaceId;
      meta.userId = ticket.userId;
      meta.sessionId = ticket.sessionId;
    } else if (isOverlayChannel(channel)) {
      // Оверлей предъявляет свою ссылку. Отменённая и выдуманная неотличимы: отказ без объяснений
      const token = url.searchParams.get('key');
      const workspaceId = overlayTargetOf(token);
      if (!workspaceId) {
        deny(ws);
        return;
      }
      const room = overlayChannel(workspaceId);
      if ((channels.get(room)?.size || 0) >= overlaysPerWorkspace) {
        // Не отказ в доступе: ссылка действует, просто каналов уже слишком много
        safeSend(ws, { type: 'busy' });
        ws.close(BUSY_CLOSE_CODE, 'busy');
        return;
      }
      meta.kind = 'overlay';
      meta.channel = room;
      meta.workspaceId = workspaceId;
      meta.overlayToken = token;
    }

    register(ws, meta);

    safeSend(ws, {
      type: 'hello',
      clientId: meta.id,
      // Оверлею номер площадки не сообщается: ему достаточно знать, что он в своём канале
      channel: meta.kind === 'overlay' ? OVERLAY_CHANNEL : channel,
      serverTime: now(),
    });

    ws.on('pong', () => {
      meta.isAlive = true;
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        safeSend(ws, { type: 'error', code: 'invalid_json' });
        return;
      }

      if (msg?.type === 'ping') {
        safeSend(ws, {
          type: 'pong',
          clientTs: typeof msg.clientTs === 'number' ? msg.clientTs : null,
          serverTime: now(),
          // Оверлею время сервера нужно для таймеров, а сколько страниц сейчас на связи — не его дело
          ...(meta.kind === 'overlay' ? {} : { activeClients: clients.size }),
        });
      }
    });

    ws.on('close', () => {
      unregister(ws);
    });
  });

  /* На площадке что-то изменилось — сообщаем её открытым страницам. Само сообщение
     данных не несёт: страница, получив его, заново запрашивает площадку или сцену
     обычным запросом, где права проверяются как всегда.
     audience: team — всем участникам, owner — только владельцу.
     Для сцены к сообщению прикладываются номер её версии и метка страницы, с которой
     пришло изменение: по ним страница понимает, отстала ли она и не её ли это правка.

     Оверлеи площадки при любом событии проверяются заново — действует ли ещё их ссылка, —
     а сигнал получают только об изменении сцены: остальное их не касается.
     Возвращает число страниц и оверлеев, которым сообщение ушло. */
  function announceWorkspace({ workspaceId, what, audience = 'team', actorId = null, version = null, origin = null }) {
    const extra = {};
    if (Number.isInteger(version)) extra.version = version;
    if (typeof origin === 'string' && origin) extra.origin = origin;

    let delivered = 0;
    for (const ws of [...(channels.get(workspaceChannel(workspaceId)) || [])]) {
      const meta = clients.get(ws);
      const role = roleFor(meta);
      if (!role) {
        // Доступа больше нет: площадку удалили, человека убрали из команды или он вышел из аккаунта
        unregister(ws);
        deny(ws);
        continue;
      }
      if (audience === 'owner' && role !== 'owner') continue;
      // mine — изменение сделал сам этот человек (в этой или другой вкладке)
      safeSend(ws, { type: 'workspace:changed', what, mine: actorId !== null && meta.userId === actorId, ...extra });
      delivered += 1;
    }

    for (const ws of [...(channels.get(overlayChannel(workspaceId)) || [])]) {
      if (!stillAllowed(clients.get(ws))) {
        // Ссылка больше не действует: владелец выпустил новую или площадку удалили
        unregister(ws);
        deny(ws);
        continue;
      }
      if (what !== 'scene') continue;
      // Ни кто менял, ни с какой страницы — оверлею только номер версии
      safeSend(ws, { type: 'overlay:changed', ...(Number.isInteger(version) ? { version } : {}) });
      delivered += 1;
    }
    return delivered;
  }

  /* Чей-то вход закончился (выход, смена пароля, восстановление): страницы площадок,
     у которых больше нет права на канал, отключаются сразу, а не при следующем событии.
     Возвращает число отключённых страниц. */
  function recheck() {
    let dropped = 0;
    for (const [ws, meta] of [...clients]) {
      if (stillAllowed(meta)) continue;
      unregister(ws);
      deny(ws);
      dropped += 1;
    }
    return dropped;
  }

  const heartbeatInterval = setInterval(() => {
    sweepTickets();
    for (const [ws, meta] of clients.entries()) {
      if (!meta.isAlive) {
        unregister(ws);
        ws.terminate();
        continue;
      }
      meta.isAlive = false;
      try {
        ws.ping();
      } catch {
        unregister(ws);
      }
    }
  }, 25_000);
  heartbeatInterval.unref?.();

  return {
    wss,
    issueTicket,
    announceWorkspace,
    recheck,
    getStats() {
      return {
        connectedClients: clients.size,
      };
    },
    close() {
      clearInterval(heartbeatInterval);
      // Все соединения сервера, включая те, которым только что отказано
      for (const ws of wss.clients) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      clients.clear();
      channels.clear();
      tickets.clear();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
