/**
 * PayHere checkout + notification — signature rules, immutable amount
 * snapshots, idempotency and money-safety edge cases.
 *
 * The happy path (valid exact callback confirms exactly once) lives in
 * tests/integration/bookingRequestWorkflow.test.js. This file covers what
 * goes wrong around it: bad signatures, unknown orders, mismatched amounts,
 * expired holds, cancelled requests and fee-policy arithmetic.
 *
 * No real gateway is contacted and no merchant credentials are required;
 * live sandbox verification is tracked separately in PUBLIC_FRONTEND_REPORT.md.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createTestActor, createTestDb } from '../helpers/testDb.js';
import { parseBookingWindow } from '../../src/server/domain/validation.js';
import {
  approveBookingRequest,
  cancelBookingRequest,
  createBookingRequest,
  createPayHereCheckout,
  expireBookingHolds,
  processPayHereNotification,
  updateBookingFeePolicy,
} from '../../src/server/services/bookingRequestService.js';

const CFG = { merchantId: '1210000', merchantSecret: 'sandbox-secret', sandbox: true, baseUrl: 'https://example.test' };
const T0 = Date.UTC(2030, 0, 1);

function md5(value) {
  return createHash('md5').update(String(value)).digest('hex').toUpperCase();
}

function payHereSig({ merchantId, orderId, amount, currency, statusCode, secret }) {
  return md5(`${merchantId}${orderId}${amount}${currency}${statusCode}${md5(secret)}`);
}

function seedSpace(db) {
  const now = Date.now();
  const inserted = db.prepare(`INSERT INTO space
    (code,name,category,short_description,capacity,status,currency,pricing_unit,min_duration_minutes,max_duration_minutes,buffer_minutes,open_time,close_time,amenities,attributes,created_at,updated_at,published_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('PAY-01', 'Payment Room', 'MEETING_ROOM', 'A test venue', 20, 'PUBLISHED', 'LKR', 'HOUR', 60, 480, 0, '08:00', '18:00', '[]', '{}', now, now, now);
  const id = Number(inserted.lastInsertRowid);
  db.prepare('INSERT INTO space_rate (space_id,unit,amount_cents,is_default) VALUES (?,?,?,1)').run(id, 'HOUR', 250000);
  db.prepare('INSERT INTO resource_unit (space_id,code,label,kind,is_active,created_at) VALUES (?,?,?,?,1,?)').run(id, 'PAY-ROOM-A', 'Payment Room', 'EXCLUSIVE', now);
  return id;
}

function requestInput(spaceId, key, date = '2030-08-14') {
  const window = parseBookingWindow({ date, start_time: '09:00', end_time: '11:00' });
  return {
    spaceId,
    startAt: window.startAt,
    endAt: window.endAt,
    unitCount: 1,
    attendees: 8,
    purpose: 'Design workshop',
    idempotencyKey: key,
    customer: { fullName: 'Asha Perera', email: 'asha@example.com', phone: '+94 77 123 4567' },
  };
}

/** Request -> approve with a fixed fee -> checkout, in one go. */
function approvedWithCheckout(db, { feeCents = 100000, now = T0 } = {}) {
  const actor = createTestActor(db);
  const spaceId = seedSpace(db);
  updateBookingFeePolicy(db, { actor, mode: feeCents ? 'FIXED' : 'DISABLED', fixedCents: feeCents, paymentWindowMinutes: 120, now });
  const created = createBookingRequest(db, requestInput(spaceId, 'pay:one'));
  const id = Number(db.prepare('SELECT id FROM booking_request').get().id);
  approveBookingRequest(db, { actor, requestId: id, now });
  const checkout = createPayHereCheckout(db, { reference: created.request.reference, token: created.manageToken, config: CFG, now: now + 1000 });
  return { actor, spaceId, created, id, checkout };
}

