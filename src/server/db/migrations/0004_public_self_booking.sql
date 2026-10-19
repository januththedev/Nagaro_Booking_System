-- Public self-service booking provenance.
-- The inactive system principal gives database-authored reservations a stable
-- creator without making a login account or weakening the existing audit/FK
-- contract. Its password hash is intentionally invalid.

ALTER TABLE admin_user
  ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1));

ALTER TABLE reservation
  ADD COLUMN booking_channel TEXT NOT NULL DEFAULT 'STAFF'
  CHECK (booking_channel IN ('STAFF','PUBLIC'));

ALTER TABLE reservation
  ADD COLUMN manage_token_hash TEXT;

CREATE UNIQUE INDEX ux_reservation_manage_token
  ON reservation(manage_token_hash)
  WHERE manage_token_hash IS NOT NULL;
