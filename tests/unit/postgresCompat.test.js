import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresSql } from '../../src/server/db/postgresCompat.js';

test('PostgreSQL compatibility converts placeholders without touching quoted question marks', () => {
  assert.equal(
    postgresSql("SELECT '?' AS literal, id FROM space WHERE code = ? AND status = ?"),
    "SELECT '?' AS literal, id FROM space WHERE code = $1 AND status = $2",
  );
});

test('PostgreSQL compatibility maps SQLite case-insensitive search and insert-ignore syntax', () => {
  assert.equal(
    postgresSql('SELECT * FROM space WHERE name LIKE ? COLLATE NOCASE'),
    'SELECT * FROM space WHERE name ILIKE $1',
  );
  assert.equal(
    postgresSql('INSERT OR IGNORE INTO admin_user(email) VALUES (?)'),
    'INSERT INTO admin_user(email) VALUES ($1) ON CONFLICT DO NOTHING',
  );
});

test('PostgreSQL compatibility returns generated ids only for identity tables', () => {
  assert.match(
    postgresSql('INSERT INTO customer(full_name) VALUES (?)', { returningId: true }),
    /RETURNING id$/,
  );
  assert.doesNotMatch(
    postgresSql('INSERT INTO app_sequence(name, value) VALUES (?, ?)', { returningId: true }),
    /RETURNING id$/,
  );
});

test('PostgreSQL compatibility maps immediate transactions and overlap-duration aggregates', () => {
  assert.equal(postgresSql('BEGIN IMMEDIATE'), 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  const translated = postgresSql('SELECT SUM(MAX(0, MIN(o.end_at, ?) - MAX(o.start_at, ?))) AS booked_ms FROM occupancy o');
  assert.match(translated, /SUM\(GREATEST\(0, LEAST\(o\.end_at, \$1\) - GREATEST\(o\.start_at, \$2\)\)\)/);
});
