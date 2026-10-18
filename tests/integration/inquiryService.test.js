/**
 * Integration tests for src/server/services/inquiryService.js
 *
 * Runs against real SQLite files (temporary, migrated, WAL) so the delivery
 * contract, the unique reference sequence and the public/staff boundaries are
 * exercised for real - not mocked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestActor, withTempFileDb } from '../helpers/testDb.js';
import {
  convertInquiryToReservation,
  getInquiry,
  getInquiryByReference,
  inquiryStats,
  listInquiries,
  parseInquiryPayload,
  submitInquiry,
  updateInquiryStatus,
  withdrawInquiry,
} from '../../src/server/services/inquiryService.js';
import { businessDateKey, startOfBusinessDay } from '../../src/server/domain/time.js';

const DAY = 24 * 60 * 60 * 1000;

const MANAGED_ENV = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'SMTP_FROM',
  'NAGARO_ADMIN_NOTIFICATION_EMAIL', 'NAGARO_MAIL_TRANSPORT', 'NAGARO_BASE_URL',
];

async function withEnv(vars, fn) {
  const snapshot = {};
  for (const key of MANAGED_ENV) snapshot[key] = process.env[key];
  for (const key of MANAGED_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(vars ?? {})) {
    if (value !== undefined && value !== null) process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const key of MANAGED_ENV) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }
}

/* --------------------------------------------------------------- fixtures */

function insertSpace(db, {
  code = 'AURORA',
  name = 'Aurora Meeting Room',
  category = 'MEETING_ROOM',
  status = 'PUBLISHED',
  capacity = 12,
  deskCount = 0,
} = {}) {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO space
      (code, name, category, short_description, description, location, floor, capacity,
       status, currency, pricing_unit, min_duration_minutes, max_duration_minutes,
       buffer_minutes, open_time, close_time, amenities, attributes,
       created_at, updated_at, published_at)
    VALUES (?,?,?,?,?,?,?,?,?,'LKR','HOUR',30,NULL,0,'07:00','21:00','[]','{}',?,?,?)
  `).run(
    code, name, category, 'A short description', 'A longer description',
    'Trace Expert City', '2', capacity, status, now, now,
    status === 'PUBLISHED' ? now : null,
  );
  const spaceId = Number(info.lastInsertRowid);
  const kind = category === 'COWORKING' ? 'DESK' : 'EXCLUSIVE';
  const count = category === 'COWORKING' ? Math.max(1, deskCount) : 1;
  const unitStmt = db.prepare(`
    INSERT INTO resource_unit (space_id, code, label, kind, is_active, created_at)
    VALUES (?,?,?,?,1,?)
  `);
  for (let i = 1; i <= count; i += 1) {
    const unitCode = `${code}-U${String(i).padStart(2, '0')}`;
    unitStmt.run(spaceId, unitCode, `${name} ${i}`, kind, now);
  }
  return { spaceId, code, name, category };
}

function futureWindow(daysAhead = 3, startHour = 9, durationHours = 2) {
  const dayStart = startOfBusinessDay(Date.now() + daysAhead * DAY);
  return {
    startAt: dayStart + startHour * 3600 * 1000,
    endAt: dayStart + (startHour + durationHours) * 3600 * 1000,
  };
}

function basePayload(spaceCode, window, overrides = {}) {
  return {
    customer_name: 'Jane Visitor',
    email: 'jane@example.com',
    phone: '+94 911 000 000',
    organization: 'Example Ltd',
    space_code: spaceCode,
    requested_start_at: window.startAt,
    requested_end_at: window.endAt,
    attendees: 6,
    message: 'We would like a projector, please.',
    ...overrides,
  };
}

/** A mailer stand-in shaped exactly like the real module surface. */
function fakeMailer({ messageId = 'fake-1', failure = null } = {}) {
  return {
    sendMail: async () => {
      if (failure) throw failure;
      return { status: 'SENT', messageId, error: null };
    },
  };
}

function insertCustomer(db, { fullName = 'Jane Visitor', email = 'jane@example.com' } = {}) {
  const now = Date.now();
  const normalized = email.trim().toLowerCase();
  const info = db.prepare(`
    INSERT INTO customer (full_name, email, email_normalized, created_at, updated_at)
    VALUES (?,?,?,?,?)
  `).run(fullName, email, normalized, now, now);
  return Number(info.lastInsertRowid);
}

function insertReservation(db, {
  reference, spaceId, customerId, actorId, startAt, endAt, status = 'CONFIRMED',
}) {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO reservation
      (reference, space_id, customer_id, status, start_at, end_at, unit_count, attendees,
       billing_unit, billing_quantity, rate_cents, total_cents, currency,
       created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,1,6,'HOUR',2,1000,2000,'LKR',?,?,?)
  `).run(reference, spaceId, customerId, status, startAt, endAt, actorId, now, now);
  return Number(info.lastInsertRowid);
}

