/**
 * Smart booking access: links, door commands, the mandatory automatic-close
 * rule, paid extensions and staff assistance.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeTestDb, createTestActor, createTestDb } from '../helpers/testDb.js';
import {
  hashAccessToken, issueAccessLink, resolveAccess, revokeAccessLink, revokeDoorAccess,
} from '../../src/server/services/accessLinkService.js';
import { updateSpaceAccessConfig, percentToBps, moneyToCents } from '../../src/server/services/accessPolicyService.js';
import {
  getDoorSnapshot, requestCustomerDoorCommand, runDoorQueue, executeDoorCommand,
} from '../../src/server/services/doorService.js';
import { setDoorDriverForTests } from '../../src/server/services/doorDrivers.js';
import {
  extensionPrice, processExtensionNotification, quoteExtension, startExtension, grantExtension,
} from '../../src/server/services/extensionService.js';
import { buildAccessState } from '../../src/server/services/accessStateService.js';
import { requestAssistance } from '../../src/server/services/assistanceService.js';
import { cancelReservation } from '../../src/server/services/bookingService.js';
import { normalizeSmsNumber } from '../../src/server/sms/smsSender.js';

const MIN = 60_000;
const PAYHERE = { merchantId: '1211149', merchantSecret: 'test-secret', sandbox: true, baseUrl: 'https://example.test' };
const md5 = (s) => createHash('md5').update(s).digest('hex').toUpperCase();

let db;
let actor;
let commands;
let nextResult;

beforeEach(() => {
  process.env.NAGARO_DOOR_SIMULATOR = '1';
  db = createTestDb();
  actor = createTestActor(db, { role: 'SUPER_ADMIN' });
  commands = [];
  nextResult = null;
  setDoorDriverForTests(async (command) => {
    commands.push({ action: command.action, autoLockAt: command.autoLockAt });
    if (nextResult) return nextResult(command);
    return { ok: true, state: command.action === 'OPEN' ? 'UNLOCKED' : 'LOCKED' };
  });
});

afterEach(() => {
  setDoorDriverForTests(null);
  closeTestDb(db);
});

function makeRoom(code = 'MR01', hourlyCents = 100000) {
  const now = Date.now();
  const id = Number(db.prepare(`INSERT INTO space (code,name,category,capacity,status,currency,pricing_unit,min_duration_minutes,open_time,close_time,created_at,updated_at)
    VALUES (?,?,'MEETING_ROOM',8,'PUBLISHED','LKR','HOUR',15,'00:00','23:59',?,?)`).run(code, `Room ${code}`, now, now).lastInsertRowid);
  db.prepare('INSERT INTO space_rate (space_id,unit,amount_cents,is_default) VALUES (?,?,?,1)').run(id, 'HOUR', hourlyCents);
  const unit = Number(db.prepare("INSERT INTO resource_unit (space_id,code,label,kind,is_active,created_at) VALUES (?,?,?,'EXCLUSIVE',1,?)").run(id, `${code}-1`, code, now).lastInsertRowid);
  updateSpaceAccessConfig(db, { actor, spaceId: id, body: { driver: 'SIMULATED', door_enabled: '1', confirms_state: '1' } });
  return { id, unit };
}

let seq = 0;
function book(room, startAt, endAt) {
  seq += 1;
  const now = Date.now();
  const customer = Number(db.prepare('INSERT INTO customer (full_name,email,email_normalized,phone,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('Test Customer', `c${seq}@x.test`, `c${seq}@x.test`, '0771234567', now, now).lastInsertRowid);
  const id = Number(db.prepare(`INSERT INTO reservation (reference,space_id,customer_id,status,start_at,end_at,unit_count,billing_unit,billing_quantity,rate_cents,total_cents,currency,created_by,created_at,updated_at)
    VALUES (?,?,?,'CONFIRMED',?,?,1,'HOUR',1,100000,100000,'LKR',?,?,?)`).run(`BK-T${seq}`, room.id, customer, startAt, endAt, actor.id, now, now).lastInsertRowid);
  db.prepare("INSERT INTO occupancy (resource_unit_id,space_id,start_at,end_at,status,source,reservation_id,created_at) VALUES (?,?,?,?,'ACTIVE','RESERVATION',?,?)")
    .run(room.unit, room.id, startAt, endAt, id, now);
  const { token } = issueAccessLink(db, { reservationId: id, now });
  return { id, token };
}

function notify(orderId, { amount = '300.00', status = '2', paymentId = 'P1', secret = PAYHERE.merchantSecret } = {}) {
  const sig = md5(`${PAYHERE.merchantId}${orderId}${amount}LKR${status}${md5(secret)}`);
  return processExtensionNotification(db, {
    merchant_id: PAYHERE.merchantId, order_id: orderId, payment_id: paymentId, payhere_amount: amount,
    payhere_currency: 'LKR', status_code: status, md5sig: sig,
  }, PAYHERE);
}

/* ------------------------------------------------------------------ links */