test('checkout signs exactly the documented PayHere parameters', () => {
  const db = createTestDb();
  const { checkout } = approvedWithCheckout(db);
  const f = checkout.fields;

  assert.equal(checkout.action, 'https://sandbox.payhere.lk/pay/checkout');
  assert.equal(f.merchant_id, CFG.merchantId);
  assert.equal(f.currency, 'LKR');
  assert.match(f.amount, /^\d+\.\d{2}$/, 'PayHere requires two decimal places');
  assert.equal(f.amount, '1000.00');
  assert.equal(f.notify_url, 'https://example.test/api/public/payments/payhere/notify');
  assert.ok(f.return_url.includes('/book/manage?ref='));
  assert.equal(f.hash, md5(`${f.merchant_id}${f.order_id}${f.amount}${f.currency}${md5(CFG.merchantSecret)}`));
  assert.equal(f.custom_1, db.prepare('SELECT reference FROM booking_request').get().reference);
  db.close();
});

test('each payment attempt gets a fresh order id and an immutable amount snapshot', () => {
  const db = createTestDb();
  const { created, checkout } = approvedWithCheckout(db);
  const second = createPayHereCheckout(db, { reference: created.request.reference, token: created.manageToken, config: CFG, now: T0 + 5000 });

  assert.notEqual(checkout.fields.order_id, second.fields.order_id);
  assert.equal(checkout.fields.amount, second.fields.amount, 'the amount is snapshotted from the obligation, never re-derived');
  const attempts = db.prepare('SELECT * FROM payment_attempt ORDER BY id').all();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].amount_cents, attempts[1].amount_cents);
  assert.equal(attempts[0].status, 'CREATED');
  db.close();
});

test('checkout refuses without credentials, before approval, or with no fee due', () => {
  const db = createTestDb();
  const actor = createTestActor(db);
  const spaceId = seedSpace(db);
  const created = createBookingRequest(db, requestInput(spaceId, 'pay:gate'));

  assert.throws(
    () => createPayHereCheckout(db, { reference: created.request.reference, token: created.manageToken, config: CFG, now: T0 }),
    (e) => e?.status === 409,
    'a request that is not approved cannot be paid',
  );

  updateBookingFeePolicy(db, { actor, mode: 'DISABLED', paymentWindowMinutes: 120, now: T0 });
  const id = Number(db.prepare('SELECT id FROM booking_request').get().id);
  const approved = approveBookingRequest(db, { actor, requestId: id, now: T0 });
  assert.equal(approved.status, 'CONFIRMED', 'a zero fee confirms immediately — no payment obligation exists');
  assert.equal(approved.paymentStatus, 'NOT_REQUIRED');
  assert.throws(
    () => createPayHereCheckout(db, { reference: created.request.reference, token: created.manageToken, config: CFG, now: T0 + 1000 }),
    (e) => e?.status === 409,
  );

  updateBookingFeePolicy(db, { actor, mode: 'FIXED', fixedCents: 50000, paymentWindowMinutes: 120, now: T0 });
  const other = createBookingRequest(db, requestInput(spaceId, 'pay:gate-2', '2030-08-15'));
  const otherId = Number(db.prepare('SELECT id FROM booking_request WHERE id <> ?').get(id).id);
  approveBookingRequest(db, { actor, requestId: otherId, now: T0 });
  assert.throws(
    () => createPayHereCheckout(db, { reference: other.request.reference, token: other.manageToken, config: { ...CFG, merchantSecret: '' }, now: T0 + 1000 }),
    (e) => e?.status === 409,
    'unconfigured deployments never hand out checkout parameters',
  );
  db.close();
});

test('a valid signature over a mismatched amount never confirms and flags manual review', () => {
  const db = createTestDb();
  const { created, checkout } = approvedWithCheckout(db);
  const f = checkout.fields;

  const inflated = { ...f, payhere_amount: '9999.99' };
  const sig = payHereSig({ merchantId: f.merchant_id, orderId: f.order_id, amount: inflated.payhere_amount, currency: f.currency, statusCode: '2', secret: CFG.merchantSecret });
  const result = processPayHereNotification(db, {
    merchant_id: f.merchant_id,
    order_id: f.order_id,
    payment_id: 'PAY-TOO-MUCH',
    payhere_amount: inflated.payhere_amount,
    payhere_currency: f.currency,
    status_code: '2',
    method: 'VISA',
    status_message: 'Success',
    md5sig: sig,
  }, CFG, T0 + 2000);

  assert.equal(result.confirmed ?? false, false, 'money that does not match the snapshot must never confirm a booking');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM reservation').get().c, 0);
  const request = db.prepare('SELECT * FROM booking_request').get();
  assert.equal(request.status, 'PAYMENT_REVIEW_REQUIRED');
  assert.equal(request.payment_status, 'REVIEW_REQUIRED');
  const attempt = db.prepare('SELECT * FROM payment_attempt').get();
  assert.equal(attempt.status, 'REVIEW_REQUIRED');
  assert.equal(attempt.provider_payment_id, 'PAY-TOO-MUCH', 'the charge evidence is preserved');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM payment_event').get().c, 1, 'the notification is recorded verbatim for reconciliation');
  db.close();
});

