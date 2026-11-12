import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

export function createRealtimeHub(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: 256 * 1024,
  });

  const clients = new Map();

  function safeSend(ws, payload) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  wss.on('connection', (ws, req) => {
    const clientId = crypto.randomUUID();
    const url = new URL(req.url || '/ws', 'http://localhost');
    const channel = (url.searchParams.get('channel') || 'system').slice(0, 64);

    const meta = {
      id: clientId,
      channel,
      isAlive: true,
      connectedAt: Date.now(),
    };
    clients.set(ws, meta);

    safeSend(ws, {
      type: 'hello',
      clientId,
      channel,
      serverTime: Date.now(),
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
          serverTime: Date.now(),
          activeClients: clients.size,
        });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  const heartbeatInterval = setInterval(() => {
    for (const [ws, meta] of clients.entries()) {
      if (!meta.isAlive) {
        clients.delete(ws);
        ws.terminate();
        continue;
      }
      meta.isAlive = false;
      try {
        ws.ping();
      } catch {
        clients.delete(ws);
      }
    }
  }, 25_000);
  heartbeatInterval.unref?.();

  return {
    wss,
    getStats() {
      return {
        connectedClients: clients.size,
      };
    },
    close() {
      clearInterval(heartbeatInterval);
      for (const ws of clients.keys()) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      clients.clear();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
