// lib/core.js — чистая логика: ни sdk, ни БД, ни сети, только Date/Intl.
//
// Единственный модуль проекта, который можно запускать в обычном Node
// (`npm test`), потому что он ничего не импортирует. Всё остальное живёт
// только на платформе Telegram Serverless, где `sdk` доступен из коробки.

export const DAY_MS = 86_400_000;
export const DEFAULT_TZ = 'Europe/Moscow';
export const DEFAULT_HOUR = 10; // в какие локальные часы присылать T-0
export const PERIOD_DAYS = 30;
export const MAX_ESCALATIONS = 4;

// ---------------------------------------------------------------------------
// Время и часовые пояса
// ---------------------------------------------------------------------------

/** Компоненты даты в заданном поясе (без Luxon: его на платформе нет). */
export function tzParts(ts, tz = DEFAULT_TZ) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const out = {};
  for (const { type, value } of fmt.formatToParts(new Date(ts))) out[type] = value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    // hour12:false иногда отдаёт "24" для полуночи
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
  };
}

/** Номер локального календарного дня. Так сравнивать даты безопасно при DST. */
export function dayNumber(ts, tz = DEFAULT_TZ) {
  const p = tzParts(ts, tz);
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS);
}

/** 0 = воскресенье … 1 = понедельник … 6 = суббота. */
export function weekday(ts, tz = DEFAULT_TZ) {
  return (dayNumber(ts, tz) + 4) % 7;
}

/** Сколько календарных дней осталось до expiresAt (0 = сегодня, <0 = просрочено). */
export function daysLeft(expiresAt, now = Date.now(), tz = DEFAULT_TZ) {
  return dayNumber(expiresAt, tz) - dayNumber(now, tz);
}

export function addDays(ts, days) {
  return ts + days * DAY_MS;
}

const pad = (n) => String(n).padStart(2, '0');

export function formatDateRu(ts, tz = DEFAULT_TZ) {
  const p = tzParts(ts, tz);
  return `${pad(p.day)}.${pad(p.month)}.${p.year}`;
}

