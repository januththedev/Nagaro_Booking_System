import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, closeTestDb, createTestActor } from '../helpers/testDb.js';
import { seedScenario } from '../helpers/concurrencyHelpers.js';
import { cancelReservation, createReservation } from '../../src/server/services/bookingService.js';
import { businessLocalToEpoch } from '../../src/server/domain/time.js';
import {
  buildPushPayload, createDueReminders, createNotificationsForAdmins,
  dispatchPendingNotifications, dispatchPendingReminderEmails, listNotifications,
  markAllNotificationsRead, markNotificationRead, savePushSubscription,
} from '../../src/server/services/notificationService.js';
import {
  cancelBookingRequest, createBookingRequest, createSelfServiceBooking,
} from '../../src/server/services/bookingRequestService.js';
import { createPublicBooking } from '../../src/server/services/publicBookingService.js';
import {
  afterPublicReservationCancelled, afterPublicReservationCreated,
} from '../../src/server/services/notificationHooks.js';
import { vapidConfig } from '../../src/server/services/pushService.js';

function uniqueKey(prefix) {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

test('notifications are per-admin, deduplicated, and unread reminders pin to the top', () => {
  const db = createTestDb();
  try {
    const scenario = seedScenario(db);
    const first = createNotificationsForAdmins(db, {
      type: 'NEW_BOOKING',
      title: 'New booking',
      body: 'Meeting room at 10:00',
      dedupeKey: uniqueKey('new'),
    });
    assert.equal(first.created, 1);

    const duplicate = createNotificationsForAdmins(db, {
      type: 'NEW_BOOKING',
      title: 'New booking',
      body: 'Meeting room at 10:00',
      dedupeKey: first.adminUserIds.length ? 'new:duplicate' : 'new:duplicate',
    });
    assert.equal(duplicate.created, 1, 'a different dedupe key creates a new notification');

    const reminder = createNotificationsForAdmins(db, {
      type: 'REMINDER',
      title: 'Room prep',
      body: 'Make the room ready',
      priority: 'HIGH',
      dedupeKey: uniqueKey('reminder'),
    });
    assert.equal(reminder.created, 1);

    const result = listNotifications(db, { adminUserId: scenario.actor.id });
    assert.equal(result.unreadCount, 3);
    assert.equal(result.items[0].priority, 'HIGH');
    assert.equal(result.items[0].pinned, true);

    const marked = markNotificationRead(db, {
      adminUserId: scenario.actor.id,
      notificationId: result.items[1].id,
    });
    assert.equal(marked.unreadCount, 2);
    const all = markAllNotificationsRead(db, { adminUserId: scenario.actor.id });
    assert.equal(all.updated, 2);
    assert.equal(listNotifications(db, { adminUserId: scenario.actor.id }).unreadCount, 0);
  } finally {
    closeTestDb(db);
  }
});

test('booking lifecycle hooks notify admins about requests, cancellations and confirmed bookings', () => {
  const db = createTestDb();
  try {
    const scenario = seedScenario(db);
    db.prepare("UPDATE space SET status='PUBLISHED'").run();
    const dateKey = new Date(Date.now() + 5 * 86400000 + 330 * 60000).toISOString().slice(0, 10);
    const request = createBookingRequest(db, {
      spaceId: scenario.roomSpace.id,
      startAt: businessLocalToEpoch(dateKey, '10:00'),
      endAt: businessLocalToEpoch(dateKey, '11:00'),
      unitCount: 1,
      customer: { fullName: 'Lifecycle Customer', email: 'lifecycle@example.test' },
      purpose: 'Lifecycle',
      now: Date.now(),
    });
    assert.equal(request.request.status, 'REQUESTED');
    let items = listNotifications(db, { adminUserId: scenario.actor.id }).items;
    assert.equal(items.length, 1);
    assert.match(items[0].title, /New booking request/);

    const cancelled = cancelBookingRequest(db, {
      reference: request.request.reference,
      token: request.manageToken,
      now: Date.now(),
    });
    assert.equal(cancelled.status, 'CANCELLED');
    items = listNotifications(db, { adminUserId: scenario.actor.id }).items;
    assert.ok(items.some((item) => item.type === 'BOOKING_CANCELLED'));

    const selfService = createSelfServiceBooking(db, {
      spaceId: scenario.roomSpace.id,
      startAt: businessLocalToEpoch(dateKey, '12:00'),
      endAt: businessLocalToEpoch(dateKey, '13:00'),
      unitCount: 1,
      customer: { fullName: 'Self Service', email: 'self@example.test' },
      purpose: 'Self service',
      now: Date.now(),
    });
    assert.equal(selfService.request.status, 'CONFIRMED');
    items = listNotifications(db, { adminUserId: scenario.actor.id }).items;
    assert.ok(items.some((item) => item.title === 'New confirmed booking'));

    const direct = createPublicBooking(db, {
      spaceId: scenario.roomSpace.id,
      startAt: businessLocalToEpoch(dateKey, '14:00'),
      endAt: businessLocalToEpoch(dateKey, '15:00'),
      unitCount: 1,
      customer: { fullName: 'Direct Guest', email: 'direct@example.test' },
      purpose: 'Direct',
      now: Date.now(),
    });
    assert.ok(direct.reservation.reference);
    items = listNotifications(db, { adminUserId: scenario.actor.id }).items;
    assert.ok(items.filter((item) => item.title === 'New confirmed booking').length >= 2);
  } finally {
    closeTestDb(db);
  }
});

test('admin-created booking hooks notify the rest of the team and immediate dispatch receives the database', () => {
  const db = createTestDb();
  const previous = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT,
  };
  try {
    process.env.VAPID_PUBLIC_KEY = 'test-public-key';
    process.env.VAPID_PRIVATE_KEY = 'test-private-key';
    process.env.VAPID_SUBJECT = 'mailto:ops@example.test';
    const scenario = seedScenario(db);
    const colleague = createTestActor(db, { email: 'colleague@test.local', role: 'ADMIN' });
    db.prepare("UPDATE space SET status='PUBLISHED'").run();
    const dateKey = new Date(Date.now() + 7 * 86400000 + 330 * 60000).toISOString().slice(0, 10);
    const created = createReservation(db, {
      actor: scenario.actor,
      spaceId: scenario.roomSpace.id,
      customerId: scenario.customer.id,
      startAt: businessLocalToEpoch(dateKey, '10:00'),
      endAt: businessLocalToEpoch(dateKey, '11:00'),
      unitCount: 1,
      attendees: 2,
      purpose: 'Team hook test',
      source: 'admin',
    });

    const notified = afterPublicReservationCreated(db, {
      reservationId: created.reservation.id,
      excludeAdminUserId: scenario.actor.id,
    });
    assert.equal(notified.created, 1, 'a configured immediate-dispatch path must not be swallowed');
    assert.equal(listNotifications(db, { adminUserId: scenario.actor.id }).items.length, 0);
    assert.equal(listNotifications(db, { adminUserId: colleague.id }).items.length, 1);

    cancelReservation(db, {
      actor: scenario.actor,
      reservationId: created.reservation.id,
      reason: 'Cancelled in test',
    });
    const cancelled = afterPublicReservationCancelled(db, {
      reservationId: created.reservation.id,
      excludeAdminUserId: scenario.actor.id,
    });
    assert.equal(cancelled.created, 1);
    assert.equal(listNotifications(db, { adminUserId: colleague.id }).items.length, 2);
  } finally {
    if (previous.publicKey === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = previous.publicKey;
    if (previous.privateKey === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = previous.privateKey;
    if (previous.subject === undefined) delete process.env.VAPID_SUBJECT;
    else process.env.VAPID_SUBJECT = previous.subject;
    closeTestDb(db);
  }
});

test('push configuration requires a real VAPID subject and the admin shell has the prep strip', () => {
  assert.equal(vapidConfig({ VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_KEY: 'private' }).configured, false);
  assert.equal(vapidConfig({
    VAPID_PUBLIC_KEY: 'public',
    VAPID_PRIVATE_KEY: 'private',
    VAPID_SUBJECT: 'mailto:ops@example.test',
  }).configured, true);

  const layout = readFileSync(new URL('../../src/web/views/layout.js', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../../src/web/public/admin-notifications.js', import.meta.url), 'utf8');
  assert.match(layout, /data-notification-prep/);
  assert.match(layout, /data-notification-prep-dismiss/);
  assert.match(client, /renderPrepStrip/);
  assert.match(client, /trace-prep-dismissed:/);
  assert.match(client, /visibilitychange/);
  assert.match(client, /trace:notifications:refresh/);
});

test('reminders are created once per reservation, including catch-up ticks', () => {
  const db = createTestDb();
  try {
    const scenario = seedScenario(db);
    db.prepare("UPDATE space SET status='PUBLISHED'").run();
    const dateKey = new Date(Date.now() + 3 * 86400000 + 330 * 60000).toISOString().slice(0, 10);
    const startAt = businessLocalToEpoch(dateKey, '10:00');
    const endAt = businessLocalToEpoch(dateKey, '11:00');
    const created = createReservation(db, {
      actor: scenario.actor,
      spaceId: scenario.roomSpace.id,
      customerId: scenario.customer.id,
      startAt,
      endAt,
      unitCount: 1,
      attendees: 2,
      purpose: 'Reminder test',
      source: 'admin',
    });

    const first = createDueReminders(db, { now: startAt - 31 * 60000 });
    assert.equal(first.scanned, 1);
    assert.equal(first.created, 1);
    assert.equal(first.reservationIds[0], created.reservation.id);

    const second = createDueReminders(db, { now: startAt - 29 * 60000 });
    assert.equal(second.created, 0, 'the dedupe key makes a repeated tick harmless');

    const notification = listNotifications(db, { adminUserId: scenario.actor.id }).items[0];
    const built = buildPushPayload(db, notification);
    assert.match(built.payload.body, new RegExp(created.reservation.reference));
    assert.doesNotMatch(built.payload.body, /Marta Kebede/, 'push payloads never carry customer names');
    assert.equal(built.payload.requireInteraction, true);
    assert.equal(built.urgency, 'high');
  } finally {
    closeTestDb(db);
  }
});

test('pending push notifications are delivered to active subscriptions and survive retries', async () => {
  const db = createTestDb();
  try {
    const scenario = seedScenario(db);
    createNotificationsForAdmins(db, {
      type: 'NEW_BOOKING',
      title: 'New booking',
      body: 'Test',
      dedupeKey: uniqueKey('push'),
    });
    savePushSubscription(db, {
      adminUserId: scenario.actor.id,
      subscription: {
        endpoint: 'https://push.example.test/subscription/1',
        keys: { p256dh: 'A'.repeat(40), auth: 'B'.repeat(16) },
      },
    });
    const sent = [];
    const result = await dispatchPendingNotifications(db, {
      env: {
        VAPID_PUBLIC_KEY: 'public-key',
        VAPID_PRIVATE_KEY: 'private-key',
        VAPID_SUBJECT: 'mailto:ops@example.test',
      },
      pushSender: async (message) => { sent.push(message); },
    });
    assert.equal(result.delivered, 1);
    assert.equal(result.failed, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.body.includes('Marta'), false);
  } finally {
    closeTestDb(db);
  }
});

test('a push endpoint cannot be reassigned to another administrator', () => {
  const db = createTestDb();
  try {
    const first = createTestActor(db, { email: 'push-first@test.local' });
    const second = createTestActor(db, { email: 'push-second@test.local' });
    const subscription = {
      endpoint: 'https://push.example.test/subscription/private-endpoint',
      keys: { p256dh: 'A'.repeat(40), auth: 'B'.repeat(16) },
    };
    savePushSubscription(db, { adminUserId: first.id, subscription });
    assert.throws(
      () => savePushSubscription(db, { adminUserId: second.id, subscription }),
      /belongs to another account/i,
    );
    const owner = db.prepare('SELECT admin_user_id FROM push_subscription WHERE endpoint = ?')
      .get(subscription.endpoint);
    assert.equal(Number(owner.admin_user_id), first.id);
  } finally {
    closeTestDb(db);
  }
});

test('reminder email fallback sends one message per reservation and records delivery', async () => {
  const db = createTestDb();
  try {
    const scenario = seedScenario(db);
    db.prepare("UPDATE space SET status='PUBLISHED'").run();
    const dateKey = new Date(Date.now() + 4 * 86400000 + 330 * 60000).toISOString().slice(0, 10);
    const startAt = businessLocalToEpoch(dateKey, '10:00');
    const endAt = businessLocalToEpoch(dateKey, '11:00');
    createReservation(db, {
      actor: scenario.actor,
      spaceId: scenario.roomSpace.id,
      customerId: scenario.customer.id,
      startAt,
      endAt,
      unitCount: 1,
      attendees: 2,
      purpose: 'Email test',
      source: 'admin',
    });
    createDueReminders(db, { now: startAt - 30 * 60000 });
    const messages = [];
    const result = await dispatchPendingReminderEmails(db, {
      now: startAt - 30 * 60000,
      to: 'ops@example.test',
      mailSender: async (message) => { messages.push(message); return { status: 'SENT' }; },
    });
    assert.equal(result.sent, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0].subject, /room|prep|reminder/i);
    const rows = db.prepare("SELECT email_sent_at FROM notification WHERE type = 'REMINDER'").all();
    assert.ok(rows.every((row) => row.email_sent_at !== null));
  } finally {
    closeTestDb(db);
  }
});