/* ------------------------------------------------------------------ tests */

test('a valid submission persists a row with a unique INQ reference and honest email status', async () => {
  await withEnv({}, async () => {
    await withTempFileDb(async (db) => {
      const { spaceId, code } = insertSpace(db);
      const window = futureWindow();

      const first = await submitInquiry(db, { payload: basePayload(code, window) });

      assert.match(first.inquiry.reference, /^INQ-\d{4}-\d{5}$/);
      assert.ok(first.inquiry.reference.endsWith('00001'), first.inquiry.reference);
      assert.equal(first.inquiry.status, 'NEW');
      assert.equal(first.inquiry.spaceId, spaceId);
      assert.equal(first.inquiry.spaceCode, code);
      assert.equal(first.inquiry.startAt, window.startAt);
      assert.equal(first.inquiry.endAt, window.endAt);

      // The email outcome is reported honestly: NOT_CONFIGURED is not success.
      assert.equal(first.email.status, 'NOT_CONFIGURED');
      assert.notEqual(first.email.status, 'SENT');
      assert.equal(first.inquiry.emailStatus, 'NOT_CONFIGURED');
      assert.notEqual(first.inquiry.emailStatus, 'SENT');
      assert.match(first.inquiry.emailError, /SMTP_HOST is unset/);
      assert.ok(first.inquiry.emailAttemptedAt, 'email_attempted_at was not recorded');

      // The row is committed, with only the token hash stored.
      const row = db.prepare('SELECT * FROM inquiry WHERE reference = ?').get(first.inquiry.reference);
      assert.ok(row, 'inquiry row was not persisted');
      assert.equal(row.status, 'NEW');
      assert.equal(row.email_status, 'NOT_CONFIGURED');
      assert.equal(row.space_id, spaceId);
      assert.equal(row.withdraw_token_hash.length, 64);
      assert.equal(typeof first.inquiry.withdrawToken, 'string');
      assert.notEqual(first.inquiry.withdrawToken, row.withdraw_token_hash, 'raw token must not be stored');
      assert.equal(first.inquiry.hasWithdrawToken, true);

      // Availability snapshot for staff, derived from live inventory.
      assert.deepEqual(first.inquiry.availability, {
        isAvailable: true,
        freeUnits: 1,
        totalUnits: 1,
        requestedUnits: 1,
        label: 'Available',
      });

      // Audit trail was written.
      assert.equal(
        db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'inquiry.received'").get().c,
        1,
      );

      // A second submission gets the next number - references are unique.
      const second = await submitInquiry(db, {
        payload: basePayload(code, window, { email: 'sam@example.com', customer_name: 'Sam Second' }),
      });
      assert.notEqual(second.inquiry.reference, first.inquiry.reference);
      assert.ok(second.inquiry.reference.endsWith('00002'), second.inquiry.reference);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inquiry').get().c, 2);

      // Lookup by reference is case-insensitive.
      const found = getInquiryByReference(db, first.inquiry.reference.toLowerCase());
      assert.equal(found.id, first.inquiry.id);

      // Coworking desks are reflected in the availability snapshot.
      const coworking = insertSpace(db, { code: 'FLEX', name: 'Flex Desks', category: 'COWORKING', deskCount: 5 });
      const desk = await submitInquiry(db, {
        payload: basePayload('FLEX', window, {
          email: 'desks@example.com',
          desk_quantity: 3,
          attendees: 3,
        }),
      });
      assert.equal(desk.inquiry.spaceId, coworking.spaceId);
      assert.equal(desk.inquiry.deskQuantity, 3);
      assert.deepEqual(desk.inquiry.availability, {
        isAvailable: true,
        freeUnits: 5,
        totalUnits: 5,
        requestedUnits: 3,
        label: '5 of 5 desks free',
      });
    });
  });
});

