-- ============================================================================
-- Nagaro Space Booking System - Migration 0001 (initial schema)
-- Target engine: SQLite 3.35+ (executed via node:sqlite, SQLite 3.53.4)
--
-- TIME CONVENTIONS
--   All *_at columns are INTEGER Unix epoch milliseconds in UTC.
--   Local business time zone is Africa/Addis_Ababa (EAT, UTC+03:00, no DST).
--
-- INTERVAL CONVENTIONS
--   Intervals are half-open [start_at, end_at).
--   Two intervals conflict iff  a.start_at < b.end_at AND a.end_at > b.start_at
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Staff identity, sessions, audit
-- ---------------------------------------------------------------------------
CREATE TABLE admin_user (
  id              INTEGER PRIMARY KEY,
  email           TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  password_hash   TEXT    NOT NULL,
  display_name    TEXT    NOT NULL,
  role            TEXT    NOT NULL DEFAULT 'STAFF' CHECK (role IN ('ADMIN','STAFF')),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_login_at   INTEGER,
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER
);

CREATE TABLE admin_session (
  id              INTEGER PRIMARY KEY,
  token_hash      TEXT    NOT NULL UNIQUE,
  admin_user_id   INTEGER NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  csrf_secret     TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  revoked_at      INTEGER,
  user_agent      TEXT,
  ip_hash         TEXT
);
CREATE INDEX ix_session_user ON admin_session(admin_user_id, expires_at);

CREATE TABLE audit_log (
  id                  INTEGER PRIMARY KEY,
  at                  INTEGER NOT NULL,
  actor_admin_user_id INTEGER REFERENCES admin_user(id) ON DELETE SET NULL,
  actor_label         TEXT    NOT NULL,
  action              TEXT    NOT NULL,
  entity_type         TEXT    NOT NULL,
  entity_id           TEXT,
  summary             TEXT    NOT NULL,
  details             TEXT
);
CREATE INDEX ix_audit_entity ON audit_log(entity_type, entity_id, at DESC);
CREATE INDEX ix_audit_at ON audit_log(at DESC);

-- ---------------------------------------------------------------------------
-- Spaces, rates, images, bookable resource units
-- ---------------------------------------------------------------------------
CREATE TABLE space (
  id                    INTEGER PRIMARY KEY,
  code                  TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  name                  TEXT    NOT NULL,
  category              TEXT    NOT NULL CHECK (category IN ('MEETING_ROOM','AUDITORIUM','COWORKING')),
  short_description     TEXT,
  description           TEXT,
  location              TEXT,
  floor                 TEXT,
  capacity              INTEGER NOT NULL CHECK (capacity >= 1),
  status                TEXT    NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  currency              TEXT    NOT NULL DEFAULT 'ETB',
  pricing_unit          TEXT    NOT NULL DEFAULT 'HOUR'
                        CHECK (pricing_unit IN ('HOUR','HALF_DAY','DAY','WEEK','MONTH')),
  min_duration_minutes  INTEGER NOT NULL DEFAULT 60 CHECK (min_duration_minutes > 0),
  max_duration_minutes  INTEGER CHECK (max_duration_minutes IS NULL OR max_duration_minutes > 0),
  buffer_minutes        INTEGER NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0),
  open_time             TEXT    NOT NULL DEFAULT '08:00',
  close_time            TEXT    NOT NULL DEFAULT '18:00',
  amenities             TEXT    NOT NULL DEFAULT '[]',
  attributes            TEXT    NOT NULL DEFAULT '{}',
  contact_note          TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  published_at          INTEGER,
  archived_at           INTEGER
);
CREATE INDEX ix_space_status_cat ON space(status, category);
CREATE INDEX ix_space_pricing ON space(pricing_unit);

-- Cancellation policy / booking rules are expressed per space so the
-- "do not require irrelevant fields for every category" rule holds.
CREATE TABLE space_rate (
  id            INTEGER PRIMARY KEY,
  space_id      INTEGER NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  unit          TEXT    NOT NULL CHECK (unit IN ('HOUR','HALF_DAY','DAY','WEEK','MONTH')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  UNIQUE (space_id, unit)
);

CREATE TABLE space_image (
  id            INTEGER PRIMARY KEY,
  space_id      INTEGER NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  stored_name   TEXT    NOT NULL UNIQUE,
  original_name TEXT    NOT NULL,
  mime_type     TEXT    NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size > 0),
  alt_text      TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_cover      INTEGER NOT NULL DEFAULT 0 CHECK (is_cover IN (0,1)),
  created_at    INTEGER NOT NULL
);
CREATE INDEX ix_image_space_order ON space_image(space_id, sort_order);
-- At most one cover image per space.
CREATE UNIQUE INDEX ux_image_cover ON space_image(space_id) WHERE is_cover = 1;

