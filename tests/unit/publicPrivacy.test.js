/**
 * Privacy boundary of everything a visitor can reach.
 *
 * Two independent checks, deliberately not sharing code with the modules they
 * police:
 *
 *   1. `publicSpaceProjection()` emits EXACTLY the documented key set. This
 *      file carries its own copy of that list, so widening the projection in
 *      the module cannot silently widen the test.
 *   2. Nothing reachable from a public response — the projection, the public
 *      availability answer, the public day projection — contains a forbidden
 *      key name (anywhere in the name, after normalising case/punctuation) or
 *      a reservation reference (`NG-YYYY-NNNNN`).
 *
 * The database fixture holds a real named customer with a real reservation, so
 * the checks are not vacuous: the staff-facing `getSpaceDayGrid()` output
 * (includeDetails: true) DOES contain the reference and the customer's name,
 * and the public shapes built from the same rows do not.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { PUBLIC_SPACE_KEYS, publicSpaceProjection } from '../../src/web/views/publicViews.js';
import { publicDayProjection } from '../../src/server/routes/publicRoutes.js';
import { getPublicAvailability, getSpaceDayGrid } from '../../src/server/services/availabilityService.js';
import { addImageRecord, createSpace, listImages, publishSpace } from '../../src/server/services/spaceService.js';
import { createCustomer } from '../../src/server/services/customerService.js';
import { createReservation } from '../../src/server/services/bookingService.js';
import { businessLocalToEpoch } from '../../src/server/domain/time.js';
import { closeTestDb, createTestActor, createTestDb } from '../helpers/testDb.js';

/* ------------------------------------------------------------- expectations */

/** The frozen public surface, copied from the contract (not from the module). */
const EXPECTED_PUBLIC_KEYS = [
  'id', 'code', 'name', 'category', 'categoryLabel', 'shortDescription', 'description',
  'location', 'floor', 'capacity', 'unitCount', 'openTime', 'closeTime',
  'minDurationMinutes', 'maxDurationMinutes', 'bufferMinutes',
  'rates', 'rateList', 'rateSummary', 'amenities', 'attributes', 'images', 'isPublished',
];

/**
 * Key names that must never appear in a public response. A key fails when its
 * normalised form CONTAINS one of these, so `customerEmail`, `ownerNotes` and
 * `reservation_reference` are all caught.
 */
const FORBIDDEN_KEY_NAMES = [
  'customer', 'customername', 'fullname', 'email', 'phone', 'organization',
  'internalnotes', 'reference', 'reservationid', 'reservationreference',
  'idempotencykey', 'createdby', 'notes', 'purpose', 'attendees', 'totalcents',
];

/** Strings that exist only inside the staff-facing records. */
const FORBIDDEN_VALUES = [
  'Ama Tesfaye', 'ama@example.com', '+251911000022', 'Ada Labs', 'internal only', 'Board planning',
];

/** A reservation reference: `NG-2030-00001`. Never an inquiry (`INQ-...`). */
const RESERVATION_REFERENCE = /(?:^|[^A-Za-z0-9])NG-\d{4}-\d{5}/;

const FIXTURE_DATE = '2030-05-14';

/* ------------------------------------------------------------------ helpers */

function normaliseKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function collectKeys(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectKeys(item, out);
    }
  }
  return out;
}

function textValues(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) textValues(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) textValues(item, out);
    return out;
  }
  if (typeof value === 'string') out.push(value);
  return out;
}

/** The public-surface scrub: no forbidden key name, no reservation reference. */
function assertPublicallyClean(value, label) {
  for (const key of collectKeys(value)) {
    const normalised = normaliseKey(key);
    for (const forbidden of FORBIDDEN_KEY_NAMES) {
      assert.ok(
        !normalised.includes(forbidden),
        `${label}: public data exposes a forbidden key name: "${key}"`,
      );
    }
  }
  const json = JSON.stringify(value);
  assert.ok(!RESERVATION_REFERENCE.test(json), `${label}: public data exposes a reservation reference`);
  for (const secret of FORBIDDEN_VALUES) {
    assert.ok(!json.includes(secret), `${label}: public data exposes staff-only value "${secret}"`);
  }
}

