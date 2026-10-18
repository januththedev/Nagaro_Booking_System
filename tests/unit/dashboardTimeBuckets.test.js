/**
 * Pure-helper tests for the dashboard read model (no database).
 *
 * These pin down the two places where a dashboard silently goes wrong:
 *   1. hour bucketing (partial hours, midnight-spanning open ranges), and
 *   2. business-local day boundaries - the classic `Date.now() % 86400000`
 *      bug attributes early-morning SLST bookings to the previous day and
 *      late-afternoon bookings to the wrong window.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hourlyBuckets, occupancyRate, summariseSpaces,
} from '../../src/server/services/dashboardService.js';
import {
  MS, businessDateKey, businessLocalToEpoch, startOfBusinessDay,
} from '../../src/server/domain/time.js';

const DATE = '2026-11-10'; // a Tuesday, in SLST (UTC+05:30)

/* ------------------------------------------------------------ hourlyBuckets */

test('hourlyBuckets: 08:00-18:00 gives ten contiguous one-hour buckets', () => {
  const buckets = hourlyBuckets({ dateKey: DATE, openTime: '08:00', closeTime: '18:00' });

  assert.equal(buckets.length, 10);
  assert.equal(buckets[0].startAt, businessLocalToEpoch(DATE, '08:00'));
  assert.equal(buckets.at(-1).endAt, businessLocalToEpoch(DATE, '18:00'));

  for (let i = 0; i < buckets.length; i += 1) {
    assert.equal(buckets[i].endAt - buckets[i].startAt, MS.HOUR, `bucket ${i} is one hour`);
    if (i > 0) {
      // half-open, contiguous - an 11:00 end never overlaps an 11:00 start
      assert.equal(buckets[i].startAt, buckets[i - 1].endAt, `bucket ${i} starts where ${i - 1} ends`);
    }
  }
});

test('hourlyBuckets: a partial final hour is shortened, never rounded up', () => {
  const buckets = hourlyBuckets({ dateKey: DATE, openTime: '08:30', closeTime: '11:00' });

  assert.equal(buckets.length, 3);
  assert.deepEqual(
    buckets.map((b) => [businessDateKey(b.startAt), b.startAt === b.endAt]),
    [[DATE, false], [DATE, false], [DATE, false]],
  );
  assert.equal(buckets[0].startAt, businessLocalToEpoch(DATE, '08:30'));
  assert.equal(buckets[1].startAt, businessLocalToEpoch(DATE, '09:30'));
  assert.equal(buckets[2].startAt, businessLocalToEpoch(DATE, '10:30'));
  assert.equal(buckets[2].endAt, businessLocalToEpoch(DATE, '11:00'));
  assert.equal(buckets[2].endAt - buckets[2].startAt, 30 * MS.MINUTE);
});

test('hourlyBuckets: midnight-spanning or malformed ranges return [] (no infinite loop)', () => {
  // close <= open would silently walk into the next day without this guard
  assert.deepEqual(hourlyBuckets({ dateKey: DATE, openTime: '22:00', closeTime: '02:00' }), []);
  assert.deepEqual(hourlyBuckets({ dateKey: DATE, openTime: '09:00', closeTime: '09:00' }), []);
  assert.deepEqual(hourlyBuckets({ dateKey: DATE, openTime: '18:00', closeTime: '08:00' }), []);

  // malformed values must not throw out of a dashboard render
  assert.deepEqual(hourlyBuckets({ dateKey: DATE, openTime: 'nonsense', closeTime: '18:00' }), []);
  assert.deepEqual(hourlyBuckets({ dateKey: DATE, openTime: null, closeTime: undefined }), []);
  assert.deepEqual(hourlyBuckets({ dateKey: DATE, openTime: '25:00', closeTime: '26:00' }), []);
});

test('hourlyBuckets: buckets never cross the business-day boundary', () => {
  const dayStart = businessLocalToEpoch(DATE, '00:00');
  const dayEnd = dayStart + MS.DAY;
  const buckets = hourlyBuckets({ dateKey: DATE, openTime: '00:00', closeTime: '23:00' });

  assert.equal(buckets.length, 23);
  for (const bucket of buckets) {
    assert.ok(bucket.startAt >= dayStart, 'bucket starts on or after the day start');
    assert.ok(bucket.endAt <= dayEnd, 'bucket ends on or before the day end');
    assert.equal(businessDateKey(bucket.startAt), DATE);
  }
});

/* ------------------------------------------------------------ occupancyRate */

test('occupancyRate: null when there is nothing to measure, 0 is a real zero', () => {
  assert.equal(occupancyRate(0, 0), null);
  assert.equal(occupancyRate(5, 0), null);
  assert.equal(occupancyRate(0, -3), null);

  assert.equal(occupancyRate(0, 4), 0); // inventory exists, nothing used
  assert.equal(occupancyRate(2, 4), 0.5);
  assert.equal(occupancyRate(4, 4), 1);
});

test('occupancyRate: rounds to three decimal places and clamps impossible inputs', () => {
  assert.equal(occupancyRate(1, 3), 0.333);
  assert.equal(occupancyRate(2, 3), 0.667);
  assert.equal(occupancyRate(1, 8), 0.125);
  assert.equal(occupancyRate(7, 8), 0.875);

  // an over-count must never produce a rate above 1
  assert.equal(occupancyRate(5, 4), 1);
  assert.equal(occupancyRate(-2, 4), 0);
});

/* ---------------------------------------------------------- summariseSpaces */

