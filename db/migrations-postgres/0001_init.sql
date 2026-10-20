-- Nagaro Space Booking — PostgreSQL/Supabase schema.
-- Runtime values intentionally mirror the SQLite schema: timestamps are UTC
-- epoch milliseconds and boolean flags are 0/1 integers. This keeps the same
-- tested booking and audit service contract on both engines.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE admin_user (
  id BIGSERIAL PRIMARY KEY,
  email CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'STAFF' CHECK (role IN ('ADMIN','STAFF')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_login_at BIGINT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until BIGINT,
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1))
);

CREATE TABLE admin_session (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  admin_user_id BIGINT NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  csrf_secret TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  revoked_at BIGINT,
  user_agent TEXT,
  ip_hash TEXT
);
CREATE INDEX ix_session_user ON admin_session(admin_user_id, expires_at);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  at BIGINT NOT NULL,
  actor_admin_user_id BIGINT REFERENCES admin_user(id) ON DELETE SET NULL,
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT NOT NULL,
  details TEXT
);
CREATE INDEX ix_audit_entity ON audit_log(entity_type, entity_id, at DESC);
CREATE INDEX ix_audit_at ON audit_log(at DESC);

CREATE TABLE space (
  id BIGSERIAL PRIMARY KEY,
  code CITEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('MEETING_ROOM','AUDITORIUM','COWORKING')),
  short_description TEXT,
  description TEXT,
  location TEXT,
  floor TEXT,
  capacity INTEGER NOT NULL CHECK (capacity >= 1),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  currency TEXT NOT NULL DEFAULT 'LKR',
  pricing_unit TEXT NOT NULL DEFAULT 'HOUR' CHECK (pricing_unit IN ('HOUR','HALF_DAY','DAY','WEEK','MONTH')),
  min_duration_minutes INTEGER NOT NULL DEFAULT 60 CHECK (min_duration_minutes > 0),
  max_duration_minutes INTEGER CHECK (max_duration_minutes IS NULL OR max_duration_minutes > 0),
  buffer_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0),
  open_time TEXT NOT NULL DEFAULT '08:00',
  close_time TEXT NOT NULL DEFAULT '18:00',
  amenities TEXT NOT NULL DEFAULT '[]',
  attributes TEXT NOT NULL DEFAULT '{}',
  contact_note TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  published_at BIGINT,
  archived_at BIGINT
);
CREATE INDEX ix_space_status_cat ON space(status, category);
CREATE INDEX ix_space_pricing ON space(pricing_unit);