-- A space has 1..N independently bookable resource units.
--   MEETING_ROOM / AUDITORIUM -> exactly one unit of kind EXCLUSIVE
--   COWORKING                 -> N units of kind DESK (N = desk inventory)
CREATE TABLE resource_unit (
  id          INTEGER PRIMARY KEY,
  space_id    INTEGER NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  code        TEXT    NOT NULL,
  label       TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('EXCLUSIVE','DESK')),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  INTEGER NOT NULL,
  UNIQUE (space_id, code)
);
CREATE INDEX ix_unit_space ON resource_unit(space_id, is_active);

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
CREATE TABLE customer (
  id               INTEGER PRIMARY KEY,
  full_name        TEXT    NOT NULL,
  email            TEXT    NOT NULL,
  email_normalized TEXT    NOT NULL,
  phone            TEXT,
  organization     TEXT,
  notes            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX ix_customer_email_norm ON customer(email_normalized);
CREATE INDEX ix_customer_name ON customer(full_name COLLATE NOCASE);

-- ---------------------------------------------------------------------------
-- Reservations - the authoritative booking record
-- ---------------------------------------------------------------------------
CREATE TABLE reservation (
  id                INTEGER PRIMARY KEY,
  reference         TEXT    NOT NULL UNIQUE,
  space_id          INTEGER NOT NULL REFERENCES space(id) ON DELETE RESTRICT,
  customer_id       INTEGER NOT NULL REFERENCES customer(id) ON DELETE RESTRICT,
  status            TEXT    NOT NULL CHECK (status IN ('CONFIRMED','CANCELLED','COMPLETED')),
  start_at          INTEGER NOT NULL,
  end_at            INTEGER NOT NULL,
  unit_count        INTEGER NOT NULL DEFAULT 1 CHECK (unit_count >= 1),
  attendees         INTEGER CHECK (attendees IS NULL OR attendees >= 0),
  purpose           TEXT,
  internal_notes    TEXT,
  billing_unit      TEXT    NOT NULL CHECK (billing_unit IN ('HOUR','HALF_DAY','DAY','WEEK','MONTH')),
  billing_quantity  INTEGER NOT NULL CHECK (billing_quantity >= 1),
  rate_cents        INTEGER NOT NULL CHECK (rate_cents >= 0),
  total_cents       INTEGER NOT NULL CHECK (total_cents >= 0),
  currency          TEXT    NOT NULL DEFAULT 'ETB',
  idempotency_key   TEXT    UNIQUE,
  created_by        INTEGER NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  created_at        INTEGER NOT NULL,
  updated_by        INTEGER REFERENCES admin_user(id) ON DELETE SET NULL,
  updated_at        INTEGER NOT NULL,
  cancelled_by      INTEGER REFERENCES admin_user(id) ON DELETE SET NULL,
  cancelled_at      INTEGER,
  cancellation_reason TEXT,
  CHECK (end_at > start_at),
  CHECK (status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL AND trim(cancellation_reason) <> ''))
);
CREATE INDEX ix_res_window ON reservation(start_at, end_at);
CREATE INDEX ix_res_space_window ON reservation(space_id, start_at);
CREATE INDEX ix_res_customer ON reservation(customer_id, start_at DESC);
CREATE INDEX ix_res_status ON reservation(status, start_at);

-- ---------------------------------------------------------------------------
-- Occupancy - concrete inventory claims. THE double-booking guard.
--
-- Rules:
--   * One row per (resource unit, interval).
--   * status = ACTIVE   -> the interval is consumed
--   * status = RELEASED -> released (cancellation / booking edit). Retained for audit.
--   * source = MAINTENANCE rows carry no reservation and block inventory too.
--   * Both a BEFORE INSERT and a BEFORE UPDATE trigger reject any insert or
--     change that would create two overlapping ACTIVE rows on the same
--     resource unit. This is enforced by the database engine itself, so it
--     holds for every code path, including ones added later.
-- ---------------------------------------------------------------------------
CREATE TABLE occupancy (
  id                  INTEGER PRIMARY KEY,
  resource_unit_id    INTEGER NOT NULL REFERENCES resource_unit(id) ON DELETE CASCADE,
  space_id            INTEGER NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  start_at            INTEGER NOT NULL,
  end_at              INTEGER NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED')),
  source              TEXT    NOT NULL CHECK (source IN ('RESERVATION','MAINTENANCE')),
  reservation_id      INTEGER REFERENCES reservation(id) ON DELETE CASCADE,
  maintenance_block_id INTEGER,
  created_at          INTEGER NOT NULL,
  released_at         INTEGER,
  CHECK (end_at > start_at),
  CHECK ((source = 'RESERVATION') = (reservation_id IS NOT NULL))
);
CREATE INDEX ix_occ_unit_active ON occupancy(resource_unit_id, start_at) WHERE status = 'ACTIVE';
CREATE INDEX ix_occ_space_active ON occupancy(space_id, start_at) WHERE status = 'ACTIVE';
CREATE INDEX ix_occ_reservation ON occupancy(reservation_id);
CREATE INDEX ix_occ_maint ON occupancy(maintenance_block_id);

