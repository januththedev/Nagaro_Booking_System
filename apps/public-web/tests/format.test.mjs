/**
 * Presentation helpers shared by every public page. Prices are integer cents in
 * LKR and every customer-facing time is rendered in Asia/Colombo, so both
 * helpers are contract, not decoration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoDateInColombo, formatDateTime, formatMoney, spaceMeta } from '../lib/format.ts';

test('money preserves cents and handles invalid numeric inputs', () => {
  assert.match(formatMoney(125_000), /^LKR[\s\u00a0]?1,250$/);
  assert.match(formatMoney(0), /^LKR[\s\u00a0]?0$/);
  assert.match(formatMoney(Number.NaN), /^LKR[\s\u00a0]?0$/);
  assert.match(formatMoney(undefined), /^LKR[\s\u00a0]?0$/);
  assert.match(formatMoney(987_654_321), /^LKR[\s\u00a0]?9,876,543\.21$/);
});

test('timestamps are always shown in Colombo time (UTC+05:30)', () => {
  // 04:30 UTC is 10:00 in Colombo.
  const text = formatDateTime(Date.UTC(2026, 0, 15, 4, 30));
  assert.match(text, /January 15, 2026/);
  assert.match(text, /10:00/);
  assert.doesNotMatch(text, /04:30/);
});

test('date fields are Colombo dates, not UTC dates', () => {
  // 19:00 UTC is already the next day in Colombo.
  const colomboToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  assert.equal(isoDateInColombo(0), colomboToday);
  assert.match(isoDateInColombo(1), /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(isoDateInColombo(1), isoDateInColombo(0));

  const days = [isoDateInColombo(0), isoDateInColombo(3), isoDateInColombo(30)].map((value) => Date.parse(`${value}T00:00:00Z`));
  assert.deepEqual(days, [...days].sort((a, b) => a - b), 'later offsets must produce later dates');
});

test('space metadata degrades gracefully and never prints empty separators', () => {
  assert.equal(spaceMeta({}), 'TRACE Expert City, Colombo');
  assert.equal(spaceMeta({ location: 'Bay 07' }), 'Bay 07');
  assert.equal(
    spaceMeta({ capacity: 12, openTime: '08:00', closeTime: '18:00' }),
    'TRACE Expert City, Colombo · Up to 12 people · 08:00–18:00 SLST',
  );
  assert.equal(spaceMeta({ location: null, capacity: null }), 'TRACE Expert City, Colombo');
});
