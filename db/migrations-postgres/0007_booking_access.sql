-- Smart booking access (PostgreSQL/Supabase): customer access links, door
-- control, mandatory automatic locking, paid 15-minute extensions and staff
-- assistance. Mirrors src/server/db/migrations/0010_booking_access.sql.

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_check;
ALTER TABLE notification ADD CONSTRAINT notification_type_check
  CHECK (type IN ('NEW_BOOKING','BOOKING_CANCELLED','REMINDER','STAFF_ASSISTANCE','DOOR_ALERT','EXTENSION'));

-- ------------------------------------------------------------------ policy
-- One administrator-configured policy row. Money is integer cents; the
-- surcharge is basis points (2000 = 20%) so no floating point touches a price.
CREATE TABLE access_policy (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  links_enabled             INTEGER NOT NULL DEFAULT 1 CHECK (links_enabled IN (0,1)),
  early_access_minutes      INTEGER NOT NULL DEFAULT 0 CHECK (early_access_minutes BETWEEN 0 AND 120),
  link_retention_minutes    INTEGER NOT NULL DEFAULT 1440 CHECK (link_retention_minutes BETWEEN 15 AND 43200),
  default_unlock_minutes    INTEGER NOT NULL DEFAULT 5 CHECK (default_unlock_minutes IN (5,15,30)),
  allow_until_end           INTEGER NOT NULL DEFAULT 1 CHECK (allow_until_end IN (0,1)),
  require_phone_check       INTEGER NOT NULL DEFAULT 0 CHECK (require_phone_check IN (0,1)),
  extensions_enabled        INTEGER NOT NULL DEFAULT 1 CHECK (extensions_enabled IN (0,1)),
  surcharge_bps             INTEGER NOT NULL DEFAULT 2000 CHECK (surcharge_bps BETWEEN 0 AND 50000),
  max_extensions            INTEGER NOT NULL DEFAULT 4 CHECK (max_extensions BETWEEN 0 AND 48),
  max_extension_minutes     INTEGER NOT NULL DEFAULT 60 CHECK (max_extension_minutes BETWEEN 0 AND 720),
  require_approval          INTEGER NOT NULL DEFAULT 0 CHECK (require_approval IN (0,1)),
  pay_online_enabled        INTEGER NOT NULL DEFAULT 1 CHECK (pay_online_enabled IN (0,1)),
  pay_desk_enabled          INTEGER NOT NULL DEFAULT 0 CHECK (pay_desk_enabled IN (0,1)),
  min_payment_cents         INTEGER NOT NULL DEFAULT 0 CHECK (min_payment_cents >= 0),
  offer_before_end_minutes  INTEGER NOT NULL DEFAULT 15 CHECK (offer_before_end_minutes BETWEEN 0 AND 120),
  late_grace_minutes        INTEGER NOT NULL DEFAULT 5 CHECK (late_grace_minutes BETWEEN 0 AND 14),
  late_window_minutes       INTEGER NOT NULL DEFAULT 60 CHECK (late_window_minutes BETWEEN 0 AND 720),
  payment_hold_minutes      INTEGER NOT NULL DEFAULT 10 CHECK (payment_hold_minutes BETWEEN 3 AND 60),
  updated_by                BIGINT REFERENCES admin_user(id) ON DELETE SET NULL,
  updated_at                BIGINT NOT NULL
);
INSERT INTO access_policy (id, updated_at) VALUES (1, 0);

