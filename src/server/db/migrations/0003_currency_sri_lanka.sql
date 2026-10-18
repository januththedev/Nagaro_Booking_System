-- Correct the business locale: the Sri Lankan Rupee (LKR) replaces the
-- Ethiopian Birr (ETB) default carried over from the original, incorrect
-- Addis Ababa assumption.
--
-- New rows already default to LKR (see 0001_init.sql); this migration upgrades
-- any pre-existing rows created before the venue was corrected, so a database
-- seeded under the old locale is brought in line without a wipe.

UPDATE space       SET currency = 'LKR' WHERE currency = 'ETB';
UPDATE reservation SET currency = 'LKR' WHERE currency = 'ETB';