test('access tokens are random, stored only as a hash, and resolve', () => {
  const room = makeRoom();
  const now = Date.now();
  const { id, token } = book(room, now - 30 * MIN, now + 30 * MIN);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const row = db.prepare('SELECT token_hash FROM booking_access_link WHERE reservation_id = ?').get(id);
  assert.equal(row.token_hash, hashAccessToken(token));
  assert.notEqual(row.token_hash, token);
  assert.equal(resolveAccess(db, token).reservation.id, id);
  assert.throws(() => resolveAccess(db, `${token.slice(0, -1)}A`), { code: 'ACCESS_LINK_INVALID' });
});

test('the link survives the end of the booking but a revoked link does not', () => {
  const room = makeRoom();
  const now = Date.now();
  const { id, token } = book(room, now - 120 * MIN, now - 5 * MIN);
  const access = resolveAccess(db, token);
  assert.equal(buildAccessState(db, { access, payHere: PAYHERE }).state, 'ENDED');
  revokeAccessLink(db, { actor, reservationId: id });
  assert.throws(() => resolveAccess(db, token), { code: 'ACCESS_LINK_INVALID' });
});

test('the link stops resolving after the retention period', () => {
  const room = makeRoom();
  const now = Date.now();
  const { token } = book(room, now - 3 * 24 * 60 * MIN, now - 2 * 24 * 60 * MIN);
  assert.throws(() => resolveAccess(db, token), { code: 'ACCESS_LINK_INVALID' });
});

/* ---------------------------------------------------- automatic-close rule */

test('an unlock is capped at the booking end (3:40 + 30 min on a 4:00 booking closes at 4:00)', async () => {
  const room = makeRoom();
  const now = Date.now();
  const end = now + 20 * MIN;
  const { token } = book(room, now - 100 * MIN, end);
  const { command } = requestCustomerDoorCommand(db, { access: resolveAccess(db, token), action: 'OPEN', minutes: 30, idempotencyKey: 'key-open-0001', now });
  assert.equal(command.autoLockAt, end);
  await executeDoorCommand(db, command.id, { now });
  assert.equal(getDoorSnapshot(db, room.id).autoLockAt, end);
  assert.equal(commands[0].autoLockAt, end, 'the controller is told the deadline too');
});

test('"until booking ends" still gets a mandatory deadline', () => {
  const room = makeRoom();
  const now = Date.now();
  const end = now + 90 * MIN;
  const { token } = book(room, now - 30 * MIN, end);
  const { command } = requestCustomerDoorCommand(db, { access: resolveAccess(db, token), action: 'OPEN', minutes: 'END', idempotencyKey: 'key-open-0002', now });
  assert.equal(command.autoLockAt, end);
  assert.equal(getDoorSnapshot(db, room.id).autoLockAt, end);
});

test('the scheduler sends exactly one CLOSE when the deadline passes, even when run twice', async () => {
  const room = makeRoom();
  const now = Date.now();
  const { token } = book(room, now - 30 * MIN, now + 60 * MIN);
  const { command } = requestCustomerDoorCommand(db, { access: resolveAccess(db, token), action: 'OPEN', minutes: 5, idempotencyKey: 'key-open-0003', now });
  await executeDoorCommand(db, command.id, { now });
  const later = now + 6 * MIN;
  await runDoorQueue(db, { now: later });
  await runDoorQueue(db, { now: later + 1000 });
  assert.deepEqual(commands.map((c) => c.action), ['OPEN', 'CLOSE']);
  const snap = getDoorSnapshot(db, room.id);
  assert.equal(snap.reportedState, 'LOCKED');
  assert.equal(snap.autoLockAt, null);
});

test('a failed automatic CLOSE is retried, keeps the deadline and alerts staff when it gives up', async () => {
  const room = makeRoom();
  const now = Date.now();
  const { token } = book(room, now - 30 * MIN, now + 60 * MIN);
  const { command } = requestCustomerDoorCommand(db, { access: resolveAccess(db, token), action: 'OPEN', minutes: 5, idempotencyKey: 'key-open-0004', now });
  await executeDoorCommand(db, command.id, { now });
  nextResult = () => ({ ok: false, offline: true, error: 'down' });
  let t = now + 6 * MIN;
  for (let i = 0; i < 10; i += 1) { await runDoorQueue(db, { now: t }); t += 3 * MIN; }
  const closes = commands.filter((c) => c.action === 'CLOSE').length;
  assert.ok(closes >= 6, `retried ${closes} times`);
  assert.notEqual(getDoorSnapshot(db, room.id).autoLockAt, null, 'the deadline stays until a lock is confirmed');
  const alerts = db.prepare("SELECT COUNT(*) AS c FROM notification WHERE type = 'DOOR_ALERT'").get().c;
  assert.ok(Number(alerts) >= 1);
});

