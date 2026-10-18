-- PostgreSQL migration 0001: initial schema for Nagaro Space Booking.
-- Target: Supabase-hosted PostgreSQL.
-- Apply with: psql "$DIRECT_URL" -f db/migrations-postgres/0001_init.sql
-- Or via the Supabase SQL editor. Do NOT re-run against a populated database.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ---------- reference sequences ----------
CREATE TABLE IF NOT EXISTS app_sequence (
  name        text PRIMARY KEY,
  value       bigint NOT NULL DEFAULT 0
);
INSERT INTO app_sequence (name, value) VALUES ('reservation', 0), ('inquiry', 0)
  ON CONFLICT (name) DO NOTHING;

-- ---------- admin users ----------
CREATE TABLE IF NOT EXISTS admin_user (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('ADMIN','STAFF')),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_session (
  id            bigserial PRIMARY KEY,
  admin_user_id bigint NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  csrf_secret   text NOT NULL,
  user_agent    text,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_session_user ON admin_session(admin_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_session_expires ON admin_session(expires_at);

-- ---------- spaces ----------
CREATE TABLE IF NOT EXISTS space (
  id                    bigserial PRIMARY KEY,
  code                  text NOT NULL UNIQUE,
  name                  text NOT NULL,
  category              text NOT NULL CHECK (category IN ('MEETING_ROOM','AUDITORIUM','COWORKING')),
  short_description     text NOT NULL,
  description           text NOT NULL,
  location              text NOT NULL,
  floor                 text,
  capacity              integer NOT NULL CHECK (capacity >= 1),
  status                text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  currency              text NOT NULL DEFAULT 'ETB',
  pricing_unit          text NOT NULL CHECK (pricing_unit IN ('HOUR','HALF_DAY','DAY','WEEK','MONTH')),
  min_duration_minutes  integer NOT NULL DEFAULT 60 CHECK (min_duration_minutes >= 15),
  max_duration_minutes  integer,
  buffer_minutes        integer NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0 AND buffer_minutes <= 240),
  open_time             text NOT NULL DEFAULT '08:00',
  close_time            text NOT NULL DEFAULT '18:00',
  amenities             jsonb NOT NULL DEFAULT '[]'::jsonb,
  attributes            jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact_note          text,
  desk_count            integer,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  published_at          timestamptz,
  archived_at           timestamptz
);
CREATE INDEX IF NOT EXISTS idx_space_status ON space(status);
CREATE INDEX IF NOT EXISTS idx_space_category ON space(category);

CREATE TABLE IF NOT EXISTS space_rate (
  space_id   bigint NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  unit       text NOT NULL CHECK (unit IN ('HOUR','HALF_DAY','DAY','WEEK','MONTH')),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (space_id, unit)
);

CREATE TABLE IF NOT EXISTS resource_unit (
  id         bigserial PRIMARY KEY,
  space_id   bigint NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  code       text NOT NULL,
  label      text,
  kind       text NOT NULL CHECK (kind IN ('EXCLUSIVE','DESK')),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, code)
);
CREATE INDEX IF NOT EXISTS idx_resource_unit_space ON resource_unit(space_id);