/* ----------------------------------------------------------------- fixtures */

/** A hydrated-space stand-in: the private fields are the point of the test. */
function fixtureSpace() {
  return {
    id: 7,
    code: 'MEET-HORIZON',
    name: 'Horizon Meeting Room',
    category: 'MEETING_ROOM',
    categoryLabel: 'Meeting & training room',
    shortDescription: 'A bright meeting room for eight.',
    description: 'A bright, quiet meeting room with a display screen and a whiteboard for up to eight people.',
    location: 'Trace Expert City, Building A',
    floor: '2',
    capacity: 8,
    status: 'PUBLISHED',
    currency: 'ETB',
    pricingUnit: 'HOUR',
    minDurationMinutes: 60,
    maxDurationMinutes: 240,
    bufferMinutes: 15,
    openTime: '08:00',
    closeTime: '18:00',
    amenities: ['Display screen', 'Whiteboard'],
    attributes: {
      notes: 'internal only', purpose: 'actually staff-only', attendees: 12, email: 'leak@example.com',
      seating_capacity: 8, layout: 'boardroom',
    },
    contactNote: 'Call reception on extension 4', // staff-facing on purpose
    units: [{ id: 1, code: 'MEET-HORIZON-01', label: 'Horizon Meeting Room', kind: 'EXCLUSIVE', is_active: 1 }],
    unitCount: 1,
    imageCount: 1,
    coverImage: 'stored-on-disk.png',
    rates: { HOUR: 150000, HALF_DAY: 450000 },
    rateList: [
      { space_id: 7, unit: 'HOUR', amount_cents: 150000, is_default: 1 },
      { space_id: 7, unit: 'HALF_DAY', amount_cents: 450000, is_default: 0 },
    ],
    createdAt: 1,
    updatedAt: 2,
    publishedAt: 3,
    archivedAt: null,
  };
}

function fixtureImages() {
  return [
    {
      id: 11,
      spaceId: 7,
      storedName: 'stored-on-disk.png',
      originalName: 'the-real-file-name.png',
      mimeType: 'image/png',
      byteSize: 2048,
      altText: 'The Horizon meeting room',
      sortOrder: 0,
      isCover: true,
      createdAt: 1,
      url: '/media/stored-on-disk.png',
    },
    {
      id: 12,
      spaceId: 7,
      storedName: 'second.png',
      originalName: 'second-original.png',
      mimeType: 'image/png',
      byteSize: 4096,
      altText: null,
      sortOrder: 1,
      isCover: false,
      createdAt: 2,
      url: '/media/second.png',
    },
  ];
}

let db = null;
let actor = null;
let publishedSpace = null;
let customer = null;
let reservation = null;

before(() => {
  db = createTestDb();
  actor = createTestActor(db);

  publishedSpace = createSpace(db, {
    actor,
    payload: {
      code: 'MEET-HORIZON',
      name: 'Horizon Meeting Room',
      category: 'MEETING_ROOM',
      short_description: 'A bright meeting room for eight.',
      description: 'A bright, quiet meeting room with a display screen and a whiteboard for up to eight people.',
      location: 'Trace Expert City, Building A',
      floor: '2',
      capacity: 8,
      pricing_unit: 'HOUR',
      min_duration_minutes: 60,
      max_duration_minutes: 240,
      buffer_minutes: 15,
      open_time: '08:00',
      close_time: '18:00',
      amenities: ['Display screen', 'Whiteboard'],
      attributes: {
        notes: 'internal only', purpose: 'actually staff-only', attendees: 12,
        seating_capacity: 8, layout: 'boardroom',
      },
      rates: [
        { unit: 'HOUR', amount_cents: 150000 },
        { unit: 'HALF_DAY', amount_cents: 450000 },
      ],
    },
  });
  addImageRecord(db, {
    actor,
    spaceId: publishedSpace.id,
    storedName: 'deadbeefdeadbeefdeadbeefdeadbeef.png',
    originalName: 'the-real-file-name.png',
    mimeType: 'image/png',
    byteSize: 2048,
    altText: 'The Horizon meeting room',
  });
  publishedSpace = publishSpace(db, { actor, spaceId: publishedSpace.id });

  customer = createCustomer(db, {
    actor,
    payload: {
      full_name: 'Ama Tesfaye',
      email: 'ama@example.com',
      phone: '+251911000022',
      organization: 'Ada Labs',
      notes: 'internal only',
    },
  });

  reservation = createReservation(db, {
    actor,
    spaceId: publishedSpace.id,
    customerId: customer.id,
    startAt: businessLocalToEpoch(FIXTURE_DATE, '10:00'),
    endAt: businessLocalToEpoch(FIXTURE_DATE, '12:00'),
    attendees: 4,
    purpose: 'Board planning',
    internalNotes: 'internal note',
  }).reservation;
});

