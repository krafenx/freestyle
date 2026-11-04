// schema.js — схема встроенной SQLite (DSL платформы).
//
// apply: `npx tgcloud push` показывает изменения, `npx tgcloud migrate` — применяет.
// Внешних ключей на платформе нет (PRAGMA foreign_keys выключен, .references()
// бросает исключение), поэтому целостность держим в коде (lib/db.js).

import { table, integer, text, index, uniqueIndex, sql } from 'sdk/db';

// Одна строка = один период VIP. Продление — новая строка со ссылкой
// renewedFrom на предыдущую, чтобы история не терялась.
export const grants = table('vip_grants', {
  id:         text('id').primaryKey(),            // короткий id (8 символов) — влезает в callback_data
  login:      text('login').notNull(),            // нижний регистр, без @
  userId:     text('user_id'),                    // twitch user id, если когда-нибудь резолвим
  display:    text('display_name'),
  source:     text('source').notNull().default('manual'),
  grantedAt:  integer('granted_at', { mode: 'timestamp' }).notNull(),
  expiresAt:  integer('expires_at', { mode: 'timestamp' }).notNull(),
  status:     text('status').notNull().default('active'),
  grantedBy:  text('granted_by'),
  renewedFrom: text('renewed_from'),               // id предыдущей записи (не FK)
  periodDays: integer('period_days').notNull().default(30),
  snoozeUntil: integer('snooze_until', { mode: 'timestamp' }),
  notes:      text('notes'),
  createdAt:  integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:  integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  byStatusExpiry: index('idx_grants_status_expires').on(t.status, t.expiresAt),
  byLogin:        index('idx_grants_login').on(t.login),
  // инвариант «не больше одного активного периода на человека» держит сама база
  oneActive:      uniqueIndex('uq_grants_one_active').on(t.userId).where(sql`status = 'active'`),
}));

// Журнал напоминаний: UNIQUE(grantId, kind) — гарантия «не больше одного раза».
// Именно это спасает от дублей, когда крон и ленивый тик сработали одновременно.
export const notifications = table('notifications', {
  id:        text('id').primaryKey(),
  grantId:   text('grant_id').notNull(),
  kind:      text('kind').notNull(),              // t-3 | t-1 | t-0 | overdue | escalation-N | keep-7d | digest
  status:    text('status').notNull().default('pending'), // pending | sent | failed
  sentAt:    integer('sent_at', { mode: 'timestamp' }),
  chatId:    text('chat_id'),
  messageId: text('message_id'),
  error:     text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  uniq:    uniqueIndex('uq_notifications_grant_kind').on(t.grantId, t.kind),
  pending: index('idx_notifications_status').on(t.status, t.createdAt),
}));

// Кто что сделал: без этого через месяц не ответить на «а кто снял випку?».
export const audit = table('audit_log', {
  id:        text('id').primaryKey(),
  ts:        integer('ts', { mode: 'timestamp' }).notNull(),
  actor:     text('actor'),                       // tg user id
  action:    text('action').notNull(),
  grantId:   text('grant_id'),
  payload:   text('payload'),
}, (t) => ({
  byTs: index('idx_audit_ts').on(t.ts),
}));

// Настройки и состояние одним key/value: админы, tz, чат для напоминаний,
// id дашборд-сообщения, дата последнего дайджеста.
export const settings = table('settings', {
  key:       text('key').primaryKey(),
  value:     text('value', { mode: 'json' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});
