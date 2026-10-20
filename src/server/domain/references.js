/**
 * Human-facing document references.
 *
 * References are allocated from `app_sequence` inside the caller's write
 * transaction, so two concurrent bookings can never receive the same number
 * (the UPDATE takes the write lock and the whole block is serialised).
 */
import { businessParts } from './time.js';

const PREFIX = {
  reservation: 'NG',
  inquiry: 'INQ',
  booking_request: 'REQ',
};

/**
 * Allocate the next reference for a sequence. MUST be called inside a write
 * transaction (withWriteTransaction) on the same database handle.
 */
export function nextReference(db, sequenceName, atMs = Date.now()) {
  const year = businessParts(atMs).year;
  db.prepare(`INSERT INTO app_sequence(name, value) VALUES (?, 0)
              ON CONFLICT(name) DO NOTHING`).run(sequenceName);
  const row = db.prepare(
    'UPDATE app_sequence SET value = value + 1 WHERE name = ? RETURNING value',
  ).get(sequenceName);
  const prefix = PREFIX[sequenceName] ?? 'REF';
  return `${prefix}-${year}-${String(row.value).padStart(5, '0')}`;
}

/** Cryptographically random URL-safe token (session ids, withdraw links). */
export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64url');
}