CREATE TRIGGER trg_occupancy_no_overlap_insert
BEFORE INSERT ON occupancy
FOR EACH ROW WHEN NEW.status = 'ACTIVE'
BEGIN
  SELECT RAISE(ABORT, 'DOUBLE_BOOKING_CONFLICT')
  WHERE EXISTS (
    SELECT 1 FROM occupancy o
    WHERE o.resource_unit_id = NEW.resource_unit_id
      AND o.status = 'ACTIVE'
      AND o.id <> NEW.id
      AND o.start_at < NEW.end_at
      AND o.end_at   > NEW.start_at
  );
END;

CREATE TRIGGER trg_occupancy_no_overlap_update
BEFORE UPDATE ON occupancy
FOR EACH ROW WHEN NEW.status = 'ACTIVE'
BEGIN
  SELECT RAISE(ABORT, 'DOUBLE_BOOKING_CONFLICT')
  WHERE EXISTS (
    SELECT 1 FROM occupancy o
    WHERE o.resource_unit_id = NEW.resource_unit_id
      AND o.status = 'ACTIVE'
      AND o.id <> NEW.id
      AND o.start_at < NEW.end_at
      AND o.end_at   > NEW.start_at
  );
END;

CREATE TABLE maintenance_block (
  id            INTEGER PRIMARY KEY,
  space_id      INTEGER NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  start_at      INTEGER NOT NULL,
  end_at        INTEGER NOT NULL,
  reason        TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  created_by    INTEGER NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  created_at    INTEGER NOT NULL,
  cancelled_by  INTEGER REFERENCES admin_user(id) ON DELETE SET NULL,
  cancelled_at  INTEGER,
  CHECK (end_at > start_at)
);
CREATE INDEX ix_maint_space ON maintenance_block(space_id, start_at);

-- ---------------------------------------------------------------------------
-- Public booking inquiries
-- ---------------------------------------------------------------------------
CREATE TABLE inquiry (
  id                    INTEGER PRIMARY KEY,
  reference             TEXT    NOT NULL UNIQUE,
  space_id              INTEGER REFERENCES space(id) ON DELETE SET NULL,
  customer_name         TEXT    NOT NULL,
  email                 TEXT    NOT NULL,
  email_normalized      TEXT    NOT NULL,
  phone                 TEXT,
  organization          TEXT,
  requested_start_at    INTEGER NOT NULL,
  requested_end_at      INTEGER NOT NULL,
  attendees             INTEGER CHECK (attendees IS NULL OR attendees >= 0),
  desk_quantity         INTEGER CHECK (desk_quantity IS NULL OR desk_quantity >= 1),
  message               TEXT,
  status                TEXT    NOT NULL DEFAULT 'NEW'
                        CHECK (status IN ('NEW','CONTACTED','CONVERTED','CLOSED','WITHDRAWN')),
  withdraw_token_hash   TEXT,
  email_status          TEXT    NOT NULL DEFAULT 'PENDING'
                        CHECK (email_status IN ('PENDING','SENT','FAILED','NOT_CONFIGURED')),
  email_error           TEXT,
  email_attempted_at    INTEGER,
  email_message_id      TEXT,
  internal_notes        TEXT,
  converted_reservation_id INTEGER REFERENCES reservation(id) ON DELETE SET NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  CHECK (requested_end_at > requested_start_at)
);
CREATE INDEX ix_inquiry_status ON inquiry(status, created_at DESC);
CREATE INDEX ix_inquiry_space ON inquiry(space_id, requested_start_at);
CREATE INDEX ix_inquiry_email ON inquiry(email_normalized);

-- ---------------------------------------------------------------------------
-- Abuse controls (multi-process safe, DB backed fixed window counters)
-- ---------------------------------------------------------------------------
CREATE TABLE rate_limit_counter (
  bucket_key   TEXT    NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);

-- ---------------------------------------------------------------------------
-- Monotonic document numbering
-- ---------------------------------------------------------------------------
CREATE TABLE app_sequence (
  name  TEXT    PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
INSERT INTO app_sequence(name, value) VALUES ('reservation', 0), ('inquiry', 0);