CREATE TABLE IF NOT EXISTS space_image (
  id            bigserial PRIMARY KEY,
  space_id      bigint NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  stored_name   text NOT NULL,
  original_name text,
  mime_type     text NOT NULL,
  byte_size     bigint NOT NULL CHECK (byte_size >= 0),
  alt_text      text,
  sort_order    integer NOT NULL DEFAULT 0,
  is_cover      boolean NOT NULL DEFAULT false,
  blob_url      text,
  blob_pathname text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_space_image_space ON space_image(space_id);

-- ---------- customers ----------
CREATE TABLE IF NOT EXISTS customer (
  id               bigserial PRIMARY KEY,
  full_name        text NOT NULL,
  email            text,
  email_normalized text,
  phone            text,
  organization     text,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_email ON customer(email_normalized);
CREATE INDEX IF NOT EXISTS idx_customer_name ON customer(full_name);

-- ---------- reservations ----------
CREATE TABLE IF NOT EXISTS reservation (
  id                  bigserial PRIMARY KEY,
  reference           text NOT NULL UNIQUE,
  space_id            bigint NOT NULL REFERENCES space(id),
  customer_id         bigint NOT NULL REFERENCES customer(id),
  status              text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED','CANCELLED','COMPLETED')),
  start_at            timestamptz NOT NULL,
  end_at              timestamptz NOT NULL,
  unit_count          integer NOT NULL CHECK (unit_count >= 1),
  attendees           integer,
  purpose             text,
  internal_notes      text,
  billing_unit        text,
  billing_quantity    integer,
  rate_cents          integer,
  total_cents         integer,
  currency            text,
  idempotency_key     text UNIQUE,
  created_by          bigint REFERENCES admin_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          bigint REFERENCES admin_user(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  cancelled_by        bigint REFERENCES admin_user(id),
  cancelled_at        timestamptz,
  cancellation_reason text,
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS idx_reservation_space ON reservation(space_id);
CREATE INDEX IF NOT EXISTS idx_reservation_customer ON reservation(customer_id);
CREATE INDEX IF NOT EXISTS idx_reservation_status ON reservation(status);
CREATE INDEX IF NOT EXISTS idx_reservation_window ON reservation(space_id, start_at, end_at);

-- ---------- occupancy (concrete inventory claims) ----------
CREATE TABLE IF NOT EXISTS occupancy (
  id                    bigserial PRIMARY KEY,
  resource_unit_id      bigint NOT NULL REFERENCES resource_unit(id) ON DELETE CASCADE,
  space_id              bigint NOT NULL REFERENCES space(id),
  start_at              timestamptz NOT NULL,
  end_at                timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED')),
  source                text NOT NULL CHECK (source IN ('RESERVATION','MAINTENANCE')),
  reservation_id        bigint REFERENCES reservation(id) ON DELETE CASCADE,
  maintenance_block_id  bigint,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);

-- Database-enforced non-overlap for ACTIVE rows on the same unit.
-- Range is half-open [start, end).
ALTER TABLE occupancy
  ADD CONSTRAINT occupancy_no_overlap
  EXCLUDE USING gist (
    resource_unit_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  )
  WHERE (status = 'ACTIVE');

CREATE INDEX IF NOT EXISTS idx_occupancy_unit ON occupancy(resource_unit_id);
CREATE INDEX IF NOT EXISTS idx_occupancy_space ON occupancy(space_id);
CREATE INDEX IF NOT EXISTS idx_occupancy_reservation ON occupancy(reservation_id);

-- ---------- maintenance blocks ----------
CREATE TABLE IF NOT EXISTS maintenance_block (
  id            bigserial PRIMARY KEY,
  space_id      bigint NOT NULL REFERENCES space(id),
  start_at      timestamptz NOT NULL,
  end_at        timestamptz NOT NULL,
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  created_by    bigint REFERENCES admin_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_by  bigint REFERENCES admin_user(id),
  cancelled_at  timestamptz,
  cancellation_reason text,
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS idx_maintenance_space ON maintenance_block(space_id);
ALTER TABLE occupancy
  ADD CONSTRAINT occupancy_maintenance_fk
  FOREIGN KEY (maintenance_block_id) REFERENCES maintenance_block(id) ON DELETE CASCADE;

-- ---------- inquiries ----------
CREATE TABLE IF NOT EXISTS inquiry (
  id                  bigserial PRIMARY KEY,
  reference           text NOT NULL UNIQUE,
  space_id            bigint REFERENCES space(id),
  customer_name       text NOT NULL,
  email               text,
  email_normalized    text,
  phone               text,
  organization        text,
  requested_start     timestamptz,
  requested_end       timestamptz,
  desk_count          integer,
  attendees           integer,
  message             text,
  status              text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','CONTACTED','CONVERTED','CLOSED','WITHDRAWN')),
  email_status        text NOT NULL DEFAULT 'PENDING' CHECK (email_status IN ('PENDING','SENT','FAILED','NOT_CONFIGURED')),
  email_error         text,
  withdraw_token_hash text,
  internal_notes      text,
  converted_reservation_id bigint REFERENCES reservation(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inquiry_status ON inquiry(status);
CREATE INDEX IF NOT EXISTS idx_inquiry_created ON inquiry(created_at);

-- ---------- audit log ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_admin_user_id bigint REFERENCES admin_user(id),
  actor_label   text NOT NULL,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     bigint,
  summary       text NOT NULL,
  details       jsonb
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_admin_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

-- ---------- rate limit counters ----------
CREATE TABLE IF NOT EXISTS rate_limit_counter (
  key         text NOT NULL,
  window_start timestamptz NOT NULL,
  count       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- ---------- updated_at triggers ----------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_space_updated BEFORE UPDATE ON space
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_customer_updated BEFORE UPDATE ON customer
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_reservation_updated BEFORE UPDATE ON reservation
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_inquiry_updated BEFORE UPDATE ON inquiry
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_admin_user_updated BEFORE UPDATE ON admin_user
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
