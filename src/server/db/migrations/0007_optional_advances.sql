-- Optional customer advances are immutable per payment attempt and are only
-- credited to the venue balance after PayHere's signed callback is verified.
ALTER TABLE payment_obligation
  ADD COLUMN advance_paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (advance_paid_cents >= 0);

ALTER TABLE payment_attempt
  ADD COLUMN advance_cents INTEGER NOT NULL DEFAULT 0 CHECK (advance_cents >= 0);
