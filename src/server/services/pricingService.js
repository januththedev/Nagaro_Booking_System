/**
 * Pricing.
 *
 * A space declares a set of rates by unit (HOUR / HALF_DAY / DAY / WEEK /
 * MONTH). A reservation records the unit actually billed, the derived
 * quantity, the unit rate, and the resulting total - so historical bookings
 * keep their original price even if the space's rates later change.
 *
 * Deterministic quantity rules (documented in DATA_MODEL.md):
 *   HOUR      -> ceil(duration_minutes / 60), minimum 1
 *   HALF_DAY  -> ceil(duration_minutes / 240), minimum 1   (4h = one half day)
 *   DAY       -> number of business-local calendar dates the interval touches
 *   WEEK      -> ceil(day_span / 7)
 *   MONTH     -> ceil(day_span / 30)
 *
 * Total = unit_rate x quantity x unit_count (desks), where unit_count is 1
 * for exclusive spaces.
 */
import { PRICING_UNIT } from '../domain/constants.js';
import { validationError } from '../domain/errors.js';
import { businessDaySpan } from '../domain/time.js';

export function billingQuantityFor({ unit, startAt, endAt, billingQuantityOverride = null }) {
  if (billingQuantityOverride !== null && billingQuantityOverride !== undefined && billingQuantityOverride !== '') {
    const n = Number(billingQuantityOverride);
    if (!Number.isInteger(n) || n < 1) {
      throw validationError('Billing quantity must be a whole number of at least 1.', { field: 'billing_quantity' });
    }
    return n;
  }
  const minutes = Math.round((endAt - startAt) / 60000);
  switch (unit) {
    case PRICING_UNIT.HOUR:
      return Math.max(1, Math.ceil(minutes / 60));
    case PRICING_UNIT.HALF_DAY:
      return Math.max(1, Math.ceil(minutes / 240));
    case PRICING_UNIT.DAY:
      return businessDaySpan(startAt, endAt);
    case PRICING_UNIT.WEEK:
      return Math.max(1, Math.ceil(businessDaySpan(startAt, endAt) / 7));
    case PRICING_UNIT.MONTH:
      return Math.max(1, Math.ceil(businessDaySpan(startAt, endAt) / 30));
    default:
      throw validationError(`Unsupported billing unit: ${unit}`, { field: 'billing_unit' });
  }
}

export function quote({ space, rates, startAt, endAt, unitCount = 1, billingUnit = null, billingQuantityOverride = null }) {
  const unit = billingUnit || space.pricing_unit;
  const rateTable = rates instanceof Map ? rates : new Map(Object.entries(rates ?? {}));
  const rateCents = rateTable.get(unit);
  if (rateCents === undefined || rateCents === null) {
    throw validationError(`No ${unit.toLowerCase().replace('_', ' ')} rate is configured for this space.`, { field: 'billing_unit' });
  }
  const quantity = billingQuantityFor({ unit, startAt, endAt, billingQuantityOverride });
  const totalCents = rateCents * quantity * Math.max(1, unitCount);
  if (!Number.isSafeInteger(totalCents) || totalCents > 1e12) {
    throw validationError('The computed total is out of range. Check the configured rates.', { field: 'rate' });
  }
  return { billingUnit: unit, billingQuantity: quantity, rateCents, totalCents, currency: space.currency };
}

export function loadRates(db, spaceId) {
  const rows = db.prepare('SELECT unit, amount_cents FROM space_rate WHERE space_id = ?').all(spaceId);
  return new Map(rows.map((r) => [r.unit, r.amount_cents]));
}

export function formatMoney(cents, currency = 'ETB') {
  const amount = (Number(cents) || 0) / 100;
  const formatted = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency} ${formatted}`;
}

export function formatMoneyCompact(cents, currency = 'ETB') {
  const amount = (Number(cents) || 0) / 100;
  if (Number.isInteger(amount)) return `${currency} ${amount.toLocaleString('en-US')}`;
  return `${currency} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