export function formatDateTimeRu(ts, tz = DEFAULT_TZ) {
  const p = tzParts(ts, tz);
  return `${pad(p.day)}.${pad(p.month)}.${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** «через 3 дня», «сегодня», «2 дня назад». */
export function humanDays(dl) {
  if (dl === 0) return 'сегодня';
  if (dl === 1) return 'завтра';
  if (dl > 1) return `через ${dl} дн.`;
  const late = -dl;
  return late === 1 ? 'просрочено на день' : `просрочено на ${late} дн.`;
}

// ---------------------------------------------------------------------------
// Разбор команды
// ---------------------------------------------------------------------------

const SUBCOMMANDS = new Set([
  'add', 'list', 'info', 'extend', 'remove', 'keep', 'cancel',
  'export', 'stats', 'dashboard', 'sync', 'whoami', 'help', 'admins',
]);

/**
 * Разбирает `/vip add @nick 30d --to 2026-12-01 --note «за 5000 битсов»`.
 * Возвращает { sub, login, days, to, note, error }.
 */
export function parseVipCommand(text) {
  const raw = (text || '').trim();
  if (!raw) return { error: 'пустая команда' };

  // /vip@MyBot add ... → отрезаем @бота
  const tokens = raw.split(/\s+/);
  const first = tokens.shift().replace(/@[^\s@]+$/, '');
  if (!/^\/(vip|вип)/i.test(first)) return { error: null, ignored: true };

  let sub = (tokens.shift() || 'help').toLowerCase();
  if (!SUBCOMMANDS.has(sub)) {
    // `/vip @nick` — короткая форма, считаем что это add
    tokens.unshift(sub);
    sub = 'add';
  }

  const out = { sub, login: null, days: null, to: null, note: null, args: [] };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--to' || t === '-t') { out.to = tokens[++i] ?? null; continue; }
    if (t === '--note' || t === '-n') { out.note = tokens.slice(i + 1).join(' ') || null; break; }
    const dm = /^(\d+)\s*(d|д|дн|дней|day|days)$/i.exec(t) || /^\+?(\d+)$/.exec(t);
    if (dm && /^(add|extend)$/.test(sub) && !out.days) { out.days = Number(dm[1]); continue; }
    if (!out.login && /^@?[a-zA-Z0-9_]{1,25}$/.test(t)) { out.login = t.replace(/^@/, '').toLowerCase(); continue; }
    out.args.push(t);
  }

  if (out.to && !/^\d{4}-\d{2}-\d{2}$/.test(out.to)) return { ...out, error: 'дата должна быть в формате ГГГГ-ММ-ДД' };
  return out;
}

/** Дата из `--to` (полдень UTC выбранного дня — чтобы не прыгать через границу суток). */
export function parseDateOnly(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}

// ---------------------------------------------------------------------------
// Сроки
// ---------------------------------------------------------------------------

/**
 * Новый expiresAt.
 * policy='stack' — считаем от конца текущего срока (человек не теряет дни);
 * policy='now'   — считаем от сегодня.
 */
export function nextExpiry({ currentExpiresAt = 0, now = Date.now(), periodDays = PERIOD_DAYS, policy = 'stack' }) {
  const base = policy === 'now' ? now : Math.max(currentExpiresAt || 0, now);
  return addDays(base, periodDays);
}

// ---------------------------------------------------------------------------
// Какие напоминания пора отправить
// ---------------------------------------------------------------------------

/**
 * @param grant { id, expiresAt, status, snoozeUntil? }
 * @param sent  массив уже отправленных kind для этой записи
 * @returns [{ kind, severity }]
 */
export function dueReminders(grant, now = Date.now(), { tz = DEFAULT_TZ, hour = DEFAULT_HOUR, sent = [] } = {}) {
  const out = [];
  const status = grant.status;
  if (!['active', 'expiring', 'expired', 'keep'].includes(status)) return out;
  if (grant.snoozeUntil && grant.snoozeUntil > now) return out;

  const dl = daysLeft(grant.expiresAt, now, tz);
  const has = (kind) => sent.includes(kind);
  const push = (kind, severity) => { if (!has(kind)) out.push({ kind, severity }); };

  if (status === 'keep') {
    // «Оставили»: тихое напоминание раз в неделю, без эскалации.
    if (dl < 0 && -dl % 7 === 1) push('keep-7d', 'soft');
    return out;
  }

  if (dl === 3) push('t-3', 'soft');
  if (dl === 1) push('t-1', 'warn');
  if (dl === 0 && tzParts(now, tz).hour >= hour) push('t-0', 'warn');

  if (dl < 0) {
    const late = -dl;
    if (late === 1) push('overdue', 'hot');
    else {
      const k = Math.floor((late - 1) / 7);
      if (k >= 1) push(`escalation-${Math.min(k, MAX_ESCALATIONS)}`, 'hot');
    }
  }
  return out;
}

/** Пора ли слать недельный дайджест (пн, после `hour`, не чаще раза в день). */
export function digestDue(now = Date.now(), { tz = DEFAULT_TZ, hour = DEFAULT_HOUR, lastDay = null } = {}) {
  const today = dayNumber(now, tz);
  if (lastDay === today) return false;
  return weekday(now, tz) === 1 && tzParts(now, tz).hour >= hour;
}

// ---------------------------------------------------------------------------
// Тексты
// ---------------------------------------------------------------------------

export const STATUS_LABELS = {
  active: 'активен',
  expiring: 'истекает',
  expired: 'истёк',
  removed: 'снят',
  keep: 'оставлен',
  cancelled: 'отменён',
  waitlist: 'в очереди',
  pending: 'ожидает',
};

export function reminderText(grant, kind, { tz = DEFAULT_TZ, now = Date.now() } = {}) {
  const who = grant.login ? `@${grant.login}` : grant.display || '(без логина)';
  const until = formatDateRu(grant.expiresAt, tz);
  const dl = daysLeft(grant.expiresAt, now, tz);
  const head = {
    't-3': `⏳ ${who} — VIP до ${until} (через 3 дня)`,
    't-1': `⚠️ ${who} — VIP до ${until} (остался день)`,
    't-0': `🔥 ${who} — VIP истекает сегодня (${until})`,
    overdue: `🕳 ${who} — VIP просрочен ${until} (${humanDays(dl)})`,
    'keep-7d': `🙈 ${who} — VIP оставлен, до ${until}`,
  }[kind] || `• ${who} — VIP до ${until}`;
  if (kind.startsWith('escalation-')) {
    return `${head.replace(/^./, '❗')} · ${kind.split('-')[1]}-е напоминание, ${humanDays(dl)}`;
  }
  return head;
}

export function grantLine(grant, { tz = DEFAULT_TZ, now = Date.now() } = {}) {
  const who = grant.login ? `@${grant.login}` : '(без логина)';
  const dl = daysLeft(grant.expiresAt, now, tz);
  return `${who} — до ${formatDateRu(grant.expiresAt, tz)} · ${humanDays(dl)}`;
}

export function dashboardText(grants, { tz = DEFAULT_TZ, now = Date.now(), slots = null } = {}) {
  const active = grants.filter((g) => ['active', 'expiring', 'expired', 'keep'].includes(g.status));
  const sorted = [...active].sort((a, b) => a.expiresAt - b.expiresAt);
  const soon = sorted.slice(0, 5);
  const overdue = sorted.filter((g) => g.expiresAt < now).length;
  const lines = ['📌 VIP-дашборд', `активных: ${active.length}` + (overdue ? ` · просрочено: ${overdue}` : '') + (slots != null ? ` · слотов свободно: ${slots}` : ''), ''];
  if (!soon.length) lines.push('пока пусто');
  for (const g of soon) lines.push('• ' + grantLine(g, { tz, now }));
  lines.push('', `обновлено ${formatDateTimeRu(now, tz)}`);
  return lines.join('\n');
}

export function csvText(grants, { tz = DEFAULT_TZ } = {}) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['login', 'status', 'granted_at', 'expires_at', 'period_days', 'source', 'granted_by', 'notes'];
  const rows = grants.map((g) => [
    g.login, g.status,
    formatDateTimeRu(g.grantedAt, tz), formatDateTimeRu(g.expiresAt, tz),
    g.periodDays, g.source, g.grantedBy, g.notes,
  ].map(esc).join(','));
  return [head.join(','), ...rows].join('\n');
}

/** Режем длинный текст под лимит одного сообщения (4096, берём с запасом). */
export function chunkText(text, max = 3500) {
  const chunks = [];
  let buf = '';
  for (const line of String(text).split('\n')) {
    if (buf.length + line.length + 1 > max) { if (buf) chunks.push(buf); buf = line; }
    else buf = buf ? `${buf}\n${line}` : line;
    while (buf.length > max) { chunks.push(buf.slice(0, max)); buf = buf.slice(max); }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Короткий id записи: влезает в callback_data (лимит 64 байта). */
export function shortId(rand = Math.random) {
  return Math.floor(rand() * 36 ** 8).toString(36).padStart(8, '0').slice(-8);
}