after(() => {
  closeTestDb(db);
});

/* ---------------------------------------------------------------- the scrub */

describe('the privacy scrub itself', () => {
  test('catches reservation references but not inquiry references', () => {
    assert.ok(RESERVATION_REFERENCE.test(reservation ? reservation.reference : 'NG-2030-00001'));
    assert.ok(!RESERVATION_REFERENCE.test('INQ-2030-00001'));
    assert.throws(() => assertPublicallyClean({ note: 'NG-2030-00001' }, 'self-test'));
    assert.throws(() => assertPublicallyClean({ ownerNotes: 'x' }, 'self-test'));
    assert.doesNotThrow(() => assertPublicallyClean({ code: 'MEET-1', isPublished: true }, 'self-test'));
  });

  test('the fixture really holds staff-only data', () => {
    // If this fails the DB fixture is broken and every other assertion here is
    // meaningless: the raw grid must contain the reference and the name.
    const grid = getSpaceDayGrid(db, { spaceId: publishedSpace.id, dateKey: FIXTURE_DATE, includeDetails: true });
    const raw = JSON.stringify(grid);
    assert.ok(raw.includes(customer.fullName), 'fixture: expected the customer name in the raw grid');
    assert.ok(raw.includes(reservation.reference), 'fixture: expected the reservation reference in the raw grid');
  });
});

/* ------------------------------------------------------------- the projection */

describe('publicSpaceProjection()', () => {
  test('emits exactly the documented public keys, in order', () => {
    const projection = publicSpaceProjection(fixtureSpace(), { images: fixtureImages() });
    assert.deepEqual(Object.keys(projection), EXPECTED_PUBLIC_KEYS);
    assert.deepEqual(Object.keys(projection), [...PUBLIC_SPACE_KEYS]);
    assertPublicallyClean(projection, 'projection');
  });

  test('carries no staff-only fields and scrubs forbidden attribute keys', () => {
    const projection = publicSpaceProjection(fixtureSpace(), { images: fixtureImages() });
    assert.equal(projection.code, 'MEET-HORIZON');
    assert.equal(projection.isPublished, true);
    assert.equal(projection.rateSummary, 'ETB 1,500.00 per hour · ETB 4,500.00 per half day');
    assert.equal(JSON.stringify(projection).includes('Call reception'), false);
    assert.equal(projection.contactNote, undefined);
    assert.equal(projection.status, undefined);
    assert.equal(projection.units, undefined);
    assert.equal(projection.createdAt, undefined);
    assert.deepEqual(projection.attributes, { seating_capacity: 8, layout: 'boardroom' });
  });

  test('photographs keep only id, url, altText and isCover', () => {
    const projection = publicSpaceProjection(fixtureSpace(), { images: fixtureImages() });
    assert.equal(projection.images.length, 2);
    for (const image of projection.images) {
      assert.deepEqual(Object.keys(image), ['id', 'url', 'altText', 'isCover']);
    }
    assert.deepEqual(projection.images[0], {
      id: 11, url: '/media/stored-on-disk.png', altText: 'The Horizon meeting room', isCover: true,
    });
  });

  test('rates keep amount and label but lose row ids and space_id', () => {
    const projection = publicSpaceProjection(fixtureSpace(), { images: fixtureImages() });
    for (const rate of projection.rateList) {
      assert.deepEqual(Object.keys(rate), ['unit', 'unitLabel', 'amountCents', 'amountLabel', 'isDefault']);
    }
    assert.equal(projection.rateList[0].unit, 'HOUR');
    assert.equal(projection.rateList[0].amountCents, 150000);
    assert.deepEqual(projection.rates, { HOUR: 150000, HALF_DAY: 450000 });
  });

  test('a real published space projects cleanly, with real photographs', () => {
    const projection = publicSpaceProjection(publishedSpace, { images: listImages(db, publishedSpace.id) });
    assert.deepEqual(Object.keys(projection), EXPECTED_PUBLIC_KEYS);
    assert.equal(projection.id, publishedSpace.id);
    assert.equal(projection.isPublished, true);
    assert.equal(projection.images.length, 1);
    assert.equal(projection.images[0].url, '/media/deadbeefdeadbeefdeadbeefdeadbeef.png');
    assert.equal(projection.attributes.notes, undefined);
    assert.equal(projection.attributes.purpose, undefined);
    assert.equal(projection.attributes.attendees, undefined);
    assertPublicallyClean(projection, 'real projection');
  });

  test('an unavailable space is represented, not invented', () => {
    assert.equal(publicSpaceProjection(null), null);
  });
});

