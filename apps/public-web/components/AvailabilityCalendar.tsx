"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { clientApiPath } from "../lib/api";
import {
  addDays,
  clockInColombo,
  formatDateKey,
  formatWeekRange,
  mondayOf,
  slotBookingHref,
  weekDateKeys,
} from "../lib/availability";
import { BCP47, format } from "../lib/i18n";
import type {
  PublicCalendarResponse,
  PublicCalendarSlot,
  PublicCalendarSpace,
  PublicCalendarSpaceDay,
} from "../lib/types";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { useLocale, useT } from "./I18nProvider";

type LoadState = "loading" | "ready" | "error";

function findSpaceDay(
  data: PublicCalendarResponse | null,
  dateKey: string,
  spaceCode: string,
): PublicCalendarSpaceDay | null {
  const day = data?.days.find((item) => item.dateKey === dateKey);
  return day?.spaces.find((item) => item.spaceCode === spaceCode) ?? null;
}

export function AvailabilityCalendar({
  initialDateKey,
  initialData,
}: {
  initialDateKey: string;
  initialData: PublicCalendarResponse | null;
}) {
  const t = useT();
  const locale = useLocale();
  const localeTag = BCP47[locale];

  const [weekStart, setWeekStart] = useState(() => mondayOf(initialDateKey));
  const [selectedSpace, setSelectedSpace] = useState("");
  const [data, setData] = useState<PublicCalendarResponse | null>(initialData);
  const [loadState, setLoadState] = useState<LoadState>(initialData ? "ready" : "loading");
  const [reloadToken, setReloadToken] = useState(0);
  const usedServerData = useRef(false);

  const weekDates = useMemo(() => weekDateKeys(weekStart), [weekStart]);
  const from = weekDates[0];
  const to = weekDates[6];

  useEffect(() => {
    if (!usedServerData.current && data?.from === from && data?.to === to) {
      usedServerData.current = true;
      return;
    }
    const controller = new AbortController();
    setLoadState("loading");
    const query = new URLSearchParams({ from, to });
    fetch(clientApiPath(`/api/public/availability/calendar?${query.toString()}`), {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as PublicCalendarResponse | null;
        if (!response.ok || !body || !Array.isArray(body.days)) {
          throw new Error("calendar unavailable");
        }
        setData(body);
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setData(null);
        setLoadState("error");
      });
    return () => controller.abort();
  }, [from, to, reloadToken]);

  useLiveRefresh(
    async () => setReloadToken((token) => token + 1),
    { intervalMs: 30_000 },
  );

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("space");
    if (code) setSelectedSpace(code);
  }, []);

  useEffect(() => {
    if (selectedSpace && data && !data.spaces.some((space) => space.code === selectedSpace)) {
      setSelectedSpace("");
    }
  }, [data, selectedSpace]);

  const visibleSpaces = useMemo(() => {
    const spaces = data?.spaces ?? [];
    return selectedSpace ? spaces.filter((space) => space.code === selectedSpace) : spaces;
  }, [data, selectedSpace]);

  const categoryLabel = (space: PublicCalendarSpace): string => {
    if (space.category === "COWORKING") return t.catalogue.catCoworking;
    if (space.category === "AUDITORIUM") return t.catalogue.catAuditorium;
    return t.catalogue.catMeeting;
  };

  const inventoryLabel = (space: PublicCalendarSpace): string =>
    space.category === "COWORKING"
      ? format(t.availability.desksTotal, { n: space.totalUnits })
      : t.availability.oneUnit;

  const goToWeek = (next: string) => {
    setWeekStart(mondayOf(next));
  };

  const freeSlotLink = (
    space: PublicCalendarSpace,
    dateKey: string,
    slot: PublicCalendarSlot,
    className: string,
    showDesks: boolean,
  ) => {
    const start = clockInColombo(slot.startAt);
    const end = clockInColombo(slot.bookingEndAt ?? slot.endAt);
    const dateLabel = formatDateKey(dateKey, localeTag, {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    const label = format(t.availability.freeSlotAria, {
      space: space.name,
      date: dateLabel,
      start,
      end,
    });
    return (
      <Link
        key={`${space.code}-${dateKey}-${slot.startAt}`}
        href={slotBookingHref(space.code, dateKey, slot)}
        aria-label={label}
        className={className}
      >
        <span className="font-mono text-[0.62rem] uppercase tracking-[0.08em]">
          {start}–{end}
        </span>
        {showDesks ? (
          <span className="text-[0.62rem] leading-tight">
            {format(t.availability.desksFree, {
              free: slot.bookingFreeUnits,
              total: slot.totalUnits,
            })}
          </span>
        ) : null}
      </Link>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 pt-10 sm:pt-14 pb-16">
      <header className="pb-8 hairline-b grid grid-cols-1 lg:grid-cols-12 gap-5 lg:gap-10 items-end">
        <div className="lg:col-span-8 flex flex-col gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--brick)]">
            {t.availability.eyebrow}
          </p>
          <h1 className="font-display text-4xl sm:text-6xl text-[var(--ink)] max-w-[14ch]">
            {t.availability.title}
          </h1>
        </div>
        <p className="lg:col-span-4 text-base text-[var(--graphite)] max-w-xl lg:pb-1">
          {t.availability.intro}
        </p>
      </header>

      <section aria-label={t.availability.weekViewLabel} className="pt-8">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex flex-wrap items-end gap-3">
            <div aria-label={t.availability.calendarNavLabel} className="flex items-center gap-2" role="group">
              <button
                type="button"
                onClick={() => setWeekStart((current) => addDays(current, -7))}
                className="inline-flex min-h-[2.6rem] items-center justify-center rounded-md border border-[var(--rule-strong)] bg-[var(--paper-card)] px-3 font-mono text-[0.7rem] uppercase tracking-[0.1em] text-[var(--graphite)] transition-colors hover:text-[var(--ink)]"
                aria-label={t.availability.prevWeek}
              >
                ←
              </button>
              <button
                type="button"
                onClick={() => goToWeek(initialDateKey)}
                aria-pressed={weekStart === mondayOf(initialDateKey)}
                className="inline-flex min-h-[2.6rem] items-center justify-center rounded-md border border-[var(--ink)] bg-[var(--ink)] px-4 font-mono text-[0.7rem] uppercase tracking-[0.1em] text-[var(--bone)] transition-colors hover:bg-[var(--oxidized)]"
              >
                {t.availability.today}
              </button>
              <button
                type="button"
                onClick={() => setWeekStart((current) => addDays(current, 7))}
                className="inline-flex min-h-[2.6rem] items-center justify-center rounded-md border border-[var(--rule-strong)] bg-[var(--paper-card)] px-3 font-mono text-[0.7rem] uppercase tracking-[0.1em] text-[var(--graphite)] transition-colors hover:text-[var(--ink)]"
                aria-label={t.availability.nextWeek}
              >
                →
              </button>
            </div>

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[0.65rem] uppercase tracking-[0.12em]">{t.status.dateLabel}</span>
              <input type="date" value={weekStart} onChange={(event) => { if (event.target.value) goToWeek(event.target.value); }} className="field-input" />
            </label>
            <label className="flex min-w-[13rem] flex-col gap-1">
              <span className="font-mono text-[0.65rem] uppercase tracking-[0.12em] text-[var(--graphite)]">
                {t.availability.spaceFilter}
              </span>
              <select
                value={selectedSpace}
                onChange={(event) => setSelectedSpace(event.target.value)}
                className="field-input"
              >
                <option value="">{t.availability.allSpaces}</option>
                {(data?.spaces ?? []).map((space) => (
                  <option key={space.code} value={space.code}>
                    {space.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-col gap-2 xl:items-end">
            <p className="m-0 font-mono text-xs uppercase tracking-[0.12em] text-[var(--ink)]">
              {formatWeekRange(from, to, localeTag)}
            </p>
            <p className="m-0 text-xs text-[var(--graphite)]">{t.availability.timezoneNote}</p>
            <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--graphite)]">
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-[var(--oxidized)]" />
                {t.availability.legendFree}
              </span>
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-[var(--mortar)]" />
                {t.availability.legendBooked}
              </span>
            </div>
          </div>
        </div>

        <p className="mt-5 border-l-2 border-[var(--brick)] bg-[#faeae6]/55 px-4 py-3 text-sm text-[var(--graphite)]">
          {t.availability.caveat}
        </p>

        {loadState === "loading" ? (
          <p role="status" className="py-14 text-center text-sm text-[var(--graphite)]">
            {t.availability.loading}
          </p>
        ) : null}

        {loadState === "error" ? (
          <div role="alert" className="mt-8 soft-box p-6">
            <p className="m-0 text-sm text-[var(--brick)]">{t.availability.error}</p>
            <button
              type="button"
              onClick={() => setReloadToken((token) => token + 1)}
              className="btn-outline mt-4"
            >
              {t.availability.retry}
            </button>
          </div>
        ) : null}

        {loadState === "ready" && visibleSpaces.length === 0 ? (
          <p className="py-14 text-center text-sm text-[var(--graphite)]">
            {t.availability.noSpaces}
          </p>
        ) : null}

        {loadState === "ready" && visibleSpaces.length > 0 ? (
          <>
            {/* Desktop: one Monday-start week grid per space. */}
            <div className="mt-8 hidden space-y-8 lg:block">
              {visibleSpaces.map((space) => {
                const spaceDays = weekDates.map((dateKey) => findSpaceDay(data, dateKey, space.code));
                const rowCount = Math.max(0, ...spaceDays.map((day) => day?.slots.length ?? 0));
                return (
                  <section
                    key={space.code}
                    aria-label={space.name}
                    className="hairline-box overflow-hidden bg-[var(--paper-card)]"
                  >
                    <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--rule)] px-4 py-4">
                      <div>
                        <p className="m-0 font-mono text-[0.65rem] uppercase tracking-[0.12em] text-[var(--brick)]">
                          {categoryLabel(space)}
                        </p>
                        <h2 className="m-0 font-display text-2xl text-[var(--ink)]">{space.name}</h2>
                      </div>
                      <p className="m-0 font-mono text-[0.68rem] text-[var(--graphite)]">
                        {format(t.availability.openHours, {
                          open: space.openTime,
                          close: space.closeTime,
                        })}
                        {" · "}
                        {inventoryLabel(space)}
                      </p>
                    </header>

                    <div className="grid grid-cols-[4.5rem_repeat(7,minmax(0,1fr))]">
                      <div className="border-b border-[var(--rule)] px-2 py-3" />
                      {weekDates.map((dateKey) => (
                        <div
                          key={dateKey}
                          className={`border-b border-l border-[var(--rule)] px-2 py-3 text-center ${
                            dateKey === initialDateKey ? "bg-[#e6f2ec]/70" : ""
                          }`}
                        >
                          <p className="m-0 font-mono text-[0.6rem] uppercase tracking-[0.12em] text-[var(--brick)]">
                            {formatDateKey(dateKey, localeTag, { weekday: "short" })}
                          </p>
                          <p className="m-0 font-mono text-[0.72rem] text-[var(--ink)]">
                            {formatDateKey(dateKey, localeTag, { day: "numeric", month: "short" })}
                          </p>
                        </div>
                      ))}

                      {Array.from({ length: rowCount }, (_, rowIndex) => {
                        const sample = spaceDays
                          .map((day) => day?.slots[rowIndex])
                          .find((slot): slot is PublicCalendarSlot => Boolean(slot));
                        return (
                          <Fragment key={`${space.code}-row-${rowIndex}`}>
                            <div className="border-t border-[var(--rule)] px-2 py-2 font-mono text-[0.62rem] text-[var(--graphite)]">
                              {sample ? clockInColombo(sample.startAt) : ""}
                            </div>
                            {weekDates.map((dateKey, columnIndex) => {
                              const slot = spaceDays[columnIndex]?.slots[rowIndex];
                              if (!slot) {
                                return (
                                  <div
                                    key={`${space.code}-${dateKey}-empty`}
                                    className="min-h-[3.2rem] border-l border-t border-[var(--rule)] bg-[var(--concrete)]/20"
                                  />
                                );
                              }
                              if (slot.canBook && slot.startAt > Date.now()) {
                                return freeSlotLink(
                                  space,
                                  dateKey,
                                  slot,
                                  "flex min-h-[3.2rem] flex-col items-center justify-center gap-0.5 border-l border-t border-[var(--rule)] bg-[#e6f2ec] px-1 py-2 text-center text-[var(--oxidized)] transition-colors hover:bg-[var(--chartreuse)]",
                                  space.category === "COWORKING",
                                );
                              }
                              return (
                                <div
                                  key={`${space.code}-${dateKey}-${slot.startAt}`}
                                  className="flex min-h-[3.2rem] flex-col items-center justify-center gap-0.5 border-l border-t border-[var(--rule)] bg-[var(--concrete)]/60 px-1 py-2 text-center text-[var(--muted-stone)]"
                                >
                                  <span className="font-mono text-[0.62rem] uppercase tracking-[0.08em]">
                                    {slot.isFree ? t.availability.notBookable : t.availability.booked}
                                  </span>
                                </div>
                              );
                            })}
                          </Fragment>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>

            {/* Mobile / tablet: a day-by-day agenda of free hours. */}
            <div className="mt-8 space-y-4 lg:hidden" aria-label={t.availability.listViewLabel}>
              {weekDates.map((dateKey) => {
                const isToday = dateKey === initialDateKey;
                return (
                  <section
                    key={dateKey}
                    className="hairline-box bg-[var(--paper-card)] p-4"
                    aria-label={formatDateKey(dateKey, localeTag, {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                    })}
                  >
                    <header className="flex items-baseline justify-between gap-3 border-b border-[var(--rule)] pb-3">
                      <h2 className="m-0 font-display text-xl text-[var(--ink)]">
                        {formatDateKey(dateKey, localeTag, {
                          weekday: "long",
                          day: "numeric",
                          month: "short",
                        })}
                      </h2>
                      {isToday ? (
                        <span className="font-mono text-[0.62rem] uppercase tracking-[0.12em] text-[var(--brick)]">
                          {t.availability.today}
                        </span>
                      ) : null}
                    </header>

                    <div className="mt-3 space-y-4">
                      {visibleSpaces.map((space) => {
                        const day = findSpaceDay(data, dateKey, space.code);
                        const freeSlots = (day?.slots ?? []).filter((slot) => slot.canBook && slot.startAt > Date.now());
                        return (
                          <div key={`${dateKey}-${space.code}`}>
                            <p className="m-0 text-sm font-medium text-[var(--ink)]">{space.name}</p>
                            <p className="m-0 mt-0.5 font-mono text-[0.62rem] text-[var(--graphite)]">
                              {format(t.availability.openHours, {
                                open: space.openTime,
                                close: space.closeTime,
                              })}
                              {" · "}
                              {inventoryLabel(space)}
                            </p>

                            {freeSlots.length > 0 ? (
                              <ul className="mt-2 grid grid-cols-2 gap-2 p-0">
                                {freeSlots.map((slot) => (
                                  <li key={slot.startAt} className="list-none">
                                    {freeSlotLink(
                                      space,
                                      dateKey,
                                      slot,
                                      "flex min-h-[2.6rem] flex-col items-start justify-center gap-0.5 rounded-md border border-[var(--oxidized)]/25 bg-[#e6f2ec] px-3 py-2 text-left text-[var(--oxidized)] transition-colors hover:bg-[var(--chartreuse)]",
                                      space.category === "COWORKING",
                                    )}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="m-0 mt-2 text-xs text-[var(--muted-stone)]">
                                {t.availability.fullyBooked}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
