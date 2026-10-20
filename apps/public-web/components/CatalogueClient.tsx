"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { clientApiPath } from "../lib/api";
import { spaceMeta } from "../lib/format";
import { format } from "../lib/i18n";
import { coverFor } from "../lib/media";
import type { Availability, PublicSpace } from "../lib/types";
import { useT } from "./I18nProvider";

const CATEGORIES = [
  { code: "", labelKey: "catAll" },
  { code: "MEETING_ROOM", labelKey: "catMeeting" },
  { code: "AUDITORIUM", labelKey: "catAuditorium" },
  { code: "COWORKING", labelKey: "catCoworking" },
] as const;

const PRICING_UNITS = [
  { code: "", labelKey: "unitAny" },
  { code: "HOUR", labelKey: "unitHour" },
  { code: "HALF_DAY", labelKey: "unitHalfDay" },
  { code: "DAY", labelKey: "unitDay" },
  { code: "WEEK", labelKey: "unitWeek" },
  { code: "MONTH", labelKey: "unitMonth" },
] as const;

const GRID_RATIOS = [
  "aspect-[16/10]",
  "aspect-[4/5]",
  "aspect-[3/2]",
  "aspect-[16/9]",
  "aspect-[16/10]",
] as const;

const GRID_SPANS = [
  "md:col-span-7",
  "md:col-span-5",
  "md:col-span-5",
  "md:col-span-7",
  "md:col-span-8",
] as const;

function minRateCents(space: PublicSpace): number {
  const list = space.rateList ?? [];
  if (!list.length) return Number.MAX_SAFE_INTEGER;
  return Math.min(...list.map((r) => r.amountCents));
}

