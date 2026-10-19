import type { PublicRate, PublicSpace } from "./types";

/**
 * Client-side settlement estimate.
 *
 * The booking engine bills a reservation at the space's declared pricing unit
 * (`space.pricing_unit` -> `pricingUnit`) and derives the quantity from the
 * window, so this module mirrors `src/server/services/pricingService.js` rule
 * for rule instead of guessing from the cheapest or flagged rate row. The
 * parity is asserted by `tests/quote.test.mjs` against the real server module.
 */
export type BookingQuote = {
  validWindow: boolean;
  durationMinutes: number;
  unit: string;
  unitLabel: string;
  quantity: number;
  rateCents: number;
  totalCents: number;
};

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Sri Lanka Standard Time is a fixed UTC+05:30 with no daylight saving. */
const SLST_OFFSET_MINUTES = 330;

export const SLST_OFFSET = "+05:30";

export function slstEpoch(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00${SLST_OFFSET}`);
}

/** Index of the SLST calendar date an instant falls on. */
export function colomboDayIndex(epochMs: number): number {
  return Math.floor((epochMs + SLST_OFFSET_MINUTES * MINUTE_MS) / DAY_MS);
}

/** Distinct SLST calendar dates touched by `[startAt, endAt)`; mirrors the server. */
export function businessDaySpan(startAt: number, endAt: number): number {
  const startDay = colomboDayIndex(startAt);
  const endDay = colomboDayIndex(endAt === startAt ? endAt : endAt - 1);
  return Math.max(1, endDay - startDay + 1);
}

export function billingQuantityFor(unit: string, startAt: number, endAt: number): number {
  const minutes = Math.round((endAt - startAt) / MINUTE_MS);
  switch (unit) {
    case "HOUR":
      return Math.max(1, Math.ceil(minutes / 60));
    case "HALF_DAY":
      return Math.max(1, Math.ceil(minutes / 240));
    case "DAY":
      return businessDaySpan(startAt, endAt);
    case "WEEK":
      return Math.max(1, Math.ceil(businessDaySpan(startAt, endAt) / 7));
    case "MONTH":
      return Math.max(1, Math.ceil(businessDaySpan(startAt, endAt) / 30));
    default:
      return 1;
  }
}

/**
 * The rate the engine will bill: the space's own pricing unit, then the rate
 * row flagged as default, then the first published rate.
 */
export function rateFor(space: Pick<PublicSpace, "pricingUnit" | "rateList">): PublicRate | null {
  const rates = Array.isArray(space.rateList) ? space.rateList : [];
  if (rates.length === 0) return null;
  return rates.find((rate) => rate.unit === space.pricingUnit)
    ?? rates.find((rate) => rate.isDefault)
    ?? rates[0];
}

function invalidQuote(unitLabel = ""): BookingQuote {
  return { validWindow: false, durationMinutes: 0, unit: "", unitLabel, quantity: 0, rateCents: 0, totalCents: 0 };
}

export function estimateBookingQuote(
  space: PublicSpace | undefined | null,
  date: string,
  startTime: string,
  endTime: string,
  desks: number,
): BookingQuote | null {
  if (!space || !date || !startTime || !endTime) return null;
  const startAt = slstEpoch(date, startTime);
  const endAt = slstEpoch(date, endTime);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return invalidQuote();

  const rate = rateFor(space);
  if (!rate) return null;

  const quantity = billingQuantityFor(rate.unit, startAt, endAt);
  const unitCount = space.category === "COWORKING" ? Math.max(1, Math.trunc(desks) || 1) : 1;
  return {
    validWindow: true,
    durationMinutes: Math.round((endAt - startAt) / MINUTE_MS),
    unit: rate.unit,
    unitLabel: rate.unitLabel,
    quantity,
    rateCents: rate.amountCents,
    totalCents: rate.amountCents * quantity * unitCount,
  };
}
