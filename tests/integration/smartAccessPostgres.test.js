/**
 * The smart-access schema and core flow on real PostgreSQL (PGlite): the
 * shipped 0007 migration, the overlap guard against extension holds, and an
 * end-to-end unlock -> automatic lock -> paid extension.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPostgresTestDb } from '../helpers/postgresTestDb.js';
import { hashPassword } from '../../src/server/security/passwords.js';
import { issueAccessLink, resolveAccess } from '../../src/server/services/accessLinkService.js';
import { updateSpaceAccessConfig } from '../../src/server/services/accessPolicyService.js';
import { executeDoorCommand, getDoorSnapshot, requestCustomerDoorCommand, runDoorQueue } from '../../src/server/services/doorService.js';
import { setDoorDriverForTests } from '../../src/server/services/doorDrivers.js';
import { processExtensionNotification, startExtension } from '../../src/server/services/extensionService.js';
import { requestAssistance } from '../../src/server/services/assistanceService.js';

const MIN = 60_000;
const md5 = (s) => createHash('md5').update(s).digest('hex').toUpperCase();
const PAYHERE = { merchantId: '1211149', merchantSecret: 'pg-secret', sandbox: true, baseUrl: 'https://example.test' };

test('smart access works end to end on PostgreSQL', async () => {
  process.env.NAGARO_DOOR_SIMULATOR = '1';
  const sent = [];
  setDoorDriverForTests(async (c) => { sent.push(c.action); return { ok: true, state: c.action === 'OPEN' ? 'UNLOCKED' : 'LOCKED' }; });
  const db = await createPostgresTestDb();
  try {
    const now = Date.now();
    const adminId = Number(db.prepare(`INSERT INTO admin_user (email,password_hash,display_name,role,is_super_admin,is_active,created_at,updated_at)
      VALUES (?,?,?,'ADMIN',1,1,?,?)`).run('a@x.test', hashPassword('TestPassword123'), 'Admin', now, now).lastInsertRowid);
    const actor = { id: adminId, label: 'Admin', role: 'SUPER_ADMIN' };
    const space = Number(db.prepare(`INSERT INTO space (code,name,category,capacity,status,currency,pricing_unit,min_duration_minutes,open_time,close_time,created_at,updated_at)
      VALUES ('MR01','Meeting Room 01','MEETING_ROOM',8,'PUBLISHED','LKR','HOUR',15,'00:00','23:59',?,?)`).run(now, now).lastInsertRowid);
    db.prepare("INSERT INTO space_rate (space_id,unit,amount_cents,is_default) VALUES (?,'HOUR',100000,1)").run(space);
    const unit = Number(db.prepare("INSERT INTO resource_unit (space_id,code,label,kind,is_active,created_at) VALUES (?,'MR01-1','MR01','EXCLUSIVE',1,?)").run(space, now).lastInsertRowid);
    updateSpaceAccessConfig(db, { actor, spaceId: space, body: { driver: 'SIMULATED', door_enabled: '1', confirms_state: '1' } });
    const customer = Number(db.prepare('INSERT INTO customer (full_name,email,email_normalized,phone,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('C', 'c@x.test', 'c@x.test', '0771234567', now, now).lastInsertRowid);
    const end = now + 10 * MIN;
    const reservation = Number(db.prepare(`INSERT INTO reservation (reference,space_id,customer_id,status,start_at,end_at,unit_count,billing_unit,billing_quantity,rate_cents,total_cents,currency,created_by,created_at,updated_at)
      VALUES ('BK-PG1',?,?,'CONFIRMED',?,?,1,'HOUR',1,100000,100000,'LKR',?,?,?)`).run(space, customer, now - 50 * MIN, end, adminId, now, now).lastInsertRowid);
    db.prepare("INSERT INTO occupancy (resource_unit_id,space_id,start_at,end_at,status,source,reservation_id,created_at) VALUES (?,?,?,?,'ACTIVE','RESERVATION',?,?)")
      .run(unit, space, now - 50 * MIN, end, reservation, now);
    const { token } = issueAccessLink(db, { reservationId: reservation, now });

    const { command } = requestCustomerDoorCommand(db, { access: resolveAccess(db, token, { now }), action: 'OPEN', minutes: 30, idempotencyKey: 'pg-open-0001', now });
    assert.equal(Number(command.autoLockAt), end);
    await executeDoorCommand(db, command.id, { now });
    await runDoorQueue(db, { now: end + 1000 });
    assert.deepEqual(sent, ['OPEN', 'CLOSE']);
    assert.equal(getDoorSnapshot(db, space).reportedState, 'LOCKED');

    const after = end + 2 * MIN;
    const ext = startExtension(db, { access: resolveAccess(db, token, { now: after }), method: 'PAYHERE', payHere: PAYHERE, now: after });
    assert.throws(() => db.prepare("INSERT INTO occupancy (resource_unit_id,space_id,start_at,end_at,status,source,created_at) VALUES (?,?,?,?,'ACTIVE','MAINTENANCE',?)")
      .run(unit, space, end + 3 * MIN, end + 5 * MIN, after));
    const sig = md5(`${PAYHERE.merchantId}${ext.orderId}300.00LKR2${md5(PAYHERE.merchantSecret)}`);
    const payload = { merchant_id: PAYHERE.merchantId, order_id: ext.orderId, payment_id: 'PG1', payhere_amount: '300.00', payhere_currency: 'LKR', status_code: '2', md5sig: sig };
    processExtensionNotification(db, payload, PAYHERE, after + 1000);
    processExtensionNotification(db, payload, PAYHERE, after + 2000);
    const row = db.prepare('SELECT end_at, total_cents FROM reservation WHERE id = ?').get(reservation);
    assert.ok(Number(row.end_at) >= after + 15 * MIN);
    assert.equal(Number(row.total_cents), 130000);

    requestAssistance(db, { access: resolveAccess(db, token, { now: after }), now: after });
    requestAssistance(db, { access: resolveAccess(db, token, { now: after }), now: after + 10 });
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM staff_assistance_request').get().c), 1);
  } finally {
    setDoorDriverForTests(null);
    db.close();
  }
});