-- Per-room door controller and overrides. NULL override = inherit the policy.
CREATE TABLE space_access_config (
  space_id              BIGINT PRIMARY KEY REFERENCES space(id) ON DELETE CASCADE,
  links_enabled         INTEGER CHECK (links_enabled IS NULL OR links_enabled IN (0,1)),
  door_enabled          INTEGER NOT NULL DEFAULT 0 CHECK (door_enabled IN (0,1)),
  driver                TEXT    NOT NULL DEFAULT 'NONE' CHECK (driver IN ('NONE','HTTP','SIMULATED')),
  endpoint_url          TEXT,
  door_identifier       TEXT,
  confirms_state        INTEGER NOT NULL DEFAULT 1 CHECK (confirms_state IN (0,1)),
  allow_until_end       INTEGER CHECK (allow_until_end IS NULL OR allow_until_end IN (0,1)),
  extensions_enabled    INTEGER CHECK (extensions_enabled IS NULL OR extensions_enabled IN (0,1)),
  surcharge_bps         INTEGER CHECK (surcharge_bps IS NULL OR surcharge_bps BETWEEN 0 AND 50000),
  extension_base_cents  BIGINT CHECK (extension_base_cents IS NULL OR extension_base_cents >= 0),
  updated_by            BIGINT REFERENCES admin_user(id) ON DELETE SET NULL,
  updated_at            BIGINT NOT NULL
);
CREATE UNIQUE INDEX ux_space_access_door_identifier
  ON space_access_config(door_identifier) WHERE door_identifier IS NOT NULL;

-- ------------------------------------------------------------ access links
-- One capability link per reservation. Only the SHA-256 hash of the token is
-- kept; `delivery_token` is a transient outbox value that is cleared as soon
-- as email/SMS delivery reaches a final outcome.
CREATE TABLE booking_access_link (
  id                      BIGSERIAL PRIMARY KEY,
  reservation_id          BIGINT NOT NULL UNIQUE REFERENCES reservation(id) ON DELETE CASCADE,
  customer_id             BIGINT NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  space_id                BIGINT NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  token_hash              TEXT    NOT NULL UNIQUE,
  delivery_token          TEXT,
  status                  TEXT    NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  link_revoked_at         BIGINT,
  link_revoked_by         BIGINT REFERENCES admin_user(id) ON DELETE SET NULL,
  door_access_revoked_at  BIGINT,
  door_access_revoked_by  BIGINT REFERENCES admin_user(id) ON DELETE SET NULL,
  revoke_reason           TEXT,
  retain_until            BIGINT,
  email_status            TEXT    NOT NULL DEFAULT 'PENDING'
                          CHECK (email_status IN ('PENDING','SENT','FAILED','NOT_CONFIGURED','NO_ADDRESS')),
  email_error             TEXT,
  email_attempts          INTEGER NOT NULL DEFAULT 0,
  email_sent_at           BIGINT,
  sms_status              TEXT    NOT NULL DEFAULT 'PENDING'
                          CHECK (sms_status IN ('PENDING','SENT','FAILED','NOT_CONFIGURED','NO_ADDRESS')),
  sms_error               TEXT,
  sms_attempts            INTEGER NOT NULL DEFAULT 0,
  sms_sent_at             BIGINT,
  next_delivery_at        BIGINT,
  first_opened_at         BIGINT,
  last_opened_at          BIGINT,
  open_count              INTEGER NOT NULL DEFAULT 0,
  created_at              BIGINT NOT NULL,
  updated_at              BIGINT NOT NULL
);
CREATE INDEX ix_access_link_delivery ON booking_access_link(next_delivery_at)
  WHERE delivery_token IS NOT NULL;

-- Optional second factor: a browser that proved knowledge of the booking
-- telephone number. Only a hash of the device secret is stored.
CREATE TABLE booking_access_device (
  id              BIGSERIAL PRIMARY KEY,
  access_link_id  BIGINT NOT NULL REFERENCES booking_access_link(id) ON DELETE CASCADE,
  device_hash     TEXT    NOT NULL UNIQUE,
  verified_at     BIGINT NOT NULL
);

