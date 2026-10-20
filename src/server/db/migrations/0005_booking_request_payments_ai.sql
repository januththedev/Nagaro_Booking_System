-- Unified request -> approval/hold -> payment -> confirmation workflow.
-- Existing confirmed reservations remain untouched.

CREATE TABLE booking_request (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  space_id INTEGER NOT NULL REFERENCES space(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN (
    'REQUESTED','APPROVED_AWAITING_PAYMENT','CONFIRMED','REJECTED','CANCELLED',
    'EXPIRED','PAYMENT_REVIEW_REQUIRED'
  )),
  payment_status TEXT NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN (
    'NOT_REQUIRED','UNPAID','PENDING','PAID','FAILED','REVIEW_REQUIRED','REFUNDED'
  )),
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  phone TEXT,
  organization TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  unit_count INTEGER NOT NULL DEFAULT 1 CHECK (unit_count >= 1),
  attendees INTEGER CHECK (attendees IS NULL OR attendees >= 1),
  purpose TEXT,
  billing_unit TEXT NOT NULL CHECK (billing_unit IN ('HOUR','HALF_DAY','DAY','WEEK','MONTH')),
  billing_quantity INTEGER NOT NULL CHECK (billing_quantity >= 1),
  rate_cents INTEGER NOT NULL CHECK (rate_cents >= 0),
  venue_total_cents INTEGER NOT NULL CHECK (venue_total_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'LKR',
  manage_token_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT UNIQUE,
  reservation_id INTEGER REFERENCES reservation(id) ON DELETE SET NULL,
  approved_by INTEGER REFERENCES admin_user(id) ON DELETE SET NULL,
  approved_at INTEGER,
  rejected_by INTEGER REFERENCES admin_user(id) ON DELETE SET NULL,
  rejected_at INTEGER,
  rejection_reason TEXT,
  hold_expires_at INTEGER,
  confirmed_at INTEGER,
  cancelled_at INTEGER,
  cancellation_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (end_at > start_at)
);
CREATE INDEX ix_booking_request_status ON booking_request(status, created_at DESC);
CREATE INDEX ix_booking_request_space_window ON booking_request(space_id, start_at, end_at);
CREATE INDEX ix_booking_request_email ON booking_request(email_normalized);

CREATE TABLE booking_hold_claim (
  id INTEGER PRIMARY KEY,
  booking_request_id INTEGER NOT NULL REFERENCES booking_request(id) ON DELETE CASCADE,
  occupancy_id INTEGER NOT NULL UNIQUE REFERENCES occupancy(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  UNIQUE (booking_request_id, occupancy_id)
);
CREATE INDEX ix_hold_request ON booking_hold_claim(booking_request_id);
CREATE INDEX ix_hold_expiry ON booking_hold_claim(status, expires_at);

CREATE TABLE booking_fee_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'DISABLED' CHECK (mode IN ('DISABLED','FIXED','PERCENTAGE')),
  fixed_cents INTEGER NOT NULL DEFAULT 0 CHECK (fixed_cents >= 0),
  percentage_bps INTEGER NOT NULL DEFAULT 0 CHECK (percentage_bps BETWEEN 0 AND 10000),
  payment_window_minutes INTEGER NOT NULL DEFAULT 120 CHECK (payment_window_minutes BETWEEN 5 AND 10080),
  updated_by INTEGER REFERENCES admin_user(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO booking_fee_policy(id, mode, fixed_cents, percentage_bps, payment_window_minutes, updated_at)
VALUES (1, 'DISABLED', 0, 0, 120, 0);

CREATE TABLE payment_obligation (
  id INTEGER PRIMARY KEY,
  booking_request_id INTEGER NOT NULL UNIQUE REFERENCES booking_request(id) ON DELETE CASCADE,
  policy_mode TEXT NOT NULL CHECK (policy_mode IN ('DISABLED','FIXED','PERCENTAGE')),
  policy_value INTEGER NOT NULL CHECK (policy_value >= 0),
  booking_fee_cents INTEGER NOT NULL CHECK (booking_fee_cents >= 0),
  venue_total_cents INTEGER NOT NULL CHECK (venue_total_cents >= 0),
  remaining_balance_cents INTEGER NOT NULL CHECK (remaining_balance_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'LKR',
  created_at INTEGER NOT NULL
);

CREATE TABLE payment_attempt (
  id INTEGER PRIMARY KEY,
  booking_request_id INTEGER NOT NULL REFERENCES booking_request(id) ON DELETE CASCADE,
  obligation_id INTEGER NOT NULL REFERENCES payment_obligation(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','PENDING','SUCCEEDED','FAILED','CANCELLED','REVIEW_REQUIRED')),
  provider_payment_id TEXT,
  provider_method TEXT,
  provider_status_code TEXT,
  provider_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ix_payment_attempt_request ON payment_attempt(booking_request_id, created_at DESC);

CREATE TABLE payment_event (
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER REFERENCES payment_attempt(id) ON DELETE SET NULL,
  event_fingerprint TEXT NOT NULL UNIQUE,
  signature_valid INTEGER NOT NULL CHECK (signature_valid IN (0,1)),
  provider_payment_id TEXT,
  provider_status_code TEXT,
  sanitized_payload TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE ai_booking_draft (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  space_code TEXT,
  date_key TEXT,
  start_time TEXT,
  end_time TEXT,
  attendees INTEGER,
  unit_count INTEGER,
  purpose TEXT,
  customer_name TEXT,
  email TEXT,
  phone TEXT,
  organization TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

INSERT INTO app_sequence(name, value) VALUES ('booking_request', 0)
ON CONFLICT(name) DO NOTHING;