export function CatalogueClient({
  initialSpaces,
  initialCategory = "",
  initialQuery = "",
  initialDate = "",
  initialStart = "",
  initialEnd = "",
}: {
  initialSpaces: PublicSpace[];
  initialCategory?: string;
  initialQuery?: string;
  initialDate?: string;
  initialStart?: string;
  initialEnd?: string;
}) {
  const t = useT();
  const [query, setQuery] = useState(initialQuery);
  const [category, setCategory] = useState(initialCategory);
  const [minCapacity, setMinCapacity] = useState("");
  const [pricingUnit, setPricingUnit] = useState("");
  const [sort, setSort] = useState<"name" | "capacity" | "price">("name");
  const [selectedAmenities, setSelectedAmenities] = useState<string[]>([]);
  const [draftToken, setDraftToken] = useState("");

  useEffect(() => {
    const token = window.location.hash.match(/(?:^#|&)draft=([^&]+)/)?.[1];
    if (token) setDraftToken(decodeURIComponent(token));
  }, []);

  const [checkDate, setCheckDate] = useState(initialDate);
  const [checkStart, setCheckStart] = useState(initialStart);
  const [checkEnd, setCheckEnd] = useState(initialEnd);
  const [onlyAvailableForWindow, setOnlyAvailableForWindow] = useState(false);
  const [availabilityMap, setAvailabilityMap] = useState<Record<string, Availability>>({});
  const [checkingWindow, setCheckingWindow] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);
  const [desktopFiltersOpen, setDesktopFiltersOpen] = useState(false);

  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const sheetTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sheetCloseRef = useRef<HTMLButtonElement | null>(null);

  const allAmenities = useMemo(() => {
    const set = new Set<string>();
    for (const s of initialSpaces) {
      for (const a of s.amenities ?? []) set.add(a);
    }
    return Array.from(set).sort();
  }, [initialSpaces]);

  useEffect(() => {
    if (!mobileSheetOpen) return;
    sheetCloseRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileSheetOpen(false);
        sheetTriggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileSheetOpen]);

  async function verifyAvailabilityWindow() {
    if (!checkDate || !checkStart || !checkEnd) {
      setWindowError(t.catalogue.windowErrorSelect);
      return;
    }
    const startIso = `${checkDate}T${checkStart}:00+05:30`;
    const endIso = `${checkDate}T${checkEnd}:00+05:30`;
    if (Date.parse(endIso) <= Date.parse(startIso)) {
      setWindowError(t.catalogue.windowErrorOrder);
      return;
    }
    setWindowError(null);
    setCheckingWindow(true);
    try {
      const entries = await Promise.all(
        initialSpaces.map(async (space) => {
          const qs = new URLSearchParams({
            space: space.code,
            start: startIso,
            end: endIso,
            desks: "1",
          });
          const res = await fetch(clientApiPath(`/api/public/availability?${qs.toString()}`), {
            headers: { Accept: "application/json" },
          });
          if (!res.ok) return [space.code, null] as const;
          const data = (await res.json().catch(() => null)) as Availability | null;
          return [space.code, data] as const;
        }),
      );
      const next: Record<string, Availability> = {};
      for (const [code, data] of entries) {
        if (data) next[code] = data;
      }
      setAvailabilityMap(next);
    } catch {
      setWindowError(t.catalogue.windowErrorService);
    } finally {
      setCheckingWindow(false);
    }
  }

  function resetAllFilters() {
    setQuery("");
    setCategory("");
    setMinCapacity("");
    setPricingUnit("");
    setSort("name");
    setSelectedAmenities([]);
    setCheckDate("");
    setCheckStart("");
    setCheckEnd("");
    setOnlyAvailableForWindow(false);
    setAvailabilityMap({});
    setWindowError(null);
  }

  function toggleAmenity(amenity: string) {
    setSelectedAmenities((prev) =>
      prev.includes(amenity) ? prev.filter((item) => item !== amenity) : [...prev, amenity],
    );
  }

  const filteredSpaces = useMemo(() => {
    const q = query.trim().toLowerCase();
    const minCap = Number(minCapacity);
    const list = initialSpaces.filter((space) => {
      if (category && space.category !== category) return false;
      if (Number.isFinite(minCap) && minCap > 0 && (space.capacity ?? 0) < minCap) return false;
      if (pricingUnit && !(space.rateList ?? []).some((r) => r.unit === pricingUnit)) return false;
      if (selectedAmenities.length > 0) {
        const spaceAmenities = new Set(space.amenities ?? []);
        for (const needed of selectedAmenities) {
          if (!spaceAmenities.has(needed)) return false;
        }
      }
      if (onlyAvailableForWindow && Object.keys(availabilityMap).length > 0) {
        const avail = availabilityMap[space.code];
        if (!avail || !avail.isAvailable) return false;
      }
      if (q) {
        const hay = [
          space.name,
          space.code,
          space.categoryLabel,
          space.shortDescription,
          space.description,
          space.location,
          ...(space.amenities ?? []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return [...list].sort((a, b) => {
      if (sort === "capacity") return (b.capacity ?? 0) - (a.capacity ?? 0);
      if (sort === "price") return minRateCents(a) - minRateCents(b);
      return a.name.localeCompare(b.name);
    });
  }, [
    initialSpaces,
    query,
    category,
    minCapacity,
    pricingUnit,
    selectedAmenities,
    onlyAvailableForWindow,
    availabilityMap,
    sort,
  ]);

  const hasActiveFilters = Boolean(
    query.trim() ||
      category ||
      minCapacity ||
      pricingUnit ||
      selectedAmenities.length > 0 ||
      onlyAvailableForWindow ||
      sort !== "name",
  );

  return (
    <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 pt-10 sm:pt-14 pb-16">
      <header className="pb-8 hairline-b grid grid-cols-1 lg:grid-cols-12 gap-5 lg:gap-10 items-end">
        <div className="lg:col-span-8 flex flex-col gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--brick)]">
            {t.catalogue.eyebrow}
          </p>
          <h1 className="font-display text-4xl sm:text-6xl text-[var(--ink)] max-w-[13ch]">
            {t.catalogue.headline}
          </h1>
        </div>
        <p className="lg:col-span-4 text-base text-[var(--graphite)] max-w-xl lg:pb-1">
          {t.catalogue.intro}
        </p>

        {/* WRAPPING CATEGORY CHIPS */}
        <div className="lg:col-span-12 pt-2 flex flex-wrap items-center gap-2" role="group" aria-label={t.catalogue.categoryGroup}>
          {CATEGORIES.map((item) => {
            const active = category === item.code;
            return (
              <button
                key={item.code || "all"}
                type="button"
                aria-pressed={active}
                onClick={() => setCategory(item.code)}
                className={`font-mono text-xs uppercase tracking-[0.12em] px-3.5 py-2 border transition-colors cursor-pointer ${
                  active
                    ? "bg-[var(--ink)] text-[var(--bone)] border-[var(--ink)]"
                    : "bg-[var(--paper-card)] text-[var(--graphite)] border-[var(--rule-strong)] hover:text-[var(--ink)]"
                }`}
              >
                {t.catalogue[item.labelKey]}
              </button>
            );
          })}
        </div>
      </header>

      {/* DESKTOP STICKY COMPACT FILTER TOOLBAR */}
      <div className="sticky top-[4.75rem] z-30 bg-[var(--bone)]/95 backdrop-blur-md hairline-b py-4">
        <div className="hidden lg:grid lg:grid-cols-12 gap-3 items-end">
          <div className="lg:col-span-6 flex flex-col gap-1">
            <label htmlFor="catalogue-q-compact" className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
              {t.catalogue.searchLabel}
            </label>
            <input
              id="catalogue-q-compact"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.catalogue.searchPlaceholder}
              className="field-input"
            />
          </div>
          <div className="lg:col-span-2 flex flex-col gap-1">
            <label htmlFor="catalogue-sort-compact" className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
              {t.catalogue.sortLabel}
            </label>
            <select
              id="catalogue-sort-compact"
              value={sort}
              onChange={(e) => setSort(e.target.value as "name" | "capacity" | "price")}
              className="field-input"
            >
              <option value="name">{t.catalogue.sortName}</option>
              <option value="capacity">{t.catalogue.sortCapacity}</option>
              <option value="price">{t.catalogue.sortPrice}</option>
            </select>
          </div>
          <div className="lg:col-span-2 flex items-end">
            <button
              type="button"
              aria-expanded={desktopFiltersOpen}
              aria-controls="desktop-advanced-filters"
              onClick={() => setDesktopFiltersOpen((open) => !open)}
              className="btn-outline w-full min-h-[2.85rem]"
            >
              {desktopFiltersOpen ? t.catalogue.closeFilters : t.catalogue.moreFilters}
            </button>
          </div>
          <div className="lg:col-span-2 min-h-[2.85rem] flex items-center justify-end border-l border-[var(--rule)] pl-4 font-mono text-xs text-[var(--graphite)]">
            <span>{format(t.catalogue.countReady, { count: filteredSpaces.length })}</span>
          </div>
        </div>

        <div
          id="desktop-advanced-filters"
          className={`${desktopFiltersOpen ? "lg:grid" : "lg:hidden"} hidden lg:grid-cols-12 gap-3 items-end pt-5 mt-4 border-t border-[var(--rule)]`}
        >
          <div className="lg:col-span-3 min-h-[4.35rem] flex flex-col justify-center gap-1 border-l-2 border-[var(--brick)] pl-4">
            <span className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--brick)]">
              {t.catalogue.refineTitle}
            </span>
            <span className="text-sm text-[var(--graphite)]">
              {t.catalogue.refineBody}
            </span>
          </div>

          <div className="lg:col-span-2 flex flex-col gap-1">
            <label htmlFor="catalogue-cap" className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
              {t.catalogue.minCapacity}
            </label>
            <input
              id="catalogue-cap"
              type="number"
              min={1}
              value={minCapacity}
              onChange={(e) => setMinCapacity(e.target.value)}
              placeholder={t.catalogue.capacityPlaceholder}
              className="field-input"
            />
          </div>

          <div className="lg:col-span-2 flex flex-col gap-1">
            <label htmlFor="catalogue-unit" className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
              {t.catalogue.billingUnit}
            </label>
            <select
              id="catalogue-unit"
              value={pricingUnit}
              onChange={(e) => setPricingUnit(e.target.value)}
              className="field-input"
            >
              {PRICING_UNITS.map((u) => (
                <option key={u.code || "any"} value={u.code}>
                  {t.catalogue[u.labelKey]}
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-3 grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="catalogue-date" className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
                {t.catalogue.dateLabel}
              </label>
              <input
                id="catalogue-date"
                type="date"
                value={checkDate}
                onChange={(e) => setCheckDate(e.target.value)}
                className="field-input px-2 text-xs"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="catalogue-start" className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
                {t.catalogue.fromLabel}
              </label>
              <input
                id="catalogue-start"
                type="time"
                step={900}
                value={checkStart}
                onChange={(e) => setCheckStart(e.target.value)}
                className="field-input px-2 text-xs"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="catalogue-end" className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
                {t.catalogue.toLabel}
              </label>
              <input
                id="catalogue-end"
                type="time"
                step={900}
                value={checkEnd}
                onChange={(e) => setCheckEnd(e.target.value)}
                className="field-input px-2 text-xs"
              />
            </div>
          </div>

          <div className="lg:col-span-2 flex items-end">
            <button
              type="button"
              onClick={() => void verifyAvailabilityWindow()}
              disabled={checkingWindow}
              className="btn-primary w-full min-h-[2.85rem]"
            >
              {checkingWindow ? t.catalogue.checking : t.catalogue.checkWindow}
            </button>
          </div>
        </div>

        {/* DESKTOP SECONDARY BAR: AMENITIES + WINDOW CHECK + RESET */}
        <div className={`${desktopFiltersOpen ? "lg:flex" : "lg:hidden"} hidden flex-wrap items-center justify-between gap-4 pt-3 mt-3 border-t border-[var(--rule)]`}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)] mr-1">
              {t.catalogue.amenitiesLabel}:
            </span>
            {allAmenities.map((amenity) => {
              const active = selectedAmenities.includes(amenity);
              return (
                <button
                  key={amenity}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleAmenity(amenity)}
                  className={`font-mono text-[0.7rem] px-2.5 py-1 border cursor-pointer ${
                    active
                      ? "bg-[var(--oxidized)] text-[var(--bone)] border-[var(--oxidized)]"
                      : "bg-[var(--paper-card)] text-[var(--graphite)] border-[var(--rule)] hover:text-[var(--ink)]"
                  }`}
                >
                  {amenity}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {Object.keys(availabilityMap).length > 0 ? (
              <label className="inline-flex items-center gap-2 font-mono text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyAvailableForWindow}
                  onChange={(e) => setOnlyAvailableForWindow(e.target.checked)}
                />
                <span>{t.catalogue.onlyFree}</span>
              </label>
            ) : null}
            {hasActiveFilters ? (
              <button
                type="button"
                onClick={resetAllFilters}
                className="font-mono text-xs uppercase tracking-wider text-[var(--brick)] underline cursor-pointer bg-transparent border-0"
              >
                {t.catalogue.resetFilters}
              </button>
            ) : null}
          </div>
        </div>

        {/* MOBILE COMPACT BAR + VERTICAL SHEET TRIGGER */}
        <div className="flex lg:hidden flex-wrap items-center justify-between gap-3">
          <div className="flex-1 min-w-[11rem]">
            <label htmlFor="mobile-catalogue-q" className="sr-only">
              {t.catalogue.mobileSearchLabel}
            </label>
            <input
              id="mobile-catalogue-q"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.catalogue.mobileSearchPlaceholder}
              className="field-input py-2 text-sm"
            />
          </div>
          <button
            ref={sheetTriggerRef}
            type="button"
            aria-expanded={mobileSheetOpen}
            aria-controls="mobile-filter-sheet"
            onClick={() => setMobileSheetOpen(true)}
            className="btn-primary py-2.5 px-3.5 text-xs"
          >
            {t.catalogue.filtersSort}
          </button>
        </div>
      </div>

      {/* MOBILE ACCESSIBLE VERTICAL FILTER SHEET */}
      {mobileSheetOpen ? (
        <div
          id="mobile-filter-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={t.catalogue.sheetTitle}
          className="fixed inset-0 z-50 bg-[var(--obsidian)]/65 flex flex-col justify-end lg:hidden"
        >
          <div className="bg-[var(--bone)] hairline-t max-h-[88dvh] overflow-y-auto p-5 flex flex-col gap-5">
            <div className="flex items-center justify-between gap-4 hairline-b pb-3">
              <h2 className="font-display text-2xl text-[var(--ink)] m-0">
                {t.catalogue.sheetTitle}
              </h2>
              <button
                ref={sheetCloseRef}
                type="button"
                onClick={() => {
                  setMobileSheetOpen(false);
                  sheetTriggerRef.current?.focus();
                }}
                className="font-mono text-xs uppercase tracking-wider px-3 py-1.5 border border-[var(--ink)] bg-[var(--paper-card)]"
              >
                {t.catalogue.close}
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="m-category" className="font-mono text-xs uppercase tracking-wider">
                {t.catalogue.categoryLabel}
              </label>
              <select
                id="m-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="field-input"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.code || "all"} value={c.code}>
                    {t.catalogue[c.labelKey]}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="m-cap" className="font-mono text-xs uppercase tracking-wider">
                  {t.catalogue.minCapacityLabel}
                </label>
                <input
                  id="m-cap"
                  type="number"
                  min={1}
                  value={minCapacity}
                  onChange={(e) => setMinCapacity(e.target.value)}
                  className="field-input"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="m-unit" className="font-mono text-xs uppercase tracking-wider">
                  {t.catalogue.billingUnit}
                </label>
                <select
                  id="m-unit"
                  value={pricingUnit}
                  onChange={(e) => setPricingUnit(e.target.value)}
                  className="field-input"
                >
                  {PRICING_UNITS.map((u) => (
                    <option key={u.code || "any"} value={u.code}>
                      {t.catalogue[u.labelKey]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="m-sort" className="font-mono text-xs uppercase tracking-wider">
                {t.catalogue.sortLabel}
              </label>
              <select
                id="m-sort"
                value={sort}
                onChange={(e) => setSort(e.target.value as "name" | "capacity" | "price")}
                className="field-input"
              >
                <option value="name">{t.catalogue.sortName}</option>
                <option value="capacity">{t.catalogue.sortCapacity}</option>
                <option value="price">{t.catalogue.sortPrice}</option>
              </select>
            </div>

            <div className="flex flex-col gap-2">
              <span className="font-mono text-xs uppercase tracking-wider">{t.catalogue.amenitiesLabel}</span>
              <div className="flex flex-wrap gap-2">
                {allAmenities.map((amenity) => {
                  const active = selectedAmenities.includes(amenity);
                  return (
                    <button
                      key={amenity}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleAmenity(amenity)}
                      className={`font-mono text-xs px-2.5 py-1.5 border ${
                        active
                          ? "bg-[var(--oxidized)] text-[var(--bone)] border-[var(--oxidized)]"
                          : "bg-[var(--paper-card)] text-[var(--ink)] border-[var(--rule-strong)]"
                      }`}
                    >
                      {amenity}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 hairline-t pt-4">
              <button type="button" onClick={resetAllFilters} className="btn-outline py-2 px-4 text-xs">
                {t.catalogue.resetAll}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMobileSheetOpen(false);
                  sheetTriggerRef.current?.focus();
                }}
                className="btn-primary py-2.5 px-5 text-xs"
              >
                {format(t.catalogue.showCount, { count: filteredSpaces.length })}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {windowError ? (
        <div role="alert" className="mt-4 p-3.5 border-l-4 border-[var(--brick)] bg-[#faeae6] text-sm text-[var(--brick)]">
          {windowError}
        </div>
      ) : null}

      {/* RESULT COUNT BAR */}
      <div className="py-6 flex flex-wrap items-center justify-between gap-3 font-mono text-xs text-[var(--graphite)]">
        <p className="m-0">
          {format(t.catalogue.resultsBar, {
            shown: filteredSpaces.length,
            total: initialSpaces.length,
          })}
        </p>
        {hasActiveFilters ? (
          <button
            type="button"
            onClick={resetAllFilters}
            className="text-[var(--brick)] underline bg-transparent border-0 cursor-pointer font-mono text-xs"
          >
            {t.catalogue.clearFilters}
          </button>
        ) : null}
      </div>

      {/* EDITORIAL ASYMMETRIC VENUE GRID */}
      {filteredSpaces.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-10">
          {filteredSpaces.map((space, idx) => {
            const cover = coverFor(space);
            const ratio = GRID_RATIOS[idx % GRID_RATIOS.length];
            const span = GRID_SPANS[idx % GRID_SPANS.length];
            const avail = availabilityMap[space.code];
            const bookHref = `/spaces/${encodeURIComponent(space.code)}/book${draftToken ? `#draft=${encodeURIComponent(draftToken)}` : ""}`;

            return (
              <article
                key={space.code}
                data-space-code={space.code}
                className={`${span} flex flex-col gap-4 hairline-b pb-8`}
              >
                <Link
                  href={`/spaces/${encodeURIComponent(space.code)}`}
                  className={`group block ${ratio} w-full overflow-hidden hairline-box bg-[var(--concrete)] relative no-underline`}
                >
                  <img
                    src={cover.src}
                    alt={cover.alt}
                    loading="lazy"
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
                  />
                  <span className="absolute top-3 left-3 bg-[var(--obsidian)]/85 text-[var(--bone)] font-mono text-[0.7rem] uppercase tracking-[0.14em] px-2.5 py-1">
                    {space.categoryLabel}
                  </span>
                  {avail ? (
                    <span
                      className={`absolute bottom-3 left-3 font-mono text-[0.7rem] uppercase tracking-wider px-2.5 py-1 ${
                        avail.isAvailable
                          ? "bg-[var(--chartreuse)] text-[var(--ink)]"
                          : "bg-[var(--brick)] text-[var(--bone)]"
                      }`}
                    >
                      {avail.isAvailable
                        ? avail.isPooled
                          ? format(t.catalogue.badgeDesks, {
                              free: avail.freeUnits,
                              total: avail.totalUnits,
                            })
                          : t.catalogue.badgeAvailable
                        : t.catalogue.badgeOccupied}
                    </span>
                  ) : null}
                </Link>

                <div className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-xs text-[var(--graphite)]">
                  <span>{spaceMeta(space)}</span>
                  <code className="text-[var(--ink)]">{space.code}</code>
                </div>

                <h2 className="font-display text-2xl sm:text-3xl text-[var(--ink)] m-0">
                  <Link
                    href={`/spaces/${encodeURIComponent(space.code)}`}
                    className="no-underline hover:underline text-[var(--ink)]"
                  >
                    {space.name}
                  </Link>
                </h2>

                {space.shortDescription ? (
                  <p className="text-sm text-[var(--graphite)] m-0">{space.shortDescription}</p>
                ) : null}

                {space.amenities?.length ? (
                  <ul className="list-none p-0 m-0 flex flex-wrap gap-1.5">
                    {space.amenities.slice(0, 5).map((amenity) => (
                      <li
                        key={amenity}
                        className="font-mono text-[0.7rem] px-2 py-0.5 bg-[var(--concrete)] text-[var(--graphite)]"
                      >
                        {amenity}
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="pt-2 mt-auto flex flex-wrap items-center justify-between gap-4">
                  <span className="font-mono text-xs font-medium text-[var(--oxidized)]">
                    {space.rateSummary}
                  </span>
                  <div className="flex flex-wrap items-center gap-3">
                    <Link
                      href={`/spaces/${encodeURIComponent(space.code)}`}
                      className="font-mono text-xs uppercase tracking-[0.12em] text-[var(--ink)] hover:text-[var(--brick)]"
                    >
                      {t.catalogue.inspectVenue} →
                    </Link>
                    <Link href={bookHref} className="btn-primary py-2 px-3.5 text-xs">
                      {t.catalogue.bookDirectly}
                    </Link>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="hairline-box bg-[var(--paper-card)] p-10 text-center flex flex-col items-center gap-4">
          <h2 className="font-display text-3xl text-[var(--ink)] m-0">
            {t.catalogue.emptyTitle}
          </h2>
          <p className="text-sm text-[var(--graphite)] max-w-md m-0">
            {t.catalogue.emptyBody}
          </p>
          <button type="button" onClick={resetAllFilters} className="btn-primary">
            {t.catalogue.resetAll}
          </button>
        </div>
      )}
    </div>
  );
}