test('validation failures are reported per field and nothing is persisted', async () => {
  await withEnv({}, async () => {
    await withTempFileDb(async (db) => {
      const { code } = insertSpace(db);
      const draft = insertSpace(db, { code: 'DRAFTY', name: 'Draft Room', status: 'DRAFT' });
      const window = futureWindow();

      const expectField = async (payload, field) => {
        await assert.rejects(
          submitInquiry(db, { payload }),
          (error) => {
            assert.equal(error.code, 'VALIDATION_ERROR');
            assert.ok(error.details?.[field], `expected details.${field} (got ${JSON.stringify(error.details)})`);
            return true;
          },
        );
      };

      await expectField(basePayload(code, window, { customer_name: '   ' }), 'customer_name');
      await expectField(basePayload(code, window, { email: 'not-an-email' }), 'email');
      await expectField(basePayload(code, window, { space_code: 'NO-SUCH-SPACE' }), 'space_code');
      await expectField(
        { ...basePayload(code, window), space_code: undefined, space_id: draft.spaceId },
        'space_id',
      );
      await expectField(basePayload(code, window, { requested_end_at: window.startAt }), 'end_at');
      await expectField(basePayload(code, window, { attendees: -1 }), 'attendees');
      await expectField(basePayload(code, window, { desk_quantity: 0 }), 'desk_quantity');

      // Missing space entirely.
      await assert.rejects(
        submitInquiry(db, { payload: { ...basePayload(code, window), space_code: undefined } }),
        (error) => error.code === 'VALIDATION_ERROR' && Boolean(error.details.space_id),
      );

      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inquiry').get().c, 0, 'no row should exist');
    });
  });
});

test('a date + start_time/end_time window is normalised to the requested instants', async () => {
  await withEnv({}, async () => {
    await withTempFileDb(async (db) => {
      const { code } = insertSpace(db);
      const dateKey = businessDateKey(Date.now() + 5 * DAY);
      const { inquiry } = await submitInquiry(db, {
        payload: {
          customer_name: 'Ada Clock',
          email: 'ada@example.com',
          space_code: code,
          date: dateKey,
          start_time: '10:00',
          end_time: '12:30',
        },
      });
      assert.equal(businessDateKey(inquiry.startAt), dateKey);
      assert.equal(inquiry.endAt - inquiry.startAt, 150 * 60 * 1000);
      assert.equal(db.prepare('SELECT requested_start_at FROM inquiry WHERE id = ?').get(inquiry.id).requested_start_at, inquiry.startAt);
    });
  });
});

test('the email is attempted only after the row has been committed', async () => {
  await withEnv({}, async () => {
    await withTempFileDb(async (db) => {
      const { code } = insertSpace(db);
      const window = futureWindow();

      const observed = [];
      const mailer = {
        sendMail: async () => {
          observed.push(db.prepare('SELECT COUNT(*) AS c FROM inquiry').get().c);
          return { status: 'SENT', messageId: 'seam-id', error: null };
        },
      };

      const result = await submitInquiry(db, { payload: basePayload(code, window), mailer });

      assert.deepEqual(observed, [1, 1], 'both emails must see the committed row');
      assert.equal(result.email.status, 'SENT');
      assert.equal(result.inquiry.emailStatus, 'SENT');
      assert.equal(result.inquiry.emailMessageId, 'seam-id');
      assert.ok(result.inquiry.emailAttemptedAt);
    });
  });
});