test('door commands are refused outside the booking, after revocation and after cancellation', () => {
  const room = makeRoom();
  const now = Date.now();
  const ended = book(room, now - 90 * MIN, now - 1 * MIN);
  assert.throws(() => requestCustomerDoorCommand(db, { access: resolveAccess(db, ended.token), action: 'OPEN', minutes: 5, idempotencyKey: 'key-open-0005', now }), { code: 'ACCESS_ENDED' });
  const upcoming = book(room, now + 60 * MIN, now + 120 * MIN);
  assert.throws(() => requestCustomerDoorCommand(db, { access: resolveAccess(db, upcoming.token), action: 'OPEN', minutes: 5, idempotencyKey: 'key-open-0006', now }), { code: 'ACCESS_NOT_STARTED' });
  const active = book(makeRoom('MR09'), now - 10 * MIN, now + 60 * MIN);
  revokeDoorAccess(db, { actor, reservationId: active.id });
  assert.throws(() => requestCustomerDoorCommand(db, { access: resolveAccess(db, active.token), action: 'CLOSE', idempotencyKey: 'key-close-0007', now }), { code: 'ACCESS_REVOKED' });
});

test('a repeated request with the same idempotency key creates one command', () => {
  const room = makeRoom();
  const now = Date.now();
  const { token } = book(room, now - 10 * MIN, now + 60 * MIN);
  const access = resolveAccess(db, token);
  const a = requestCustomerDoorCommand(db, { access, action: 'OPEN', minutes: 5, idempotencyKey: 'same-key-0001', now });
  const b = requestCustomerDoorCommand(db, { access, action: 'OPEN', minutes: 5, idempotencyKey: 'same-key-0001', now: now + 500 });
  assert.equal(a.command.id, b.command.id);
  assert.equal(b.idempotent, true);
});

test('cancelling a booking that left the door open queues a lock', async () => {
  const room = makeRoom();
  const now = Date.now();
  const { id, token } = book(room, now - 10 * MIN, now + 60 * MIN);
  const { command } = requestCustomerDoorCommand(db, { access: resolveAccess(db, token), action: 'OPEN', minutes: 30, idempotencyKey: 'key-open-0008', now });
  await executeDoorCommand(db, command.id, { now });
  // The real cancellation entry point, which must trigger the lock itself.
  cancelReservation(db, { actor, reservationId: id, reason: 'Customer left early' });
  await runDoorQueue(db, { now: Date.now() + 1000 });
  assert.equal(commands.at(-1).action, 'CLOSE');
  assert.equal(getDoorSnapshot(db, room.id).reportedState, 'LOCKED');
});

test('an unconfirmed controller is never reported as locked or unlocked', async () => {
  const room = makeRoom();
  const now = Date.now();
  const { token } = book(room, now - 10 * MIN, now + 60 * MIN);
  nextResult = () => ({ ok: true, state: null });
  const access = resolveAccess(db, token);
  const { command } = requestCustomerDoorCommand(db, { access, action: 'OPEN', minutes: 5, idempotencyKey: 'key-open-0009', now });
  await executeDoorCommand(db, command.id, { now });
  const state = buildAccessState(db, { access: resolveAccess(db, token), payHere: PAYHERE, now: now + 10 });
  assert.equal(state.door.state, 'UNKNOWN');
  assert.equal(state.state, 'ACTIVE_UNKNOWN');
});

/* -------------------------------------------------------------- extensions */

test('extension price: hourly / 4 x (1 + surcharge), in integer cents', () => {
  assert.deepEqual(extensionPrice({ hourlyCents: 100000, surchargeBps: 2000 }), { baseCents: 25000, amountCents: 30000 });
  assert.equal(extensionPrice({ hourlyCents: 133333, surchargeBps: 1250 }).amountCents, 37500);
  assert.equal(percentToBps('12.5'), 1250);
  assert.equal(moneyToCents('1,250.50'), 125050);
  assert.throws(() => percentToBps('12.345'));
});

test('an extension that would overlap the next booking is not offered', () => {
  const room = makeRoom();
  const now = Date.now();
  const end = now - 1 * MIN;
  const { token } = book(room, now - 60 * MIN, end);
  book(room, end + 10 * MIN, end + 70 * MIN);
  const access = resolveAccess(db, token);
  const quote = quoteExtension(db, { reservation: access.reservation, config: access.config, link: access.link, payHere: PAYHERE, now });
  assert.equal(quote.available, false);
  assert.equal(quote.message, 'This room is unavailable for another 15 minutes.');
});

