import net from 'node:net';

/* Ограничение числа попыток. Счётчики живут в памяти сервера: их мало,
   они короткоживущие, а после перезапуска начинать отсчёт заново допустимо.

   Правило: не больше limit событий за windowMs. Окно открывается первым
   событием и закрывается целиком — человеку можно честно сказать,
   через сколько минут попробовать снова. */
export function createRateLimiter({ now = Date.now, maxKeys = 20000 } = {}) {
  const buckets = new Map();

  function current(key) {
    const bucket = buckets.get(key);
    if (!bucket) return null;
    if (bucket.resetAt <= now()) {
      buckets.delete(key);
      return null;
    }
    return bucket;
  }

  function sweep() {
    const time = now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= time) buckets.delete(key);
    }
  }

  return {
    // Сколько миллисекунд ещё ждать; 0 — можно продолжать
    retryAfterMs(key, rule) {
      const bucket = current(key);
      if (!bucket || bucket.count < rule.limit) return 0;
      return Math.max(1, bucket.resetAt - now());
    },

    hit(key, rule) {
      let bucket = current(key);
      if (!bucket) {
        if (buckets.size >= maxKeys) {
          sweep();
          // Память ограничена: при переполнении выбрасываем самые старые записи
          while (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
        }
        bucket = { count: 0, resetAt: now() + rule.windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return bucket.count;
    },

    clear(key) {
      buckets.delete(key);
    },

    sweep,

    get size() {
      return buckets.size;
    },
  };
}

function expandIPv6(address) {
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = address.includes('::') ? Math.max(0, 8 - left.length - right.length) : 0;
  return [...left, ...Array(missing).fill('0'), ...right].map((group) => group.toLowerCase().padStart(4, '0'));
}

/* Ключ посетителя для счётчиков. У IPv6 берётся только первая половина
   адреса (/64): вторую половину владелец подсети меняет свободно и иначе
   обходил бы ограничение, перебирая адреса. */
export function clientKey(ip) {
  const raw = String(ip || '').trim();
  if (!raw) return 'unknown';
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (net.isIPv6(raw)) return `${expandIPv6(raw.split('%')[0]).slice(0, 4).join(':')}::/64`;
  return raw;
}