/* --------------------------------------------------- availability and day grid */

describe('public availability shapes', () => {
  test('counts the booked interval without naming anyone', () => {
    const availability = getPublicAvailability(db, {
      spaceId: publishedSpace.id,
      startAt: businessLocalToEpoch(FIXTURE_DATE, '10:30'),
      endAt: businessLocalToEpoch(FIXTURE_DATE, '11:30'),
      deskCount: 1,
    });
    assert.equal(availability.isAvailable, false);
    assert.equal(availability.freeUnits, 0);
    assert.equal(availability.totalUnits, 1);
    assert.equal(availability.blockedPeriods.length, 1);
    assert.deepEqual(Object.keys(availability.blockedPeriods[0]), ['startAt', 'endAt', 'kind']);
    assert.equal(availability.blockedPeriods[0].kind, 'BOOKED');
    assertPublicallyClean(availability, 'availability');
  });

  test('a free interval reports counts and no blocked periods', () => {
    const availability = getPublicAvailability(db, {
      spaceId: publishedSpace.id,
      startAt: businessLocalToEpoch(FIXTURE_DATE, '13:00'),
      endAt: businessLocalToEpoch(FIXTURE_DATE, '14:00'),
      deskCount: 1,
    });
    assert.equal(availability.isAvailable, true);
    assert.equal(availability.freeUnits, 1);
    assert.deepEqual(availability.blockedPeriods, []);
    assertPublicallyClean(availability, 'free availability');
  });

  test('the day projection is the exact documented shape, with no occupancy', () => {
    const grid = getSpaceDayGrid(db, {
      spaceId: publishedSpace.id, dateKey: FIXTURE_DATE, includeDetails: false,
    });
    const day = publicDayProjection(publishedSpace.code, grid);
    assert.deepEqual(Object.keys(day), ['spaceCode', 'dateKey', 'openTime', 'closeTime', 'totalUnits', 'slots']);
    assert.equal(day.spaceCode, 'MEET-HORIZON');
    assert.equal(day.dateKey, FIXTURE_DATE);
    assert.equal(day.openTime, '08:00');
    assert.equal(day.closeTime, '18:00');
    assert.equal(day.totalUnits, 1);
    assert.equal(day.slots.length, 10); // 08:00-18:00, one slot per hour
    for (const slot of day.slots) {
      assert.deepEqual(Object.keys(slot), ['startAt', 'endAt', 'freeUnits', 'totalUnits', 'isFree']);
    }
    const booked = day.slots.filter((slot) => slot.freeUnits === 0);
    assert.equal(booked.length, 2, 'the 10:00 and 11:00 slots are consumed by the reservation');
    for (const slot of booked) assert.equal(slot.isFree, false);
    assert.equal(JSON.stringify(day).includes('occupancy'), false);
    assertPublicallyClean(day, 'day projection');
  });
});
