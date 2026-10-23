-- Admin notifications and Web Push subscriptions (PostgreSQL/Supabase).
-- Mirrors src/server/db/migrations/0009_notifications.sql. Timestamps are UTC
-- epoch milliseconds and flags stay 0/1 integers, consistent with the rest of
-- the schema and the synchronous service layer.

CREATE TABLE notification (
  id              BIGSERIAL PRIMARY KEY,
  admin_user_id   BIGINT NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('NEW_BOOKING','BOOKING_CANCELLED','REMINDER')),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  action_url      TEXT,
  priority        TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','HIGH')),
  dedupe_key      TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  read_at         BIGINT,
  pushed_at       BIGINT,
  email_sent_at   BIGINT,
  UNIQUE (admin_user_id, dedupe_key)
);

CREATE INDEX ix_notification_unread
  ON notification(admin_user_id, read_at, created_at DESC);

CREATE INDEX ix_notification_priority
  ON notification(admin_user_id, priority, created_at DESC);

CREATE INDEX ix_notification_due
  ON notification(created_at)
  WHERE pushed_at IS NULL OR email_sent_at IS NULL;

CREATE TABLE push_subscription (
  id              BIGSERIAL PRIMARY KEY,
  admin_user_id   BIGINT NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  user_agent      TEXT,
  created_at      BIGINT NOT NULL,
  last_success_at BIGINT,
  failure_count   INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  revoked_at      BIGINT
);

CREATE INDEX ix_push_subscription_user
  ON push_subscription(admin_user_id, revoked_at);

CREATE INDEX ix_push_subscription_prune
  ON push_subscription(failure_count, revoked_at);
