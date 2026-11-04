// lib/db.js — весь доступ к базе в одном месте.
//
// Правила платформы, из-за которых этот файл выглядит именно так:
//  • каждый вызов БД асинхронный — забытый await вернёт билдер, а не строки;
//  • внешних ключей нет → дочерние строки чистим руками (здесь это не нужно:
//    мы ничего не удаляем, только меняем status);
//  • частичный уникальный индекс `uq_grants_one_active` держит инвариант
//    «один активный период на человека» на уровне базы, а не на уровне кода.

import { db, eq, and, or, inArray, lt, lte, desc, sql } from 'sdk/db';
import { grants, notifications, audit, settings } from 'schema';
import { DEFAULT_TZ, DEFAULT_HOUR, PERIOD_DAYS, shortId } from 'lib/core';

const OPEN_STATUSES = ['active', 'expiring', 'expired', 'keep'];

// ---------------------------------------------------------------------------
// settings (key/value)
// ---------------------------------------------------------------------------

export async function getSetting(key, fallback = null) {
  const row = await db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  const updatedAt = new Date();
  await db.insert(settings).values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } })
    .run();
}

export async function getConfig() {
  const cfg = (await getSetting('config', null)) || {};
  return {
    tz: cfg.tz || DEFAULT_TZ,
    hour: cfg.hour ?? DEFAULT_HOUR,
    periodDays: cfg.periodDays || PERIOD_DAYS,
    policy: cfg.policy || 'stack',          // 'stack' — продление от конца срока
    admins: cfg.admins || [],               // [{ id, name, role }]
    chatId: cfg.chatId || null,             // куда слать напоминания
    ownerId: cfg.ownerId || null,
    lastDigestDay: cfg.lastDigestDay ?? null,
  };
}

export async function patchConfig(patch) {
  const cfg = await getConfig();
  await setSetting('config', { ...cfg, ...patch });
  return { ...cfg, ...patch };
}

export async function isAdmin(userId) {
  const cfg = await getConfig();
  if (String(cfg.ownerId) === String(userId)) return true;
  return (cfg.admins || []).some((a) => String(a.id) === String(userId));
}

// ---------------------------------------------------------------------------
// grants
// ---------------------------------------------------------------------------

const now = () => new Date();

export async function createGrant({
  login, periodDays, expiresAt, grantedBy, source = 'manual', notes = null,
  status = 'active', renewedFrom = null,
}) {
  const ts = now();
  const grant = {
    id: shortId(),
    login: String(login).toLowerCase(),
    display: null,
    source,
    grantedAt: ts,
    expiresAt: new Date(expiresAt),
    status,
    grantedBy: grantedBy ? String(grantedBy) : null,
    renewedFrom,
    periodDays,
    snoozeUntil: null,
    notes,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(grants).values(grant).run();
  return grant;
}

export async function getGrant(id) {
  return db.select().from(grants).where(eq(grants.id, id)).get();
}

export async function findOpenByLogin(login) {
  return db.select().from(grants)
    .where(and(eq(grants.login, String(login).toLowerCase()), inArray(grants.status, ['active', 'expiring'])))
    .orderBy(desc(grants.expiresAt))
    .get();
}

export async function listOpen() {
  return db.select().from(grants).where(inArray(grants.status, OPEN_STATUSES)).all();
}

export async function listByLogin(login) {
  return db.select().from(grants)
    .where(eq(grants.login, String(login).toLowerCase()))
    .orderBy(desc(grants.grantedAt))
    .all();
}

export async function listAll(limit = 500) {
  return db.select().from(grants).orderBy(desc(grants.grantedAt)).limit(limit).all();
}

export async function patchGrant(id, patch) {
  await db.update(grants).set({ ...patch, updatedAt: now() }).where(eq(grants.id, id)).run();
  return getGrant(id);
}

export async function countByStatus() {
  const rows = await db.select({ status: grants.status, n: sql`count(*)` })
    .from(grants).groupBy(grants.status).all();
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

// ---------------------------------------------------------------------------
// notifications — журнал, который делает тик идемпотентным
// ---------------------------------------------------------------------------

/** Какие напоминания по этой записи уже отправлены. */
export async function sentKinds(grantId) {
  const rows = await db.select({ kind: notifications.kind, status: notifications.status })
    .from(notifications).where(eq(notifications.grantId, grantId)).all();
  return rows.filter((r) => r.status === 'sent').map((r) => r.kind);
}

/**
 * Пытается «застолбить» напоминание. true — можно отправлять.
 * Возвращает false, если такое kind уже кто-то застолбил (уникальный индекс).
 */
export async function claimNotification(grantId, kind, chatId = null) {
  const existing = await db.select().from(notifications)
    .where(and(eq(notifications.grantId, grantId), eq(notifications.kind, kind))).get();
  if (existing) {
    if (existing.status === 'failed') {
      // повторяем неудачную отправку, но не чаще раза в час
      const hourAgo = new Date(Date.now() - 3600_000);
      if (existing.createdAt && existing.createdAt > hourAgo) return { ok: false };
      await db.update(notifications).set({ status: 'pending', error: null })
        .where(eq(notifications.id, existing.id)).run();
      return { ok: true, id: existing.id };
    }
    return { ok: false };
  }
  const id = shortId();
  try {
    await db.insert(notifications).values({
      id, grantId, kind, status: 'pending', chatId: chatId ? String(chatId) : null, createdAt: now(),
    }).run();
    return { ok: true, id };
  } catch {
    return { ok: false }; // гонка с параллельным тиком — это нормально
  }
}

export async function markNotification(id, { status, messageId = null, error = null }) {
  await db.update(notifications).set({
    status, messageId: messageId ? String(messageId) : null, error,
    sentAt: status === 'sent' ? now() : null,
  }).where(eq(notifications.id, id)).run();
}

/** Для «напомнить завтра»: тик молчит до указанного момента. */
export async function snoozeGrant(id, until) {
  return patchGrant(id, { snoozeUntil: new Date(until) });
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

export async function logAudit(action, { actor = null, grantId = null, payload = null } = {}) {
  await db.insert(audit).values({
    id: shortId(),
    ts: now(),
    actor: actor ? String(actor) : null,
    action,
    grantId,
    payload: payload ? JSON.stringify(payload) : null,
  }).run();
}

export async function recentAudit(limit = 15) {
  return db.select().from(audit).orderBy(desc(audit.ts)).limit(limit).all();
}

export { OPEN_STATUSES };