-- ------------------------------------------------------------------- doors
CREATE TABLE door_state (
  space_id                 BIGINT PRIMARY KEY REFERENCES space(id) ON DELETE CASCADE,
  reported_state           TEXT    NOT NULL DEFAULT 'UNKNOWN' CHECK (reported_state IN ('LOCKED','UNLOCKED','UNKNOWN')),
  reported_at              BIGINT,
  desired_state            TEXT    NOT NULL DEFAULT 'LOCKED' CHECK (desired_state IN ('LOCKED','UNLOCKED')),
  -- The mandatory deadline of the current unlock. Never NULL while an OPEN
  -- may have reached the controller; cleared only by a confirmed CLOSE.
  auto_lock_at             BIGINT,
  auto_lock_mode           TEXT    CHECK (auto_lock_mode IS NULL OR auto_lock_mode IN ('TIMED','UNTIL_END','STAFF')),
  unlocked_reservation_id  BIGINT REFERENCES reservation(id) ON DELETE SET NULL,
  controller_online        INTEGER NOT NULL DEFAULT 1 CHECK (controller_online IN (0,1)),
  last_contact_at          BIGINT,
  last_error               TEXT,
  updated_at               BIGINT NOT NULL
);
CREATE INDEX ix_door_state_due ON door_state(auto_lock_at) WHERE auto_lock_at IS NOT NULL;

-- Durable command queue. `idempotency_key` makes client retries and duplicate
-- scheduler deliveries collapse into one command; `lease_until` lets several
-- application instances share the queue without sending a command twice.
CREATE TABLE door_command (
  id                   BIGSERIAL PRIMARY KEY,
  space_id             BIGINT NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  reservation_id       BIGINT REFERENCES reservation(id) ON DELETE SET NULL,
  access_link_id       BIGINT REFERENCES booking_access_link(id) ON DELETE SET NULL,
  actor_type           TEXT    NOT NULL CHECK (actor_type IN ('CUSTOMER','STAFF','SYSTEM')),
  actor_admin_user_id  BIGINT REFERENCES admin_user(id) ON DELETE SET NULL,
  action               TEXT    NOT NULL CHECK (action IN ('OPEN','CLOSE')),
  reason               TEXT    NOT NULL,
  requested_minutes    INTEGER,
  auto_lock_at         BIGINT,
  idempotency_key      TEXT    NOT NULL UNIQUE,
  status               TEXT    NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING','SENDING','ACKNOWLEDGED','CONFIRMED','FAILED')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts >= 1),
  next_attempt_at      BIGINT NOT NULL,
  lease_until          BIGINT,
  last_error           TEXT,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL,
  completed_at         BIGINT
);
CREATE INDEX ix_door_command_due ON door_command(next_attempt_at) WHERE status IN ('PENDING','SENDING');
CREATE INDEX ix_door_command_space ON door_command(space_id, created_at DESC);
CREATE INDEX ix_door_command_reservation ON door_command(reservation_id, created_at DESC);