CREATE TABLE space_rate (
  id BIGSERIAL PRIMARY KEY,
  space_id BIGINT NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  unit TEXT NOT NULL CHECK (unit IN ('HOUR','HALF_DAY','DAY','WEEK','MONTH')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  UNIQUE (space_id, unit)
);

CREATE TABLE space_image (
  id BIGSERIAL PRIMARY KEY,
  space_id BIGINT NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  stored_name TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  alt_text TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_cover INTEGER NOT NULL DEFAULT 0 CHECK (is_cover IN (0,1)),
  created_at BIGINT NOT NULL,
  blob_url TEXT,
  blob_pathname TEXT
);
CREATE INDEX ix_image_space_order ON space_image(space_id, sort_order);
CREATE UNIQUE INDEX ux_image_cover ON space_image(space_id) WHERE is_cover = 1;

CREATE TABLE resource_unit (
  id BIGSERIAL PRIMARY KEY,
  space_id BIGINT NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('EXCLUSIVE','DESK')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at BIGINT NOT NULL,
  UNIQUE (space_id, code)
);
CREATE INDEX ix_unit_space ON resource_unit(space_id, is_active);

CREATE TABLE customer (
  id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_normalized CITEXT NOT NULL,
  phone TEXT,
  organization TEXT,
  notes TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX ix_customer_email_norm ON customer(email_normalized);
CREATE INDEX ix_customer_name ON customer(lower(full_name));

CREATE TABLE reservation (
  id BIGSERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  space_id BIGINT NOT NULL REFERENCES space(id) ON DELETE RESTRICT,
  customer_id BIGINT NOT NULL REFERENCES customer(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED','CANCELLED','COMPLETED')),
  start_at BIGINT NOT NULL,
  end_at BIGINT NOT NULL,
  unit_count INTEGER NOT NULL DEFAULT 1 CHECK (unit_count >= 1),
  attendees INTEGER CHECK (attendees IS NULL OR attendees >= 0),
  purpose TEXT,
  internal_notes TEXT,
  billing_unit TEXT NOT NULL CHECK (billing_unit IN ('HOUR','HALF_DAY','DAY','WEEK','MONTH')),
  billing_quantity INTEGER NOT NULL CHECK (billing_quantity >= 1),
  rate_cents INTEGER NOT NULL CHECK (rate_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'LKR',
  idempotency_key TEXT UNIQUE,
  booking_channel TEXT NOT NULL DEFAULT 'STAFF' CHECK (booking_channel IN ('STAFF','PUBLIC')),
  manage_token_hash TEXT,
  created_by BIGINT NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL,
  updated_by BIGINT REFERENCES admin_user(id) ON DELETE SET NULL,
  updated_at BIGINT NOT NULL,
  cancelled_by BIGINT REFERENCES admin_user(id) ON DELETE SET NULL,
  cancelled_at BIGINT,
  cancellation_reason TEXT,
  CHECK (end_at > start_at),
  CHECK (status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL AND trim(cancellation_reason) <> ''))
);
CREATE UNIQUE INDEX ux_reservation_manage_token ON reservation(manage_token_hash) WHERE manage_token_hash IS NOT NULL;
CREATE INDEX ix_res_window ON reservation(start_at, end_at);
CREATE INDEX ix_res_space_window ON reservation(space_id, start_at);
CREATE INDEX ix_res_customer ON reservation(customer_id, start_at DESC);
CREATE INDEX ix_res_status ON reservation(status, start_at);

CREATE TABLE maintenance_block (
  id BIGSERIAL PRIMARY KEY,
  space_id BIGINT NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  start_at BIGINT NOT NULL,
  end_at BIGINT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  created_by BIGINT NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL,
  cancelled_by BIGINT REFERENCES admin_user(id) ON DELETE SET NULL,
  cancelled_at BIGINT,
  CHECK (end_at > start_at)
);
CREATE INDEX ix_maint_space ON maintenance_block(space_id, start_at);

CREATE TABLE occupancy (
  id BIGSERIAL PRIMARY KEY,
  resource_unit_id BIGINT NOT NULL REFERENCES resource_unit(id) ON DELETE CASCADE,
  space_id BIGINT NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  start_at BIGINT NOT NULL,
  end_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED')),
  source TEXT NOT NULL CHECK (source IN ('RESERVATION','MAINTENANCE')),
  reservation_id BIGINT REFERENCES reservation(id) ON DELETE CASCADE,
  maintenance_block_id BIGINT REFERENCES maintenance_block(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  released_at BIGINT,
  CHECK (end_at > start_at),
  CHECK ((source = 'RESERVATION') = (reservation_id IS NOT NULL))
);
ALTER TABLE occupancy ADD CONSTRAINT occupancy_no_overlap
  EXCLUDE USING gist (resource_unit_id WITH =, int8range(start_at, end_at, '[)') WITH &&)
  WHERE (status = 'ACTIVE');
CREATE INDEX ix_occ_unit_active ON occupancy(resource_unit_id, start_at) WHERE status = 'ACTIVE';
CREATE INDEX ix_occ_space_active ON occupancy(space_id, start_at) WHERE status = 'ACTIVE';
CREATE INDEX ix_occ_reservation ON occupancy(reservation_id);
CREATE INDEX ix_occ_maint ON occupancy(maintenance_block_id);

CREATE TABLE inquiry (
  id BIGSERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  space_id BIGINT REFERENCES space(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_normalized CITEXT NOT NULL,
  phone TEXT,
  organization TEXT,
  requested_start_at BIGINT NOT NULL,
  requested_end_at BIGINT NOT NULL,
  attendees INTEGER CHECK (attendees IS NULL OR attendees >= 0),
  desk_quantity INTEGER CHECK (desk_quantity IS NULL OR desk_quantity >= 1),
  message TEXT,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','CONTACTED','CONVERTED','CLOSED','WITHDRAWN')),
  withdraw_token_hash TEXT,
  email_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (email_status IN ('PENDING','SENT','FAILED','NOT_CONFIGURED')),
  email_error TEXT,
  email_attempted_at BIGINT,
  email_message_id TEXT,
  internal_notes TEXT,
  converted_reservation_id BIGINT REFERENCES reservation(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (requested_end_at > requested_start_at)
);
CREATE INDEX ix_inquiry_status ON inquiry(status, created_at DESC);
CREATE INDEX ix_inquiry_space ON inquiry(space_id, requested_start_at);
CREATE INDEX ix_inquiry_email ON inquiry(email_normalized);

CREATE TABLE rate_limit_counter (
  bucket_key TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);

CREATE TABLE app_sequence (
  name TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);
INSERT INTO app_sequence(name, value) VALUES ('reservation', 0), ('inquiry', 0)
  ON CONFLICT(name) DO NOTHING;
