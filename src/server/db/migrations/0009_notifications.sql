-- Admin notifications and Web Push subscriptions.
--
-- One row per (admin_user, notification). Reminders are HIGH priority and stay
-- unread until the recipient explicitly dismisses (marks) them. Push delivery
-- state lives on the notification so the cron tick can retry failures
-- idempotently; the payload itself is rebuilt from the referenced entity so a
-- lock-screen message never needs to repeat customer details.

CREATE TABLE notification (
  id              INTEGER PRIMARY KEY,
  admin_user_id   INTEGER NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  type            TEXT    NOT NULL CHECK (type IN ('NEW_BOOKING','BOOKING_CANCELLED','REMINDER')),
  title           TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  action_url      TEXT,
  priority        TEXT    NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','HIGH')),
  dedupe_key      TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  read_at         INTEGER,
  pushed_at       INTEGER,
  email_sent_at   INTEGER,
  UNIQUE (admin_user_id, dedupe_key)
);

-- Bell badge / "latest unread" query.
CREATE INDEX ix_notification_unread
  ON notification(admin_user_id, read_at, created_at DESC);

-- Pinned (HIGH) first, then newest.
CREATE INDEX ix_notification_priority
  ON notification(admin_user_id, priority, created_at DESC);

-- Cron retry scan: notifications whose push or reminder email has not been
-- delivered yet.
CREATE INDEX ix_notification_due
  ON notification(created_at)
  WHERE pushed_at IS NULL OR email_sent_at IS NULL;

CREATE TABLE push_subscription (
  id              INTEGER PRIMARY KEY,
  admin_user_id   INTEGER NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  endpoint        TEXT    NOT NULL UNIQUE,
  p256dh          TEXT    NOT NULL,
  auth            TEXT    NOT NULL,
  user_agent      TEXT,
  created_at      INTEGER NOT NULL,
  last_success_at INTEGER,
  failure_count   INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  revoked_at      INTEGER
);

CREATE INDEX ix_push_subscription_user
  ON push_subscription(admin_user_id, revoked_at);

-- Pruning: revoked rows and endpoints that have failed repeatedly.
CREATE INDEX ix_push_subscription_prune
  ON push_subscription(failure_count, revoked_at);
