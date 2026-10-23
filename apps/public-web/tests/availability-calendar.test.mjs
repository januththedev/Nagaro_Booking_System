/**
 * Public availability calendar contract.
 *
 * The React component cannot be imported by plain Node (no JSX transform in
 * this test runner), so the executable logic lives in lib/availability.ts and
 * the component is guarded by focused source assertions. The i18n checks cover
 * key parity for the new surface in all three public languages.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addDays,
  bookingHref,
  clockInColombo,
  formatWeekRange,
  mondayOf,
  slotBookingHref,
  weekDateKeys,
} from "../lib/availability.ts";
import { LOCALES, dictionaries } from "../lib/i18n.ts";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readApp = (relative) => readFile(resolve(appRoot, relative), "utf8");

const SLOT = {
  startAt: Date.parse("2031-03-10T09:00:00+05:30"),
  endAt: Date.parse("2031-03-10T10:00:00+05:30"),
};

test("the availability dictionary has identical keys and placeholders in every language", () => {
  const english = dictionaries.en.availability;
  const englishKeys = Object.keys(english).sort();
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  for (const locale of LOCALES) {
    const section = dictionaries[locale].availability;
    assert.deepEqual(Object.keys(section).sort(), englishKeys, `${locale} availability keys diverge`);
    for (const key of englishKeys) {
      assert.ok(section[key].trim().length > 0, `${locale}.availability.${key} is empty`);
      assert.deepEqual(
        placeholders(section[key]),
        placeholders(english[key]),
        `${locale}.availability.${key} must use the same placeholders`,
      );
    }
    assert.ok(dictionaries[locale].chrome.availability.trim().length > 0);
  }

  assert.match(english.caveat, /not held until checkout/i);
  assert.match(english.timezoneNote, /Sri Lanka Standard Time/);
  assert.equal(english.free, "Free");
  assert.equal(english.booked, "Booked");
  assert.doesNotMatch(
    dictionaries.ta.availability.free,
    /இலவச/,
    "Tamil must say available, not free of charge",
  );
});

test("the week starts on Monday and contains seven inclusive days", () => {
  assert.equal(mondayOf("2026-10-22"), "2026-10-19", "Thursday belongs to the Monday 19 October week");
  assert.equal(mondayOf("2026-10-25"), "2026-10-19", "Sunday still belongs to the same Monday-start week");
  assert.equal(mondayOf("2026-10-19"), "2026-10-19", "Monday is its own week start");
  assert.deepEqual(weekDateKeys("2026-10-19"), [
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
    "2026-10-24",
    "2026-10-25",
  ]);
  assert.equal(addDays("2026-10-25", 7), "2026-11-01");
});

test("a free slot links to the existing direct-booking form with its date and window", () => {
  assert.equal(
    bookingHref("TRC-MR-01", "2031-03-10", "09:00", "10:00"),
    "/spaces/TRC-MR-01/book?date=2031-03-10&start=09:00&end=10:00",
  );
  assert.equal(
    slotBookingHref("TRC-MR-01", "2031-03-10", SLOT),
    "/spaces/TRC-MR-01/book?date=2031-03-10&start=09:00&end=10:00",
  );
  assert.equal(clockInColombo(SLOT.startAt), "09:00", "epoch instants render on the SLST wall clock");
  assert.equal(clockInColombo(SLOT.endAt), "10:00");
  assert.equal(
    bookingHref("A/B", "2031-03-10", "09:00", "10:00"),
    "/spaces/A%2FB/book?date=2031-03-10&start=09:00&end=10:00",
  );
  assert.equal(
    bookingHref("TRC-01", "not-a-date", "9:00", "10:00"),
    "/spaces/TRC-01/book?date=&start=&end=10:00",
    "each field is sanitised independently: valid clock values survive",
  );
});

test("the range label is localized and pinned to SLST", () => {
  const label = formatWeekRange("2026-10-19", "2026-10-25", "en-LK");
  assert.match(label, /19/);
  assert.match(label, /25/);
  assert.match(label, /2026/);
});

test("the page renders the calendar and the header/footer expose the route", async () => {
  const page = await readApp("app/availability/page.tsx");
  assert.match(page, /<AvailabilityCalendar/);
  assert.match(page, /isoDateInColombo\(0\)/);
  assert.match(page, /getAvailabilityCalendar/);
  assert.match(page, /initialData=\{initialData\}/, "the first calendar view is server rendered");

  const api = await readApp("lib/api.ts");
  assert.match(api, /next: \{ revalidate: 30 \}/, "server calendar requests share a short cache");

  const shell = await readApp("components/PublicShell.tsx");
  const links = shell.match(/href="\/availability"/g) ?? [];
  assert.ok(links.length >= 2, "the header and footer each need an availability link");
  assert.match(shell, /t\.chrome\.availability/);
});

test("the calendar fetches the public range API and offers desktop and mobile views", async () => {
  const calendar = await readApp("components/AvailabilityCalendar.tsx");

  assert.match(calendar, /clientApiPath\(`\/api\/public\/availability\/calendar\?/);
  assert.match(calendar, /new URLSearchParams\(\{ from, to \}\)/);
  assert.match(calendar, /slotBookingHref/);
  assert.match(calendar, /weekDateKeys/);
  assert.match(calendar, /hidden space-y-8 lg:block/, "desktop renders the week grid first");
  assert.match(calendar, /lg:hidden/, "mobile and tablet get the day-by-day agenda");
  assert.match(calendar, /t\.availability\.caveat/);
  assert.match(calendar, /t\.availability\.desksFree/, "co-working cells show free desk counts");
  assert.match(calendar, /aria-label=\{t\.availability\.weekViewLabel\}/);
  assert.match(calendar, /role="alert"/);
  assert.match(calendar, /t\.availability\.prevWeek/);
  assert.match(calendar, /t\.availability\.nextWeek/);
  assert.match(calendar, /t\.availability\.today/);
  assert.match(calendar, /useLiveRefresh/);
  assert.match(calendar, /intervalMs: 30_000/, "the open calendar refreshes without a page reload");
});

test("the unified form reads prefill parameters without changing its submit contract", async () => {
  const form = await readApp("components/UnifiedRequestForm.tsx");

  assert.match(form, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(form, /params\.get\("date"\)/);
  assert.match(form, /params\.get\("start"\)/);
  assert.match(form, /params\.get\("end"\)/);
  assert.match(form, /params\.get\("unit_count"\)/);
  assert.match(form, /name="date"/);
  assert.match(form, /name="start_time"/);
  assert.match(form, /name="end_time"/);
  assert.match(form, /name="unit_count"/);
  assert.match(form, /fetch\(clientApiPath\('\/api\/public\/bookings'\)/, "the atomic booking endpoint is untouched");
});
