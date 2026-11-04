-- ВНИМАНИЕ: это версия схемы для НЕ-serverless варианта (D1/Postgres/VPS) — оставлена для
-- сравнения. Живая схема проекта — vip-bot/tgcloud/schema.js (DSL платформы), и она проще:
-- Twitch API не используется, поэтому user_id/redeemed_id/meta_json там отсутствуют.
--
-- Схема для учёта Twitch VIP (SQLite / Cloudflare D1-совместимо, PostgreSQL — почти без правок).
-- Все даты — UTC, ISO-8601 строкой ('2026-11-04T15:00:00Z') в SQLite, timestamptz в Postgres.

-- ---------------------------------------------------------------------------
-- Выдачи VIP. Одна строка = один период. Продление = новая строка,
-- ссылающаяся на предыдущую через renewed_from_id (история не теряется).
-- ---------------------------------------------------------------------------
CREATE TABLE vip_grants (
  id                TEXT PRIMARY KEY,              -- uuid
  twitch_user_id    TEXT,                          -- null, пока не резолвнули логин
  login             TEXT NOT NULL,                 -- нижний регистр, без @
  display_name      TEXT,
  source            TEXT NOT NULL DEFAULT 'manual',-- 'channel_points' | 'manual' | 'donation' | 'other'
  granted_at        TEXT NOT NULL,                 -- когда выдан
  expires_at        TEXT NOT NULL,                 -- granted_at + период
  status            TEXT NOT NULL DEFAULT 'active',
    -- 'pending'  — создан, но VIP ещё не выдан (или логин не резолвлен)
    -- 'active'   — VIP выдан и действует
    -- 'expiring' — попали в окно T-3 (ставится кроном, для удобных выборок)
    -- 'expired'  — срок истёк, действие не выполнено
    -- 'removed'  — VIP снят
    -- 'keep'     — решили оставить, следим дальше (напоминание через 7 дней)
    -- 'waitlist' — хотим выдать, но нет свободных слотов VIP (409)
    -- 'cancelled'— запись отменена как ошибочная (soft-delete)
  granted_by        TEXT,                          -- tg_user_id модератора или 'channel_points'
  redeemed_id       TEXT,                          -- redemption.id из EventSub (дедуп)
  renewed_from_id   TEXT REFERENCES vip_grants(id),
  period_days       INTEGER NOT NULL DEFAULT 30,
  notes             TEXT,
  meta_json         TEXT,                          -- произвольные поля (сообщение редима, стоимость и т.п.)
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Быстрая выборка для крона и списков.
CREATE INDEX idx_vip_status_expires ON vip_grants (status, expires_at);
CREATE INDEX idx_vip_user           ON vip_grants (twitch_user_id, status);
CREATE INDEX idx_vip_login          ON vip_grants (login);

-- Один активный период на человека. В SQLite — частичный уникальный индекс.
CREATE UNIQUE INDEX uq_vip_one_active
  ON vip_grants (twitch_user_id)
  WHERE status = 'active' AND twitch_user_id IS NOT NULL;

-- Дедуп повторно доставленных редимов.
CREATE UNIQUE INDEX uq_vip_redeemed
  ON vip_grants (redeemed_id)
  WHERE redeemed_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Журнал уведомлений: гарантия «не больше одного напоминания на запись/тип».
-- kind: 't-3' | 't-1' | 't-0' | 'overdue' | 'escalation-1..4' | 'keep-7d' | 'digest'
-- ---------------------------------------------------------------------------
CREATE TABLE notifications_log (
  id         TEXT PRIMARY KEY,
  grant_id   TEXT REFERENCES vip_grants(id),
  kind       TEXT NOT NULL,
  sent_at    TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'failed'
  error      TEXT,
  tg_chat_id TEXT,
  tg_message_id TEXT,                          -- чтобы потом редактировать сообщение
  created_at TEXT NOT NULL,
  UNIQUE (grant_id, kind)
);

CREATE INDEX idx_notif_pending ON notifications_log (status, created_at);

-- ---------------------------------------------------------------------------
-- Аудит: кто из модераторов что сделал (включая нажатия инлайн-кнопок).
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  actor_tg_id TEXT,
  action      TEXT NOT NULL,     -- 'add' | 'extend' | 'remove' | 'keep' | 'cancel' | 'sync' | 'auto-grant'
  grant_id    TEXT,
  payload_json TEXT
);

CREATE INDEX idx_audit_ts ON audit_log (ts DESC);

-- ---------------------------------------------------------------------------
-- Настройки (key/value JSON): tz, reminder_hours, default_period_days,
-- reward_id, dashboard_message_id, last_cron_run_at, last_sync_at.
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- OAuth-токены Twitch. Заполняется только в режиме A (доступ стримера).
-- access_token/refresh_token хранятся в зашифрованном виде (AES-GCM).
-- внимательно: refresh_token ротируется при каждом обновлении!
-- ---------------------------------------------------------------------------
CREATE TABLE oauth_tokens (
  id            TEXT PRIMARY KEY,        -- 'broadcaster'
  twitch_user_id TEXT NOT NULL,
  scopes        TEXT NOT NULL,
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Одноразовые токены для callback_data инлайн-кнопок: старые сообщения
-- не должны уметь менять «чужую»/уже закрытую запись.
-- ---------------------------------------------------------------------------
CREATE TABLE callback_tokens (
  token      TEXT PRIMARY KEY,       -- короткий случайный (8-12 символов)
  grant_id   TEXT REFERENCES vip_grants(id),
  action     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Дедуп входящих внешних событий (EventSub + Telegram update_id).
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_events (
  event_id   TEXT PRIMARY KEY,
  source     TEXT NOT NULL,          -- 'twitch' | 'telegram'
  received_at TEXT NOT NULL
);