test('summariseSpaces: half-open overlap, distinct units, input order preserved', () => {
  const windowStart = businessLocalToEpoch(DATE, '14:00');
  const windowEnd = windowStart + MS.HOUR;

  const spaceRows = [
    { spaceId: 2, code: 'CW', name: 'Coworking', category: 'COWORKING', status: 'PUBLISHED', totalUnits: 3 },
    { spaceId: 1, code: 'MR', name: 'Meeting room', category: 'MEETING_ROOM', status: 'DRAFT', totalUnits: 1 },
  ];
  const occupancyRows = [
    // ends exactly at the window start -> touches, does not overlap
    { spaceId: 2, resourceUnitId: 21, startAt: windowStart - MS.HOUR, endAt: windowStart },
    // overlaps, and the duplicate row for unit 22 must still count once
    { spaceId: 2, resourceUnitId: 22, startAt: windowStart, endAt: windowStart + MS.MINUTE },
    { spaceId: 2, resourceUnitId: 22, startAt: windowStart, endAt: windowEnd },
    // starts before the window end and runs past it -> overlaps
    { spaceId: 2, resourceUnitId: 23, startAt: windowEnd - MS.MINUTE, endAt: windowEnd + MS.HOUR },
    // starts exactly at the window end -> touches, does not overlap
    { spaceId: 1, resourceUnitId: 11, startAt: windowEnd, endAt: windowEnd + MS.HOUR },
    // long before the window
    { spaceId: 1, resourceUnitId: 12, startAt: windowStart - MS.DAY, endAt: windowStart - MS.DAY + 30 * MS.MINUTE },
  ];

  const result = summariseSpaces(spaceRows, occupancyRows, windowStart, windowEnd);

  assert.equal(result.length, 2);
  assert.equal(result[0].spaceId, 2, 'input order is preserved');
  assert.deepEqual(
    result.map((space) => [space.spaceId, space.totalUnits, space.freeUnits, space.occupiedUnits]),
    [
      [2, 3, 1, 2],
      [1, 1, 1, 0],
    ],
  );
});

test('summariseSpaces: occupancy for unknown units is clamped to the unit count', () => {
  const windowStart = businessLocalToEpoch(DATE, '09:00');
  const windowEnd = windowStart + MS.HOUR;
  const result = summariseSpaces(
    [{ spaceId: 7, code: 'X', name: 'One unit', category: 'MEETING_ROOM', status: 'DRAFT', totalUnits: 1 }],
    [
      { spaceId: 7, resourceUnitId: 100, startAt: windowStart, endAt: windowEnd },
      { spaceId: 7, resourceUnitId: 101, startAt: windowStart, endAt: windowEnd },
    ],
    windowStart,
    windowEnd,
  );

  assert.equal(result[0].occupiedUnits, 1);
  assert.equal(result[0].freeUnits, 0);
});

/* ------------------------------------------------------ business-day edges */

test('business day: a 23:00 SLST booking lands on day N, not day N+1', () => {
  const lateAt = businessLocalToEpoch(DATE, '23:00'); // 20:00 UTC on 2026-11-10
  const dayStart = startOfBusinessDay(lateAt);
  const dayEnd = dayStart + MS.DAY;

  assert.equal(businessDateKey(lateAt), DATE);
  assert.equal(dayStart, businessLocalToEpoch(DATE, '00:00'));
  assert.ok(lateAt >= dayStart && lateAt < dayEnd, '23:00 SLST is inside its own business day');
  assert.ok(lateAt < dayEnd, '23:00 SLST must not spill into day N+1');
});

test('business day: the naive UTC-midnight window is not the business day (Date.now() % 86400000 bug)', () => {
  // 01:00 SLST on day N is 22:00 UTC on day N-1: the classic off-by-one case.
  const earlyAt = businessLocalToEpoch(DATE, '01:00');
  const naiveStart = earlyAt - (earlyAt % MS.DAY); // the buggy boundary
  const trueStart = businessLocalToEpoch(businessDateKey(earlyAt), '00:00');

  assert.equal(businessDateKey(earlyAt), DATE);
  assert.equal(trueStart, businessLocalToEpoch(DATE, '00:00'));
  assert.notEqual(naiveStart, trueStart, 'UTC midnight and SLST midnight are different instants');
  assert.ok(earlyAt >= trueStart && earlyAt < trueStart + MS.DAY);

  // The naive window includes the whole previous SLST afternoon ...
  const previousAfternoon = businessLocalToEpoch('2026-11-09', '15:00');
  assert.ok(previousAfternoon >= naiveStart && previousAfternoon < naiveStart + MS.DAY);
  // ... whereas the business-local window correctly excludes it.
  assert.ok(!(previousAfternoon >= trueStart && previousAfternoon < trueStart + MS.DAY));
});

test('business day: hourly buckets keep an 01:00 SLST booking on its own day', () => {
  const buckets = hourlyBuckets({ dateKey: DATE, openTime: '00:00', closeTime: '03:00' });
  assert.equal(buckets.length, 3);

  const bookingStart = businessLocalToEpoch(DATE, '01:00');
  const bookingEnd = businessLocalToEpoch(DATE, '02:00');
  const bucket = buckets.find((b) => b.startAt <= bookingStart && bookingStart < b.endAt);

  assert.ok(bucket, 'a bucket covers 01:00 SLST');
  assert.ok(bookingEnd <= bucket.endAt);
  assert.equal(businessDateKey(bucket.startAt), DATE, 'the bucket is labelled with day N');
  assert.equal(bucket.endAt - bucket.startAt, MS.HOUR);
});
