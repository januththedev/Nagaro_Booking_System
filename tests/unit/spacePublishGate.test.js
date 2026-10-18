/**
 * Publication gate and catalogue invariants, exercised against a real
 * in-memory SQLite database with the production migrations applied.
 *
 * This file deliberately builds its own handle instead of using
 * `tests/helpers/testDb.js`, so the gate is proven against raw SQLite
 * semantics (foreign keys on, real CHECK constraints, the anti-overlap
 * triggers) with nothing shared with another workstream's helper.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { SPACE_CATEGORY, SPACE_STATUS } from '../../src/server/domain/constants.js';
import { businessLocalToEpoch, todayBusinessDate } from '../../src/server/domain/time.js';
import { parseSpacePayload } from '../../src/server/domain/validation.js';
import { hashPassword } from '../../src/server/security/passwords.js';
import { cancelReservation, createReservation } from '../../src/server/services/bookingService.js';
import {
  addImageRecord, archiveSpace, createSpace, getSpace, publishSpace,
  publishabilityIssues, restoreSpace, setDeskCount,
} from '../../src/server/services/spaceService.js';

/* --------------------------------------------------------------- fixtures */

// Hashed once: scrypt is deliberately slow and every test needs the same user.
const PASSWORD_HASH = hashPassword('TestPassword123');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);
  return db;
}

let nextEmail = 0;
/** A real admin_user row, so audit-log foreign keys resolve. */
function insertActor(db, role = 'ADMIN') {
  nextEmail += 1;
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO admin_user (email, password_hash, display_name, role, is_active, created_at, updated_at)
    VALUES (?,?,?,?,1,?,?)
  `).run(`admin${nextEmail}@test.local`, PASSWORD_HASH, 'Gate Tester', role, now, now);
  const id = Number(info.lastInsertRowid);
  return { id, label: `Gate Tester (${role})`, role };
}

function insertCustomer(db) {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO customer (full_name, email, email_normalized, created_at, updated_at)
    VALUES (?,?,?,?,?)
  `).run('Ada Visitor', 'ada@test.local', 'ada@test.local', now, now);
  return Number(info.lastInsertRowid);
}

const MEETING_PAYLOAD = Object.freeze({
  code: 'MR-01',
  name: 'Meeting room 1',
  category: SPACE_CATEGORY.MEETING_ROOM,
  short_description: 'A quiet room for four, on the second floor.',
  description: 'A quiet meeting room with a table for four, a display screen and a whiteboard.',
  location: 'Trace Expert City, Building A',
  capacity: 4,
  open_time: '08:00',
  close_time: '18:00',
  pricing_unit: 'HOUR',
  rates: [{ unit: 'HOUR', amount_cents: 150000 }],
});

const COWORKING_PAYLOAD = Object.freeze({
  code: 'CW-01',
  name: 'Co-working floor',
  category: SPACE_CATEGORY.COWORKING,
  short_description: 'Bright open-plan desks with fast internet.',
  description: 'A bright open-plan floor with twenty desks, standing options and fast internet.',
  location: 'Trace Expert City, Building B',
  capacity: 20,
  open_time: '08:00',
  close_time: '18:00',
  pricing_unit: 'DAY',
  desk_count: 2,
  rates: [{ unit: 'DAY', amount_cents: 50000 }],
});

function fakeStoredName(letter, extension = 'jpg') {
  return `${letter.repeat(32)}.${extension}`;
}

let db;
let actor;

before(() => {
  db = freshDb();
  actor = insertActor(db);
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
});

/* --------------------------------------------------------- publication gate */