test('unknown orders and forged signatures are refused but never erased', () => {
  const db = createTestDb();
  approvedWithCheckout(db);

  const forged = processPayHereNotification(db, {
    merchant_id: CFG.merchantId,
    order_id: 'REQ-UNKNOWN-1',
    payment_id: 'PAY-X',
    payhere_amount: '1000.00',
    payhere_currency: 'LKR',
    status_code: '2',
    md5sig: md5('whatever'),
  }, CFG, T0 + 2000);
  assert.equal(forged.accepted, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM payment_event WHERE signature_valid=0').get().c, 1);

  const wrongMerchant = processPayHereNotification(db, {
    merchant_id: '9999999',
    order_id: db.prepare('SELECT order_id FROM payment_attempt').get().order_id,
    payment_id: 'PAY-Y',
    payhere_amount: '1000.00',
    payhere_currency: 'LKR',
    status_code: '2',
    md5sig: md5('other-merchant'),
  }, CFG, T0 + 3000);
  assert.equal(wrongMerchant.accepted, false, 'another merchant cannot confirm our booking');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM reservation').get().c, 0);
  db.close();
});

test('non-success status codes move payment state without touching the reservation', () => {
  const db = createTestDb();
  const { checkout } = approvedWithCheckout(db);
  const f = checkout.fields;

  for (const [statusCode, attemptStatus, paymentStatus] of [['0', 'PENDING', 'PENDING'], ['-1', 'CANCELLED', 'FAILED']]) {
    const sig = payHereSig({ merchantId: f.merchant_id, orderId: f.order_id, amount: f.amount, currency: f.currency, statusCode, secret: CFG.merchantSecret });
    const result = processPayHereNotification(db, {
      merchant_id: f.merchant_id,
      order_id: f.order_id,
      payment_id: `PAY-${statusCode}`,
      payhere_amount: f.amount,
      payhere_currency: f.currency,
      status_code: statusCode,
      md5sig: sig,
    }, CFG, T0 + 2000);
    assert.equal(result.accepted, true);
    const attempt = db.prepare('SELECT * FROM payment_attempt').get();
    assert.equal(attempt.status, attemptStatus);
    const request = db.prepare('SELECT * FROM booking_request').get();
    assert.equal(request.payment_status, paymentStatus);
    assert.equal(request.status, 'APPROVED_AWAITING_PAYMENT', 'a failed or pending payment never confirms and never cancels by itself');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM reservation').get().c, 0);
  }
  db.close();
});

test('payment completed after the hold expired is money kept, not a silent confirm', () => {
  const db = createTestDb();
  const { created, checkout, id } = approvedWithCheckout(db);
  const f = checkout.fields;

  const released = expireBookingHolds(db, T0 + 3 * 60 * 60_000);
  assert.equal(released, 1);

  const sig = payHereSig({ merchantId: f.merchant_id, orderId: f.order_id, amount: f.amount, currency: f.currency, statusCode: '2', secret: CFG.merchantSecret });
  const result = processPayHereNotification(db, {
    merchant_id: f.merchant_id,
    order_id: f.order_id,
    payment_id: 'PAY-LATE',
    payhere_amount: f.amount,
    payhere_currency: f.currency,
    status_code: '2',
    method: 'VISA',
    md5sig: sig,
  }, CFG, T0 + 3 * 60 * 60_000 + 1000);

  assert.equal(result.confirmed ?? false, false);
  assert.equal(result.reviewRequired, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM reservation').get().c, 0);
  const request = db.prepare('SELECT * FROM booking_request').get();
  assert.equal(request.status, 'PAYMENT_REVIEW_REQUIRED');
  assert.equal(request.payment_status, 'REVIEW_REQUIRED');
  assert.equal(db.prepare('SELECT provider_payment_id FROM payment_attempt').get().provider_payment_id, 'PAY-LATE');
  db.close();
});

test('a cancelled request can never be confirmed by a late callback', () => {
  const db = createTestDb();
  const { created, checkout } = approvedWithCheckout(db);
  const f = checkout.fields;

  cancelBookingRequest(db, { reference: created.request.reference, token: created.manageToken, now: T0 + 2000 });

  const sig = payHereSig({ merchantId: f.merchant_id, orderId: f.order_id, amount: f.amount, currency: f.currency, statusCode: '2', secret: CFG.merchantSecret });
  const result = processPayHereNotification(db, {
    merchant_id: f.merchant_id,
    order_id: f.order_id,
    payment_id: 'PAY-AFTER-CANCEL',
    payhere_amount: f.amount,
    payhere_currency: f.currency,
    status_code: '2',
    md5sig: sig,
  }, CFG, T0 + 3000);

  assert.equal(result.confirmed ?? false, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM reservation').get().c, 0);
  const request = db.prepare('SELECT * FROM booking_request').get();
  assert.equal(request.status, 'PAYMENT_REVIEW_REQUIRED', 'money that arrived after cancellation is escalated, never applied');
  db.close();
});

test('fee policy arithmetic is snapshotted at approval, not recomputed later', () => {
  const db = createTestDb();
  const actor = createTestActor(db);
  const spaceId = seedSpace(db);

  updateBookingFeePolicy(db, { actor, mode: 'PERCENTAGE', percentageBps: 1000, paymentWindowMinutes: 30, now: T0 });
  assert.throws(() => updateBookingFeePolicy(db, { actor, mode: 'PERCENTAGE', percentageBps: 20000, now: T0 }), (e) => e?.status === 422);
  assert.throws(() => updateBookingFeePolicy(db, { actor, mode: 'NONSENSE', now: T0 }), (e) => e?.status === 422);
  assert.throws(() => updateBookingFeePolicy(db, { actor, mode: 'FIXED', fixedCents: -1, now: T0 }), (e) => e?.status === 422);
  assert.throws(() => updateBookingFeePolicy(db, { actor: { id: 999, role: 'STAFF' }, mode: 'FIXED', fixedCents: 100, now: T0 }), (e) => e?.status === 422, 'only administrators configure fees');
  const zeroFee = updateBookingFeePolicy(db, { actor, mode: 'FIXED', fixedCents: 0, now: T0 });
  assert.equal(zeroFee.fixedCents, 0, 'a zero fee is accepted as the safe no-fee state');
  updateBookingFeePolicy(db, { actor, mode: 'PERCENTAGE', percentageBps: 1000, paymentWindowMinutes: 30, now: T0 });

  const created = createBookingRequest(db, requestInput(spaceId, 'fee:one'));
  const id = Number(db.prepare('SELECT id FROM booking_request').get().id);
  const approved = approveBookingRequest(db, { actor, requestId: id, now: T0 });
  const obligation = db.prepare('SELECT * FROM payment_obligation').get();

  assert.equal(obligation.policy_mode, 'PERCENTAGE');
  assert.equal(obligation.policy_value, 1000);
  assert.equal(obligation.venue_total_cents, 500000, 'two hours at LKR 2,500 per hour');
  assert.equal(obligation.booking_fee_cents, 50000, '10% of the LKR 5,000 venue total');
  assert.equal(obligation.remaining_balance_cents, 450000);
  assert.equal(approved.payment.bookingFeeCents, 50000);

  updateBookingFeePolicy(db, { actor, mode: 'FIXED', fixedCents: 999999, paymentWindowMinutes: 30, now: T0 + 1000 });
  const stillSnapshotted = db.prepare('SELECT * FROM payment_obligation').get();
  assert.equal(stillSnapshotted.booking_fee_cents, 50000, 'changing policy must not rewrite history');
  assert.equal(approved.holdExpiresAt, T0 + 30 * 60_000, 'the payment window is also snapshotted');
  db.close();
});