test('a throwing mailer is recorded as FAILED and the committed row survives', async () => {
  await withEnv({ SMTP_PASS: 'hunter2-secret' }, async () => {
    await withTempFileDb(async (db) => {
      const { code } = insertSpace(db);
      const window = futureWindow();
      const actor = createTestActor(db);

      const mailer = fakeMailer({ failure: new Error('smtp exploded with password hunter2-secret') });
      const result = await submitInquiry(db, { payload: basePayload(code, window), mailer });

      assert.equal(result.email.status, 'FAILED');
      assert.ok(!result.email.error.includes('hunter2-secret'), 'password leaked into email error');
      assert.equal(result.inquiry.status, 'NEW');

      const row = db.prepare('SELECT * FROM inquiry WHERE id = ?').get(result.inquiry.id);
      assert.ok(row, 'inquiry must still be persisted after delivery failure');
      assert.equal(row.email_status, 'FAILED');
      assert.match(row.email_error, /smtp exploded/);

      // Failure does not stop staff work on the inquiry.
      const contacted = updateInquiryStatus(db, { actor, inquiryId: result.inquiry.id, status: 'CONTACTED' });
      assert.equal(contacted.status, 'CONTACTED');
    });
  });
});

test('withdrawal requires the matching token, is idempotent, and cannot be reopened', async () => {
  await withEnv({}, async () => {
    await withTempFileDb(async (db) => {
      const { code } = insertSpace(db);
      const window = futureWindow();
      const actor = createTestActor(db);
      const { inquiry } = await submitInquiry(db, { payload: basePayload(code, window) });

      await assert.rejects(
        async () => withdrawInquiry(db, { reference: inquiry.reference, token: 'not-the-token' }),
        (error) => error.code === 'NOT_FOUND',
      );
      assert.equal(getInquiry(db, inquiry.id).status, 'NEW', 'wrong token must not change status');

      const withdrawn = withdrawInquiry(db, {
        reference: inquiry.reference.toLowerCase(),
        token: inquiry.withdrawToken,
      });
      assert.equal(withdrawn.status, 'WITHDRAWN');

      const again = withdrawInquiry(db, { reference: inquiry.reference, token: inquiry.withdrawToken });
      assert.equal(again.status, 'WITHDRAWN');
      assert.equal(
        db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'inquiry.withdrawn'").get().c,
        1,
        'repeated withdrawal must not write a second audit entry',
      );

      assert.throws(
        () => updateInquiryStatus(db, { actor, inquiryId: inquiry.id, status: 'NEW' }),
        (error) => error.code === 'CONFLICT',
      );
    });
  });
});

test('convertInquiryToReservation links an existing reservation and flips the status', async () => {
  await withEnv({}, async () => {
    await withTempFileDb(async (db) => {
      const { spaceId, code } = insertSpace(db);
      const window = futureWindow();
      const actor = createTestActor(db);
      const { inquiry } = await submitInquiry(db, { payload: basePayload(code, window) });

      const janeId = insertCustomer(db, { email: 'jane@example.com' });
      const reservationId = insertReservation(db, {
        reference: 'NG-2026-00001',
        spaceId,
        customerId: janeId,
        actorId: actor.id,
        startAt: window.startAt,
        endAt: window.endAt,
      });

      // A reservation for a different customer cannot be linked.
      const otherId = insertCustomer(db, { fullName: 'Other Person', email: 'other@example.com' });
      const wrongReservationId = insertReservation(db, {
        reference: 'NG-2026-00002',
        spaceId,
        customerId: otherId,
        actorId: actor.id,
        startAt: window.startAt,
        endAt: window.endAt,
      });
      assert.throws(
        () => convertInquiryToReservation(db, { actor, inquiryId: inquiry.id, reservationId: wrongReservationId }),
        (error) => error.code === 'CONFLICT',
      );

      const converted = convertInquiryToReservation(db, { actor, inquiryId: inquiry.id, reservationId });
      assert.equal(converted.status, 'CONVERTED');
      assert.equal(converted.convertedReservationId, reservationId);
      assert.equal(converted.convertedReservationReference, 'NG-2026-00001');
      assert.equal(converted.convertedReservationStatus, 'CONFIRMED');

      // Repeating the same link is idempotent.
      const repeated = convertInquiryToReservation(db, { actor, inquiryId: inquiry.id, reservationId });
      assert.equal(repeated.status, 'CONVERTED');
      assert.equal(repeated.convertedReservationId, reservationId);

      // An unknown reservation is a 404.
      assert.throws(
        () => convertInquiryToReservation(db, { actor, inquiryId: inquiry.id, reservationId: 9999 }),
        (error) => error.code === 'NOT_FOUND',
      );

      assert.equal(
        db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'inquiry.status_changed'").get().c,
        1,
      );
    });
  });
});