describe('publication gate', () => {
  test('publishSpace refuses a space without a photograph and names the requirement', () => {
    const space = createSpace(db, { actor, payload: { ...MEETING_PAYLOAD } });
    assert.equal(space.status, SPACE_STATUS.DRAFT);

    const issues = publishabilityIssues(db, space.id);
    assert.ok(
      issues.some((issue) => /photograph/i.test(issue)),
      `expected a photograph requirement, got: ${JSON.stringify(issues)}`,
    );

    assert.throws(
      () => publishSpace(db, { actor, spaceId: space.id }),
      (error) => {
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.equal(error.status, 422);
        assert.ok(Array.isArray(error.details.problems));
        assert.ok(error.details.problems.some((problem) => /photograph/i.test(problem)));
        return true;
      },
    );
    assert.equal(getSpace(db, space.id).status, SPACE_STATUS.DRAFT);
  });

  test('the gate passes once a photograph record exists', () => {
    const space = createSpace(db, { actor, payload: { ...MEETING_PAYLOAD, code: 'MR-02' } });
    assert.ok(publishabilityIssues(db, space.id).length > 0);

    addImageRecord(db, {
      actor,
      spaceId: space.id,
      storedName: fakeStoredName('a'),
      originalName: 'meeting-room.jpg',
      mimeType: 'image/jpeg',
      byteSize: 4096,
    });

    assert.deepEqual(publishabilityIssues(db, space.id), []);
  });

  test('publishing flips the status and stamps published_at, and is idempotent', () => {
    const space = createSpace(db, { actor, payload: { ...MEETING_PAYLOAD, code: 'MR-03' } });
    addImageRecord(db, {
      actor,
      spaceId: space.id,
      storedName: fakeStoredName('b', 'png'),
      originalName: 'meeting-room.png',
      mimeType: 'image/png',
      byteSize: 2048,
    });

    const published = publishSpace(db, { actor, spaceId: space.id });
    assert.equal(published.status, SPACE_STATUS.PUBLISHED);
    assert.ok(published.publishedAt > 0);

    const row = db.prepare('SELECT status, published_at FROM space WHERE id = ?').get(space.id);
    assert.equal(row.status, SPACE_STATUS.PUBLISHED);
    assert.equal(row.published_at, published.publishedAt);

    // A second publish must not change the record, nor move the timestamp.
    const again = publishSpace(db, { actor, spaceId: space.id });
    assert.equal(again.id, published.id);
    assert.equal(again.status, SPACE_STATUS.PUBLISHED);
    assert.equal(again.publishedAt, published.publishedAt);
  });

  test('archive then restore round-trips to draft and clears archived_at', () => {
    const space = createSpace(db, { actor, payload: { ...MEETING_PAYLOAD, code: 'MR-04' } });

    const archived = archiveSpace(db, { actor, spaceId: space.id, reason: 'Refurbishment' });
    assert.equal(archived.space.status, SPACE_STATUS.ARCHIVED);
    assert.equal(archived.upcomingOccupancy, 0);
    const archivedRow = db.prepare('SELECT status, archived_at FROM space WHERE id = ?').get(space.id);
    assert.equal(archivedRow.status, SPACE_STATUS.ARCHIVED);
    assert.ok(archivedRow.archived_at > 0, 'archived_at must be stamped');

    const restored = restoreSpace(db, { actor, spaceId: space.id });
    assert.equal(restored.status, SPACE_STATUS.DRAFT);
    assert.equal(restored.archivedAt, null);
    const restoredRow = db.prepare('SELECT status, archived_at FROM space WHERE id = ?').get(space.id);
    assert.equal(restoredRow.status, SPACE_STATUS.DRAFT);
    assert.equal(restoredRow.archived_at, null);
  });
});

/* ------------------------------------------------------------ payload rules */

describe('parseSpacePayload', () => {
  test('rejects a co-working space priced per hour and accepts per day', () => {
    assert.throws(
      () => parseSpacePayload({ ...COWORKING_PAYLOAD, pricing_unit: 'HOUR', rates: [] }, { partial: false }),
      (error) => {
        assert.equal(error.status, 422);
        assert.match(error.details.pricing_unit, /support/i);
        return true;
      },
    );

    const value = parseSpacePayload({ ...COWORKING_PAYLOAD, rates: [] }, { partial: false });
    assert.equal(value.pricing_unit, 'DAY');
  });

  test('rejects a closing time that is not after the opening time', () => {
    assert.throws(
      () => parseSpacePayload({ ...MEETING_PAYLOAD, open_time: '18:00', close_time: '08:00' }, { partial: false }),
      (error) => {
        assert.equal(error.status, 422);
        assert.match(error.details.close_time, /after opening time/i);
        return true;
      },
    );

    assert.throws(
      () => parseSpacePayload({ ...MEETING_PAYLOAD, open_time: '09:00', close_time: '09:00' }, { partial: false }),
      (error) => {
        assert.equal(error.status, 422);
        assert.match(error.details.close_time, /after opening time/i);
        return true;
      },
    );

    const value = parseSpacePayload({ ...MEETING_PAYLOAD, open_time: '09:00', close_time: '17:00' }, { partial: false });
    assert.equal(value.open_time, '09:00');
    assert.equal(value.close_time, '17:00');
  });
});

/* ----------------------------------------------------------- desk inventory */

describe('setDeskCount', () => {
  test('is refused while a desk holds active occupancy and succeeds once it is free', () => {
    const space = createSpace(db, { actor, payload: { ...COWORKING_PAYLOAD, code: 'CW-DESK' } });
    assert.equal(space.unitCount, 2);

    const customerId = insertCustomer(db);
    const dateKey = todayBusinessDate(Date.now() + 7 * 86400000);
    const startAt = businessLocalToEpoch(dateKey, '09:00');
    const endAt = startAt + 60 * 60 * 1000;

    // Two desks are booked, so both hold ACTIVE occupancy rows.
    const { reservation } = createReservation(db, {
      actor,
      spaceId: space.id,
      customerId,
      startAt,
      endAt,
      unitCount: 2,
      billingUnit: 'DAY',
      purpose: 'Desk count test',
    });
    assert.equal(reservation.unitCount, 2);

    assert.throws(
      () => setDeskCount(db, { actor, spaceId: space.id, deskCount: 1 }),
      (error) => {
        assert.equal(error.code, 'CONFLICT');
        assert.equal(error.status, 409);
        assert.match(error.message, /desk/i);
        return true;
      },
    );
    assert.equal(getSpace(db, space.id).unitCount, 2, 'the refusal must not change the inventory');

    cancelReservation(db, { actor, reservationId: reservation.id, reason: 'Releasing the desks for the test' });

    const reduced = setDeskCount(db, { actor, spaceId: space.id, deskCount: 1 });
    assert.equal(reduced.unitCount, 1);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM resource_unit WHERE space_id = ? AND is_active = 1').get(space.id).c,
      1,
    );
  });
});
