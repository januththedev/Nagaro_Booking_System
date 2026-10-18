/**
 * Business time-zone correctness: Sri Lanka Standard Time (Asia/Colombo,
 * fixed UTC+05:30, no daylight saving).
 *
 * These tests pin the venue correction. They prove that a Colombo wall clock
 * maps to the right UTC instant, that the displayed business date is derived
 * from that instant, that midnight and half-hour offsets are handled exactly,
 * that the calendar maths never consults the server machine's time zone, and
 * that the dashboard insists on the one business zone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUSINESS_TZ,
  BUSINESS_TZ_OFFSET_MINUTES,
  MS,
  addDays,
  businessDateKey,
  businessDateTimeLabel,
  businessDaySpan,
  businessLocalToEpoch,
  businessTimeLabel,
  intervalsOverlap,
  startOfBusinessDay,
  todayBusinessDate,
} from '../../src/server/domain/time.js';
import { dashboardSummary } from '../../src/server/services/dashboardService.js';

const DATE = '2026-11-10'; // a Tuesday

test('business time zone is Asia/Colombo at a fixed UTC+05:30', () => {
  assert.equal(BUSINESS_TZ, 'Asia/Colombo');
  assert.equal(BUSINESS_TZ_OFFSET_MINUTES, 330);
});

test('a Colombo-local date/time maps to the correct UTC instant', () => {
  // 09:00 SLST = 03:30 UTC the same calendar day.
  assert.equal(businessLocalToEpoch(DATE, '09:00'), Date.UTC(2026, 10, 10, 3, 30));
  // 18:30 SLST = 13:00 UTC.
  assert.equal(businessLocalToEpoch(DATE, '18:30'), Date.UTC(2026, 10, 10, 13, 0));
  // A non-half-hour clock is exact too: 08:15 SLST = 02:45 UTC.
  assert.equal(businessLocalToEpoch(DATE, '08:15'), Date.UTC(2026, 10, 10, 2, 45));
});

test('the displayed business date/time matches that instant', () => {
  const instant = Date.UTC(2026, 10, 10, 3, 30); // 09:00 SLST
  assert.equal(businessDateKey(instant), DATE);
  assert.equal(businessTimeLabel(instant), '09:00');
  assert.equal(businessDateTimeLabel(instant), '2026-11-10 09:00');
});

test('midnight and the half-hour offset are handled exactly', () => {
  const dayStart = businessLocalToEpoch(DATE, '00:00');
  // Midnight in Colombo is 18:30 UTC on the *previous* calendar day.
  assert.equal(dayStart, Date.UTC(2026, 10, 9, 18, 30));
  assert.equal(businessDateKey(dayStart), DATE);
  assert.equal(businessTimeLabel(dayStart), '00:00');

  // One millisecond before the boundary is still the previous business day.
  assert.equal(businessDateKey(dayStart - 1), '2026-11-09');

  // 23:59 stays on its own business day; the next midnight starts day N+1.
  const late = businessLocalToEpoch(DATE, '23:59');
  assert.equal(businessDateKey(late), DATE);
  assert.equal(startOfBusinessDay(dayStart + MS.DAY), businessLocalToEpoch('2026-11-11', '00:00'));
  assert.equal(businessLocalToEpoch('2026-11-11', '00:00'), dayStart + MS.DAY);
});

test('a reservation crossing midnight spans two business days', () => {
  const start = businessLocalToEpoch(DATE, '23:00');
  const end = businessLocalToEpoch('2026-11-11', '01:00');
  assert.equal(businessDateKey(start), DATE);
  assert.equal(businessDateKey(end), '2026-11-11');
  assert.equal(businessDaySpan(start, end), 2);
  // Half-open: [23:00, next-day 00:00) lies entirely within day N.
  assert.equal(businessDaySpan(start, businessLocalToEpoch('2026-11-11', '00:00')), 1);
});

test('calendar-day maths is independent of the server machine time zone', () => {
  // Reference values computed entirely from the fixed business offset.
  const expectedEpoch = Date.UTC(2026, 10, 10, 3, 30);
  const expectedKey = '2026-11-10';
  const original = process.env.TZ;
  try {
    for (const tz of ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'Asia/Kolkata', 'Europe/London']) {
      process.env.TZ = tz;
      assert.equal(businessLocalToEpoch(DATE, '09:00'), expectedEpoch, `epoch stable under TZ=${tz}`);
      assert.equal(businessDateKey(expectedEpoch), expectedKey, `date key stable under TZ=${tz}`);
      assert.equal(startOfBusinessDay(expectedEpoch), Date.UTC(2026, 10, 9, 18, 30), `day start stable under TZ=${tz}`);
      assert.equal(businessDaySpan(businessLocalToEpoch(DATE, '23:00'), businessLocalToEpoch('2026-11-11', '01:00')), 2);
    }
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});

test('todayBusinessDate and addDays agree with the business calendar', () => {
  const instant = businessLocalToEpoch(DATE, '12:00');
  assert.equal(todayBusinessDate(instant), DATE);
  assert.equal(businessDateKey(addDays(instant, 1)), '2026-11-11');
  assert.equal(businessDateKey(addDays(instant, -1)), '2026-11-09');
});

test('dashboard calculations refuse any zone other than Asia/Colombo', () => {
  assert.throws(
    () => dashboardSummary({}, { timeZone: 'Africa/Addis_Ababa' }),
    /Asia\/Colombo/,
  );
  assert.throws(
    () => dashboardSummary({}, { timeZone: 'UTC' }),
    /business time zone/,
  );
});

test('the half-open overlap guarantee is unchanged by the offset', () => {
  // Touching endpoints do NOT overlap; a one-millisecond intersection does.
  assert.equal(intervalsOverlap(0, 60, 60, 120), false);
  assert.equal(intervalsOverlap(0, 60, 30, 90), true);
  assert.equal(intervalsOverlap(30, 90, 0, 60), true);
  assert.equal(intervalsOverlap(60, 120, 0, 60), false);

  const start = businessLocalToEpoch(DATE, '09:00');
  const end = businessLocalToEpoch(DATE, '10:00');
  const adjacent = businessLocalToEpoch(DATE, '10:00');
  assert.equal(intervalsOverlap(start, end, adjacent, businessLocalToEpoch(DATE, '11:00')), false);
});
