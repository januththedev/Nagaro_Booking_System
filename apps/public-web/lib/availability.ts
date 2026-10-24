/**
 * Pure date/link helpers for the public availability calendar.
 *
 * They live outside the React component so the Monday-start week logic and the
 * booking-link contract can be tested with plain Node, and so the component
 * never has to re-implement timezone arithmetic.
 *
 * Every displayed instant is pinned to Asia/Colombo (SLST, fixed UTC+05:30).
 */
import type { PublicCalendarSlot } from "./types";

export const SLST_TIME_ZONE = "Asia/Colombo";
const DAY_MS = 86_400_000;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function utcMs(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function keyFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(dateKey: string, days: number): string {
  return keyFromMs(utcMs(dateKey) + days * DAY_MS);
}

/** Monday of the week containing `dateKey` (Mon-start, as the calendar shows). */
export function mondayOf(dateKey: string): string {
  const day = new Date(utcMs(dateKey)).getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  return addDays(dateKey, offset);
}

/** Seven inclusive date keys, Monday through Sunday. */
export function weekDateKeys(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

/** `YYYY-MM-DDTHH:MM` on the SLST wall clock, as epoch ms. */
export function slotEpoch(dateKey: string, clock: string): number {
  if (!isDateKey(dateKey) || !CLOCK.test(clock)) return 0;
  return Date.parse(`${dateKey}T${clock}:00+05:30`);
}

/** `HH:MM` for an epoch instant in Asia/Colombo. */
export function clockInColombo(epochMs: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: SLST_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(epochMs));
}

/** The calendar day an epoch instant belongs to in Asia/Colombo. */
export function dateKeyInColombo(epochMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SLST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochMs));
}

/**
 * The booking link contract: one free hour opens the existing direct-booking
 * form with the date and SLST window prefilled.
 */
export function bookingHref(
  spaceCode: string,
  dateKey: string,
  start: string,
  end: string,
): string {
  const code = encodeURIComponent(spaceCode);
  const safeDate = isDateKey(dateKey) ? dateKey : "";
  const safeStart = CLOCK.test(start) ? start : "";
  const safeEnd = CLOCK.test(end) ? end : "";
  return `/spaces/${code}/book?date=${safeDate}&start=${safeStart}&end=${safeEnd}`;
}

export function slotBookingHref(
  spaceCode: string,
  dateKey: string,
  slot: Pick<PublicCalendarSlot, "startAt" | "endAt"> & Partial<Pick<PublicCalendarSlot, "bookingEndAt">>,
): string {
  return bookingHref(
    spaceCode,
    dateKey,
    clockInColombo(slot.startAt),
    clockInColombo(slot.bookingEndAt ?? slot.endAt),
  );
}

function slstNoon(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00+05:30`);
}

export function formatDateKey(
  dateKey: string,
  localeTag: string,
  options: Intl.DateTimeFormatOptions,
): string {
  if (!isDateKey(dateKey)) return "";
  return new Intl.DateTimeFormat(localeTag, {
    timeZone: SLST_TIME_ZONE,
    ...options,
  }).format(slstNoon(dateKey));
}

/** A compact localized range label, e.g. "6 Oct – 12 Oct 2026". */
export function formatWeekRange(from: string, to: string, localeTag: string): string {
  const start = formatDateKey(from, localeTag, { day: "numeric", month: "short" });
  const end = formatDateKey(to, localeTag, { day: "numeric", month: "short", year: "numeric" });
  return start && end ? `${start} – ${end}` : `${from} – ${to}`;
}
