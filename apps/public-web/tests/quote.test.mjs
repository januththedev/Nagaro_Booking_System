/**
 * Parity between the browser's settlement estimate and the booking engine.
 *
 * The checkout shows an "estimated settlement" before the visitor submits, and
 * the engine then records its own tariff. This test imports the real server
 * pricing module and compares it with the client mirror, so a rule can never
 * drift in one place only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  billingQuantityFor as clientQuantityFor,
  businessDaySpan as clientDaySpan,
  estimateBookingQuote,
  slstEpoch,
} from '../lib/quote.ts';
import { billingQuantityFor as serverQuantityFor, quote } from '../../../src/server/services/pricingService.js';
import { businessDaySpan as serverDaySpan } from '../../../src/server/domain/time.js';

const SLST = 330 * 60_000;
const at = (iso) => Date.parse(iso);

function clientSpace({ category = 'MEETING_ROOM', pricingUnit = 'HOUR', rates }) {
  return {
    category,
    pricingUnit,
    rateList: rates.map(({ unit, amountCents, isDefault = false }) => ({
      unit,
      unitLabel: `per ${unit.toLowerCase()}`,
      amountCents,
      amountLabel: `LKR ${amountCents / 100}`,
      isDefault,
    })),
  };
}

function serverQuote({ pricingUnit, rates, startAt, endAt, unitCount = 1 }) {
  return quote({
    space: { pricing_unit: pricingUnit, currency: 'LKR' },
    rates: new Map(rates.map(({ unit, amountCents }) => [unit, amountCents])),
    startAt,
    endAt,
    unitCount,
  });
}

test('SLST conversion is a fixed UTC+05:30 with no daylight saving', () => {
  assert.equal(slstEpoch('2026-10-21', '09:00'), Date.UTC(2026, 9, 21, 3, 30));
  assert.equal(slstEpoch('2026-06-21', '09:00'), Date.UTC(2026, 5, 21, 3, 30));
  assert.ok(Number.isNaN(slstEpoch('not-a-date', '09:00')));
});

test('billing quantities match the engine for every unit and window shape', () => {
  const windows = [
    ['2026-11-04T03:30:00Z', '2026-11-04T04:00:00Z'], // 30 minutes
    ['2026-11-04T03:30:00Z', '2026-11-04T04:30:00Z'], // 60 minutes
    ['2026-11-04T03:30:00Z', '2026-11-04T04:31:00Z'], // 61 minutes
    ['2026-11-04T03:30:00Z', '2026-11-04T07:30:00Z'], // 4 hours
    ['2026-11-04T03:30:00Z', '2026-11-04T08:31:00Z'], // 5h 1m
    ['2026-11-04T17:30:00Z', '2026-11-04T21:30:00Z'], // 19:00 -> 23:00 in Colombo
    ['2026-11-04T18:00:00Z', '2026-11-04T19:30:00Z'], // 23:30 -> 01:00 across midnight
    ['2026-11-04T03:30:00Z', '2026-11-05T05:30:00Z'], // 26 hours
    ['2026-11-04T03:30:00Z', '2026-11-11T04:30:00Z'], // 7 days + 1h
    ['2026-11-04T03:30:00Z', '2026-12-05T04:30:00Z'], // 31 days + 1h
  ];
  for (const unit of ['HOUR', 'HALF_DAY', 'DAY', 'WEEK', 'MONTH']) {
    for (const [startIso, endIso] of windows) {
      const startAt = at(startIso);
      const endAt = at(endIso);
      assert.equal(
        clientQuantityFor(unit, startAt, endAt),
        serverQuantityFor({ unit, startAt, endAt }),
        `${unit} quantity disagreed for ${startIso} -> ${endIso}`,
      );
    }
  }
});

test('the Colombo business-day span matches the engine exactly', () => {
  const instants = [
    [at('2026-11-04T00:00:00Z'), at('2026-11-04T00:00:01Z')],
    [at('2026-11-04T18:29:00Z'), at('2026-11-04T18:31:00Z')], // straddles the SLST midnight
    [at('2026-11-04T18:30:00Z'), at('2026-11-05T18:30:00Z')], // exactly one SLST day later
    [at('2026-11-04T18:00:00Z'), at('2026-11-04T18:00:00Z')],
  ];
  for (const [startAt, endAt] of instants) {
    assert.equal(clientDaySpan(startAt, endAt), serverDaySpan(startAt, endAt), `${startAt} -> ${endAt}`);
  }
});

test('a day-priced venue is never estimated at its monthly rate', () => {
  // The demo catalogue prices co-working desks per DAY, per WEEK and per MONTH,
  // and flags the monthly row as the default rate. The engine still bills the
  // space's own pricing unit, so the estimate must follow the engine.
  const space = clientSpace({
    category: 'COWORKING',
    pricingUnit: 'DAY',
    rates: [
      { unit: 'DAY', amountCents: 60_000 },
      { unit: 'WEEK', amountCents: 300_000 },
      { unit: 'MONTH', amountCents: 1_050_000, isDefault: true },
    ],
  });
  const startAt = slstEpoch('2026-11-18', '09:00');
  const endAt = slstEpoch('2026-11-18', '13:00');

  const estimate = estimateBookingQuote(space, '2026-11-18', '09:00', '13:00', 1);
  const engine = serverQuote({
    pricingUnit: 'DAY',
    rates: [{ unit: 'DAY', amountCents: 60_000 }],
    startAt,
    endAt,
  });

  assert.equal(estimate?.unit, 'DAY');
  assert.equal(estimate?.quantity, 1);
  assert.equal(estimate?.totalCents, engine.totalCents);
  assert.equal(estimate?.totalCents, 60_000);
});

test('the estimate equals the booked tariff across units, windows and desk counts', () => {
  const cases = [
    { pricingUnit: 'HOUR', rates: [{ unit: 'HOUR', amountCents: 950_000 }], start: '09:00', end: '11:30' },
    { pricingUnit: 'HALF_DAY', rates: [{ unit: 'HALF_DAY', amountCents: 3_200_000 }], start: '09:00', end: '13:00' },
    { pricingUnit: 'DAY', rates: [{ unit: 'DAY', amountCents: 5_600_000 }], start: '08:00', end: '18:00' },
    { pricingUnit: 'WEEK', rates: [{ unit: 'WEEK', amountCents: 22_500_000 }], start: '08:00', end: '18:00' },
    { pricingUnit: 'MONTH', rates: [{ unit: 'MONTH', amountCents: 80_000_000 }], start: '08:00', end: '18:00' },
  ];

  for (const billing of cases) {
    for (const desks of [1, 3]) {
      const space = clientSpace({
        category: desks > 1 ? 'COWORKING' : 'MEETING_ROOM',
        pricingUnit: billing.pricingUnit,
        rates: billing.rates,
      });
      const date = '2026-12-09';
      const estimate = estimateBookingQuote(space, date, billing.start, billing.end, desks);
      const engine = serverQuote({
        pricingUnit: billing.pricingUnit,
        rates: billing.rates,
        startAt: slstEpoch(date, billing.start),
        endAt: slstEpoch(date, billing.end),
        unitCount: desks > 1 ? desks : 1,
      });

      assert.ok(estimate?.validWindow, `${billing.pricingUnit} must produce a valid window`);
      assert.equal(estimate.unit, billing.pricingUnit);
      assert.equal(estimate.quantity, engine.billingQuantity, `${billing.pricingUnit} quantity`);
      assert.equal(estimate.totalCents, engine.totalCents, `${billing.pricingUnit} total with ${desks} desks`);
    }
  }
});

test('degraded inputs stay inert instead of inventing a price', () => {
  const space = clientSpace({ pricingUnit: 'HOUR', rates: [{ unit: 'HOUR', amountCents: 950_000 }] });

  assert.equal(estimateBookingQuote(undefined, '2026-12-09', '09:00', '11:00', 1), null);
  assert.equal(estimateBookingQuote(space, '', '09:00', '11:00', 1), null);
  assert.equal(estimateBookingQuote(space, '2026-12-09', '', '11:00', 1), null);
  assert.equal(estimateBookingQuote(space, '2026-12-09', '09:00', '', 1), null);

  const backwards = estimateBookingQuote(space, '2026-12-09', '11:00', '09:00', 1);
  assert.equal(backwards?.validWindow, false);
  assert.equal(backwards?.totalCents, 0);

  const zeroLength = estimateBookingQuote(space, '2026-12-09', '09:00', '09:00', 1);
  assert.equal(zeroLength?.validWindow, false);

  const unpriced = estimateBookingQuote({ ...space, rateList: [] }, '2026-12-09', '09:00', '11:00', 1);
  assert.equal(unpriced, null);
});

test('the rate the estimate bills is the one the engine bills', () => {
  const space = clientSpace({
    pricingUnit: 'HALF_DAY',
    rates: [
      { unit: 'HOUR', amountCents: 100_000, isDefault: true },
      { unit: 'HALF_DAY', amountCents: 300_000 },
    ],
  });
  const estimate = estimateBookingQuote(space, '2026-12-09', '09:00', '13:00', 1);
  assert.equal(estimate?.unit, 'HALF_DAY');
  assert.equal(estimate?.rateCents, 300_000);
  assert.equal(estimate?.totalCents, 300_000);
});