-- -------------------------------------------------------------- extensions
CREATE TABLE booking_extension (
  id                    BIGSERIAL PRIMARY KEY,
  reservation_id        BIGINT NOT NULL REFERENCES reservation(id) ON DELETE CASCADE,
  access_link_id        BIGINT REFERENCES booking_access_link(id) ON DELETE SET NULL,
  status                TEXT    NOT NULL CHECK (status IN (
                          'AWAITING_APPROVAL','AWAITING_PAYMENT','PAYMENT_PENDING','CONFIRMED',
                          'FAILED','EXPIRED','CANCELLED','REJECTED','REVIEW_REQUIRED','RESOLVED')),
  minutes               INTEGER NOT NULL DEFAULT 15 CHECK (minutes > 0),
  from_end_at           BIGINT NOT NULL,
  new_end_at            BIGINT NOT NULL,
  base_cents            BIGINT NOT NULL CHECK (base_cents >= 0),
  surcharge_bps         INTEGER NOT NULL CHECK (surcharge_bps >= 0),
  amount_cents          BIGINT NOT NULL CHECK (amount_cents >= 0),
  currency              TEXT    NOT NULL DEFAULT 'LKR',
  method                TEXT    NOT NULL CHECK (method IN ('PAYHERE','DESK','COMPLIMENTARY')),
  order_id              TEXT    UNIQUE,
  idempotency_key       TEXT    UNIQUE,
  hold_expires_at       BIGINT,
  provider_payment_id   TEXT,
  provider_method       TEXT,
  provider_status_code  TEXT,
  provider_message      TEXT,
  review_reason         TEXT,
  resolution            TEXT,
  resolution_note       TEXT,
  resolved_by           BIGINT REFERENCES admin_user(id) ON DELETE SET NULL,
  resolved_at           BIGINT,
  approved_by           BIGINT REFERENCES admin_user(id) ON DELETE SET NULL,
  approved_at           BIGINT,
  created_by_admin      BIGINT REFERENCES admin_user(id) ON DELETE SET NULL,
  seen_at               BIGINT,
  created_at            BIGINT NOT NULL,
  updated_at            BIGINT NOT NULL,
  confirmed_at          BIGINT,
  CHECK (new_end_at > from_end_at)
);
CREATE INDEX ix_booking_extension_reservation ON booking_extension(reservation_id, created_at DESC);
CREATE INDEX ix_booking_extension_hold ON booking_extension(hold_expires_at)
  WHERE status IN ('AWAITING_APPROVAL','AWAITING_PAYMENT','PAYMENT_PENDING');
-- At most one extension can be in flight for a booking.
CREATE UNIQUE INDEX ux_booking_extension_live ON booking_extension(reservation_id)
  WHERE status IN ('AWAITING_APPROVAL','AWAITING_PAYMENT','PAYMENT_PENDING');

-- The temporary availability hold of an in-flight extension: real occupancy
-- rows, so the existing overlap guard arbitrates against every other booking.
CREATE TABLE booking_extension_hold (
  id            BIGSERIAL PRIMARY KEY,
  extension_id  BIGINT NOT NULL REFERENCES booking_extension(id) ON DELETE CASCADE,
  occupancy_id  BIGINT NOT NULL REFERENCES occupancy(id) ON DELETE CASCADE,
  status        TEXT    NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED')),
  created_at    BIGINT NOT NULL,
  released_at   BIGINT
);
CREATE INDEX ix_extension_hold_extension ON booking_extension_hold(extension_id, status);

-- Every provider notification for an extension, accepted or not.
CREATE TABLE extension_payment_event (
  id                    BIGSERIAL PRIMARY KEY,
  extension_id          BIGINT REFERENCES booking_extension(id) ON DELETE SET NULL,
  event_fingerprint     TEXT    NOT NULL UNIQUE,
  signature_valid       INTEGER NOT NULL CHECK (signature_valid IN (0,1)),
  provider_payment_id   TEXT,
  provider_status_code  TEXT,
  sanitized_payload     TEXT    NOT NULL,
  received_at           BIGINT NOT NULL
);

-- -------------------------------------------------------- staff assistance
CREATE TABLE staff_assistance_request (
  id               BIGSERIAL PRIMARY KEY,
  reservation_id   BIGINT NOT NULL REFERENCES reservation(id) ON DELETE CASCADE,
  access_link_id   BIGINT REFERENCES booking_access_link(id) ON DELETE SET NULL,
  space_id         BIGINT NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  status           TEXT    NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  context_state    TEXT,
  created_at       BIGINT NOT NULL,
  acknowledged_by  BIGINT REFERENCES admin_user(id) ON DELETE SET NULL,
  acknowledged_at  BIGINT,
  resolved_by      BIGINT REFERENCES admin_user(id) ON DELETE SET NULL,
  resolved_at      BIGINT,
  resolution_note  TEXT
);
CREATE UNIQUE INDEX ux_staff_assistance_open ON staff_assistance_request(reservation_id)
  WHERE status IN ('OPEN','ACKNOWLEDGED');
CREATE INDEX ix_staff_assistance_status ON staff_assistance_request(status, created_at DESC);