test('inquiryStats counts statuses and undelivered email honestly', async () => {
  await withEnv({}, async () => {
    await withTempFileDb(async (db) => {
      const { code } = insertSpace(db);
      const window = futureWindow();
      const actor = createTestActor(db);

      const first = await submitInquiry(db, { payload: basePayload(code, window, { email: 'a@example.com' }) });
      const second = await submitInquiry(db, { payload: basePayload(code, window, { email: 'b@example.com' }) });
      const third = await submitInquiry(db, { payload: basePayload(code, window, { email: 'c@example.com' }) });

      updateInquiryStatus(db, { actor, inquiryId: second.inquiry.id, status: 'CONTACTED' });
      withdrawInquiry(db, { reference: third.inquiry.reference, token: third.inquiry.withdrawToken });

      assert.deepEqual(inquiryStats(db), {
        new: 1,
        contacted: 1,
        converted: 0,
        closed: 0,
        withdrawn: 1,
        total: 3,
        emailNotDelivered: 3,
      });

      // listInquiries filters.
      assert.equal(listInquiries(db, { status: 'NEW' }).total, 1);
      assert.equal(listInquiries(db, { status: 'ALL' }).total, 3);
      assert.equal(listInquiries(db, { search: first.inquiry.reference.toLowerCase() }).total, 1);
      assert.equal(listInquiries(db, { search: 'b@example.com' }).total, 1);
      assert.equal(listInquiries(db, { search: 'no-such-thing' }).total, 0);

      const dateKey = businessDateKey(window.startAt);
      assert.equal(listInquiries(db, { fromDate: dateKey, toDate: dateKey }).total, 3);
      assert.equal(listInquiries(db, { fromDate: businessDateKey(window.startAt + 30 * DAY) }).total, 0);

      const sorted = listInquiries(db, { sort: 'start' });
      assert.equal(sorted.items[0].id, first.inquiry.id);
    });
  });
});

test('public submissions are rate limited per IP without creating extra rows', async () => {
  await withEnv({}, async () => {
    await withTempFileDb(async (db) => {
      const { code } = insertSpace(db);
      const window = futureWindow();
      const ip = '198.51.100.7';

      for (let i = 0; i < 8; i += 1) {
        await submitInquiry(db, {
          payload: basePayload(code, window, { email: `visitor${i}@example.com` }),
          ip,
        });
      }
      await assert.rejects(
        submitInquiry(db, {
          payload: basePayload(code, window, { email: 'visitor8@example.com' }),
          ip,
        }),
        (error) => error.code === 'RATE_LIMITED',
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inquiry').get().c, 8);

      // A different IP is unaffected.
      await submitInquiry(db, {
        payload: basePayload(code, window, { email: 'someone-else@example.com' }),
        ip: '203.0.113.9',
      });
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inquiry').get().c, 9);
    });
  });
});

test('parseInquiryPayload normalises the public form and reports every missing field', () => {
  const parsed = parseInquiryPayload({
    customer_name: '  Jane Visitor ',
    email: ' Jane@Example.COM ',
    phone: '+94 911 000 000',
    space_code: 'aurora',
    requested_start_at: Date.now() + DAY,
    requested_end_at: Date.now() + DAY + 3600 * 1000,
  });
  assert.equal(parsed.customerName, 'Jane Visitor');
  assert.equal(parsed.emailNormalized, 'jane@example.com');
  assert.equal(parsed.spaceCode, 'aurora');

  assert.throws(
    () => parseInquiryPayload({}),
    (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.ok(error.details.customer_name);
      assert.ok(error.details.email);
      assert.ok(error.details.start_at);
      assert.ok(error.details.space_id);
      return true;
    },
  );
});