test('a held extension blocks a competing booking of the same minutes', () => {
  const room = makeRoom();
  const now = Date.now();
  const end = now - 1 * MIN;
  const { token } = book(room, now - 60 * MIN, end);
  startExtension(db, { access: resolveAccess(db, token), method: 'PAYHERE', payHere: PAYHERE, now });
  assert.throws(() => db.prepare("INSERT INTO occupancy (resource_unit_id,space_id,start_at,end_at,status,source,created_at) VALUES (?,?,?,?,'ACTIVE','MAINTENANCE',?)")
    .run(room.unit, room.id, end + 2 * MIN, end + 5 * MIN, now), /DOUBLE_BOOKING_CONFLICT/);
});

test('a verified payment extends once; duplicates and forged callbacks do not', () => {
  const room = makeRoom();
  const now = Date.now();
  const end = now - 1 * MIN;
  const { id, token } = book(room, now - 60 * MIN, end);
  const ext = startExtension(db, { access: resolveAccess(db, token), method: 'PAYHERE', payHere: PAYHERE, now });
  assert.equal(ext.amountCents, 30000);
  assert.equal(notify(ext.orderId, { secret: 'wrong' }).accepted, false);
  assert.equal(db.prepare('SELECT end_at FROM reservation WHERE id = ?').get(id).end_at, end);
  notify(ext.orderId);
  notify(ext.orderId);
  const after = db.prepare('SELECT end_at, total_cents FROM reservation WHERE id = ?').get(id);
  assert.ok(after.end_at >= end + 15 * MIN);
  assert.equal(after.total_cents, 130000);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM booking_extension WHERE status = 'CONFIRMED'").get().c, 1);
  // Door control is back, but nothing was opened automatically.
  const state = buildAccessState(db, { access: resolveAccess(db, token), payHere: PAYHERE });
  assert.equal(state.state, 'EXTENDED');
  assert.equal(commands.length, 0);
});

test('a wrong amount or a paid interval that is no longer free goes to review, never silently kept', () => {
  const room = makeRoom();
  const now = Date.now();
  const end = now - 1 * MIN;
  const { token } = book(room, now - 60 * MIN, end);
  const ext = startExtension(db, { access: resolveAccess(db, token), method: 'PAYHERE', payHere: PAYHERE, now });
  notify(ext.orderId, { amount: '1.00' });
  assert.equal(db.prepare('SELECT status FROM booking_extension WHERE id = ?').get(ext.id).status, 'REVIEW_REQUIRED');
  assert.ok(db.prepare("SELECT COUNT(*) AS c FROM notification WHERE type = 'EXTENSION'").get().c >= 1);
});

test('failed payment releases the hold and leaves the booking unchanged', () => {
  const room = makeRoom();
  const now = Date.now();
  const end = now - 1 * MIN;
  const { id, token } = book(room, now - 60 * MIN, end);
  const ext = startExtension(db, { access: resolveAccess(db, token), method: 'PAYHERE', payHere: PAYHERE, now });
  notify(ext.orderId, { status: '-2' });
  assert.equal(db.prepare('SELECT status FROM booking_extension WHERE id = ?').get(ext.id).status, 'FAILED');
  assert.equal(db.prepare('SELECT end_at FROM reservation WHERE id = ?').get(id).end_at, end);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM occupancy WHERE status = 'ACTIVE' AND reservation_id IS NULL").get().c, 0);
});

test('the extension limit is enforced and staff grants still check availability', () => {
  const room = makeRoom();
  const now = Date.now();
  const { id, token } = book(room, now - 60 * MIN, now - 1 * MIN);
  db.prepare('UPDATE access_policy SET max_extensions = 1').run();
  grantExtension(db, { actor, reservationId: id, method: 'COMPLIMENTARY', now });
  const access = resolveAccess(db, token);
  const quote = quoteExtension(db, { reservation: access.reservation, config: access.config, link: access.link, payHere: PAYHERE, now: now + 20 * MIN });
  assert.equal(quote.reason, 'LIMIT_REACHED');
});

/* -------------------------------------------------------------- assistance */

test('repeated assistance taps create one request and one notification per staff member', () => {
  const room = makeRoom();
  const now = Date.now();
  const { id, token } = book(room, now - 60 * MIN, now - 1 * MIN);
  const access = resolveAccess(db, token);
  requestAssistance(db, { access, now });
  requestAssistance(db, { access, now: now + 1000 });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM staff_assistance_request WHERE reservation_id = ?').get(id).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM notification WHERE type = 'STAFF_ASSISTANCE'").get().c, 1);
});

/* --------------------------------------------------------------------- sms */

test('Sri Lankan numbers are normalised to E.164 for Twilio', () => {
  assert.equal(normalizeSmsNumber('077 123 4567'), '+94771234567');
  assert.equal(normalizeSmsNumber('+94 77 123 4567'), '+94771234567');
  assert.equal(normalizeSmsNumber('abc'), null);
});
