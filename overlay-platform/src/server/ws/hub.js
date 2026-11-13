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

   С этапа 7 по каналу площадки идут и сами изменения сцены (delta), и присутствие:
   кто сейчас что двигает. Присутствие живёт только в памяти сервера, в базу не
   попадает и после перезагрузки страницы не восстанавливается. Каждое сообщение
   о присутствии проверяется так же, как правка: чужой не может сказать «я тут»
   от имени другого человека и не может сообщить о площадке, где у него нет прав.

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
/* Присутствие: пока человек тянет источник, запись живёт; перестал присылать —
   через столько секунд она исчезает (страница закрыли, связь оборвалась). */
const PRESENCE_TTL_MS = 6000;
const PRESENCE_EVERY_MS = 120; // чаще этого о положении не сообщаем: глазам хватает


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
  /* Кто сейчас что двигает: канал → человек → его соединения. Живёт только в памяти.
     Ключ человека — номер входа (sessionId) или, если входа ещё нет, номер соединения:
     у одного человека в двух вкладках это одно «я тут», у двух людей — разное. */
  const presence = new Map();

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
    dropPresence(meta);
  }

  /* ---------- Присутствие ----------
     Кто сейчас что двигает на сцене. Пока источник тянут, страница присылает его
     промежуточное положение — по нему и видно: «Модератор двигает: Заголовок».
     Ничего из этого не сохраняется: отпустили — запись исчезает, и до базы дело
     не доходит, пока правка не отправлена обычным запросом. */

  /* Ключ присутствия — человек, а не вкладка: у одного человека две вкладки, и тянуть
     источник он может только в одной, поэтому запись одна на всех. */
  const keyOf = (meta) => meta.sessionId || meta.id;
  /* А «моё» — это именно эта вкладка. Если человек откроет редактор дважды и потянет
     источник в первой, вторая должна показать чужую руку, а не промолчать: сравнивать
     по человеку здесь нельзя. */
  const connectionOf = (meta) => meta.id;

  /* Соединение закрылось: его «я двигаю» снимается. У одного человека две вкладки —
     это одно присутствие, поэтому запись убирается вместе с последним его соединением. */
  function dropPresence(meta) {
    const people = presence.get(meta.channel);
    if (!people) return;
    const key = keyOf(meta);
    if (!people.has(key)) return;
    const stillHere = [...clients.values()].some((other) => other !== meta && other.channel === meta.channel && keyOf(other) === key);
    if (stillHere) return;
    people.delete(key);
    if (people.size === 0) presence.delete(meta.channel);
    if (meta.workspaceId) tellPresence(meta.workspaceId);
  }

  /* Изменение для оверлея: то же самое, но без названий источников и защиты от сдвига.
     Названия — дело редактора; по ссылке оверлея они не уходят ни в сцене, ни в изменении.
     Проверка здесь, а не у сцены, потому что изменение одно на всех: страницам площадки
     название нужно (по нему источник виден в списке слоёв), а оверлею — нет. */
  function forOverlay(delta) {
    if (!delta) return null;
    const clean = (list) => list.map(({ name, locked, ...rest }) => rest);
    const out = {};
    if (delta.add) out.add = clean(delta.add);
    if (delta.put) out.put = clean(delta.put);
    if (delta.order) out.order = delta.order;
    if (delta.remove) out.remove = delta.remove;
    return out;
  }

  /* Кто сейчас что двигает. mine считается для каждого соединения отдельно:
     у двух вкладок одного человека это одно присутствие, и обе видят «двигаете вы».
     Оверлею присутствие не нужно вовсе — он его и не получает. */
  function presenceList(workspaceId) {
    const people = presence.get(workspaceChannel(workspaceId));
    if (!people) return [];
    return [...people.values()].filter((person) => person.until > now());
  }

  function tellPresence(workspaceId) {
    const live = presenceList(workspaceId);
    for (const ws of [...(channels.get(workspaceChannel(workspaceId)) || [])]) {
      const meta = clients.get(ws);
      if (!roleFor(meta)) {
        unregister(ws);
        deny(ws);
        continue;
      }
      safeSend(ws, {
        type: 'workspace:presence',
        people: live.map((person) => ({
          name: person.name,
          role: person.role,
          sourceId: person.sourceId,
          // Положение — чтобы вторая страница показала источник там, где его держат
          x: person.x,
          y: person.y,
          width: person.width,
          height: person.height,
          mine: person.connection === connectionOf(meta),
        })),
      });
    }
  }

  /* Сообщение о положении источника во время перетаскивания. Допускается только
     участнику площадки — это проверяется той же guard, что и всё остальное.
     Положение не сохраняется и никого не переносит в базу: это подсказка для глаз. */
  function readPresence(value) {
    if (!value || typeof value !== 'object') return null;
    const { sourceId, x, y, width, height, end } = value;
    // «Отпустил» — одно слово, без положения: источник уже сохранён обычной правкой
    if (end === true) return { sourceId: typeof sourceId === 'string' ? sourceId : '', end: true };
    if (typeof sourceId !== 'string' || !/^[0-9a-z]{8,32}$/.test(sourceId)) return null;
    const numbers = [x, y, width, height];
    if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100_000)) return null;
    return { sourceId, x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }

  function notePresence(meta, value) {
    const last = readPresence(value); // негодное сообщение просто не учитывается
    if (!last) return;
    const key = keyOf(meta);
    const people = presence.get(meta.channel) || new Map();
    presence.set(meta.channel, people);

    if (last.end) {
      people.delete(key);
      tellPresence(meta.workspaceId);
      return;
    }
    const before = people.get(key);
    people.set(key, {
      key,
      connection: connectionOf(meta),
      name: meta.name,
      role: meta.role,
      sourceId: last.sourceId,
      x: last.x,
      y: last.y,
      width: last.width,
      height: last.height,
      until: now() + PRESENCE_TTL_MS,
    });
    // Первое движение за серию — сообщаем сразу; дальше не чаще, чем раз в PRESENCE_EVERY_MS
    if (!before || before.sourceId !== last.sourceId || now() - before.sentAt > PRESENCE_EVERY_MS) {
      people.get(key).sentAt = now();
      tellPresence(meta.workspaceId);
    }
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

  /* Кем человек приходится площадке — без привязки к живому соединению. Нужно, чтобы
     подписать автора правки: правка уже сохранена, и вход у него на этот момент действовал.
     Ошибка проверки считается отказом: не подписать лучше, чем подписать не тем. */
  function roleOfUser({ workspaceId, userId }) {
    if (!guard) return null;
    try {
      return guard({ workspaceId, userId, sessionId: null }) || null;
    } catch {
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
      name: '', // имя участника — только для присутствия на сцене
      role: null,
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
      /* Имя для присутствия. Оно и так известно участникам площадки: это подпись,
         которую человек видит в списке команды. Неизвестное имя — пустая строка. */
      try {
        meta.name = guard.nameOf?.({ workspaceId: ticket.workspaceId, userId: ticket.userId }) || '';
        meta.role = roleFor(ticket);
      } catch {
        meta.name = '';
      }
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

      if (msg?.type === 'presence') {
        // Двигают сцену только участники площадки; у открытых каналов и оверлея такой команды нет
        if (meta.kind === 'team' && roleFor(meta)) notePresence(meta, msg.at);
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
  /* Кто изменил — подпись и роль. Нужно только страницам площадки: по этому имени
     вторая вкладка показывает «изменил Помощник». Берётся с сервера, а не из сообщения:
     подставить чужое имя нельзя. Оверлею это не уходит вовсе. */
  function actorOf(workspaceId, userId) {
    if (userId === null || userId === undefined) return null;
    const role = roleOfUser({ workspaceId, userId });
    if (!role) return null;
    try {
      const name = guard?.nameOf?.({ workspaceId, userId }) || '';
      return name ? { name, role } : { role };
    } catch {
      return { role };
    }
  }

  function announceWorkspace({ workspaceId, what, audience = 'team', actorId = null, version = null, origin = null, delta = null }) {
    const extra = {};
    if (Number.isInteger(version)) extra.version = version;
    if (typeof origin === 'string' && origin) extra.origin = origin;
    // Само изменение — чтобы страница применила его к своей копии, а не перечитывала сцену
    if (delta && typeof delta === 'object') extra.delta = delta;
    /* Автор правки — только у самой сцены: у остальных событий (команда, приглашения)
       подпись не нужна, а лишнее поле в сообщении — лишняя возможность его не так понять. */
    const actor = what === 'scene' ? actorOf(workspaceId, actorId) : null;

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
      safeSend(ws, {
        type: 'workspace:changed',
        what,
        mine: actorId !== null && meta.userId === actorId,
        ...extra,
        /* Кто именно — только страницам площадки: имя участника и раньше было им
           известно, а оверлею по ссылке не уходит ничего, кроме номера версии. */
        ...(actor ? { actor } : {}),
      });
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
      // Ни кто менял, ни с какой страницы — оверлею только номер версии и само изменение без названий
      const clean = forOverlay(delta);
      safeSend(ws, {
        type: 'overlay:changed',
        ...(Number.isInteger(version) ? { version } : {}),
        ...(clean ? { delta: clean } : {}),
      });
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

  const presenceInterval = setInterval(() => {
    // Замолчавшие (закрыли вкладку, оборвалась связь) перестают «двигать» сами
    for (const [channel, people] of [...presence]) {
      for (const [key, person] of [...people]) {
        if (person.until > now()) continue;
        people.delete(key);
        const workspaceId = channel.startsWith(WORKSPACE_PREFIX) ? channel.slice(WORKSPACE_PREFIX.length) : null;
        if (workspaceId) tellPresence(workspaceId);
      }
      if (people.size === 0) presence.delete(channel);
    }
  }, 2000);
  presenceInterval.unref?.();

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
    // Кто сейчас что двигает на площадке (только для проверок)
    presenceOf: (workspaceId) =>
      presenceList(workspaceId).map(({ name, role, sourceId, x, y, width, height }) => ({ name, role, sourceId, x, y, width, height })),
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
      presence.clear();
      clearInterval(presenceInterval);
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
