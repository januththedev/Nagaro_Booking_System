"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { clientApiPath } from "../lib/api";
import { spaceMeta } from "../lib/format";
import { coverFor } from "../lib/media";
import type { Availability, PublicSpace } from "../lib/types";

const CATEGORIES = [
  { code: "", label: "All venues" },
  { code: "MEETING_ROOM", label: "Meeting & training" },
  { code: "AUDITORIUM", label: "Auditorium" },
  { code: "COWORKING", label: "Co-working desks" },
];

const PRICING_UNITS = [
  { code: "", label: "Any billing unit" },
  { code: "HOUR", label: "Per hour" },
  { code: "HALF_DAY", label: "Per half day" },
  { code: "DAY", label: "Per day" },
  { code: "WEEK", label: "Per week" },
  { code: "MONTH", label: "Per month" },
];

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
  const [query, setQuery] = useState(initialQuery);
  const [category, setCategory] = useState(initialCategory);
  const [minCapacity, setMinCapacity] = useState("");
  const [pricingUnit, setPricingUnit] = useState("");
  const [sort, setSort] = useState<"name" | "capacity" | "price">("name");
  const [selectedAmenities, setSelectedAmenities] = useState<string[]>([]);

  const [checkDate, setCheckDate] = useState(initialDate);
  const [checkStart, setCheckStart] = useState(initialStart);
  const [checkEnd, setCheckEnd] = useState(initialEnd);
  const [onlyAvailableForWindow, setOnlyAvailableForWindow] = useState(false);
  const [availabilityMap, setAvailabilityMap] = useState<Record<string, Availability>>({});
  const [checkingWindow, setCheckingWindow] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);

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
      setWindowError("Select a date, start time and end time (SLST) to check availability.");
      return;
    }
    const startIso = `${checkDate}T${checkStart}:00+05:30`;
    const endIso = `${checkDate}T${checkEnd}:00+05:30`;
    if (Date.parse(endIso) <= Date.parse(startIso)) {
      setWindowError("End time must be after the start time.");
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
      setWindowError("Could not reach the availability service.");
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
    <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-12 sm:py-16">
      <header className="pb-10 hairline-b flex flex-col gap-4">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--brick)]">
          TRACE Expert City · Venue Catalogue
        </p>
        <h1 className="font-display text-4xl sm:text-6xl text-[var(--ink)]">
          Architectural rooms, studio bays and coworking halls.
        </h1>
        <p className="text-base sm:text-lg text-[var(--graphite)] max-w-2xl">
          Filter by spatial category, attendee capacity, billing unit or live Sri Lanka Standard Time
          availability. Every space below links directly to its full specifications and instant
          reservation checkout.
        </p>

        {/* WRAPPING CATEGORY CHIPS */}
        <div className="pt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Venue category filter">
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
                {item.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* DESKTOP STICKY COMPACT FILTER TOOLBAR */}
      <div className="sticky top-[4.5rem] z-30 bg-[var(--bone)]/95 backdrop-blur-md hairline-b py-4">
        <div className="hidden lg:grid lg:grid-cols-12 gap-3 items-end">
          <div className="lg:col-span-3 flex flex-col gap-1">
            <label htmlFor="catalogue-q" className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
              Search name, code or facility
            </label>
            <input
              id="catalogue-q"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. Baobab, Auditorium, Projector"
              className="field-input"
            />
          </div>

          <div className="lg:col-span-2 flex flex-col gap-1">
            <label htmlFor="catalogue-cap" className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
              Min capacity
            </label>
            <input
              id="catalogue-cap"
              type="number"
              min={1}
              value={minCapacity}
              onChange={(e) => setMinCapacity(e.target.value)}
              placeholder="People"
              className="field-input"
            />
          </div>

          <div className="lg:col-span-2 flex flex-col gap-1">
            <label htmlFor="catalogue-unit" className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
              Billing unit
            </label>
            <select
              id="catalogue-unit"
              value={pricingUnit}
              onChange={(e) => setPricingUnit(e.target.value)}
              className="field-input"
            >
              {PRICING_UNITS.map((u) => (
                <option key={u.code || "any"} value={u.code}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-3 grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="catalogue-date" className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
                Date
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
                From
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
                To
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

          <div className="lg:col-span-2 flex flex-col gap-1">
            <label htmlFor="catalogue-sort" className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
              Sort by
            </label>
            <select
              id="catalogue-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as "name" | "capacity" | "price")}
              className="field-input"
            >
              <option value="name">Name (A–Z)</option>
              <option value="capacity">Capacity (high to low)</option>
              <option value="price">Starting rate (low to high)</option>
            </select>
          </div>
        </div>

        {/* DESKTOP SECONDARY BAR: AMENITIES + WINDOW CHECK + RESET */}
        <div className="hidden lg:flex flex-wrap items-center justify-between gap-4 pt-3 mt-3 border-t border-[var(--rule)]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)] mr-1">
              Amenities:
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
            <button
              type="button"
              onClick={() => void verifyAvailabilityWindow()}
              disabled={checkingWindow}
              className="btn-outline py-1.5 px-3 text-xs"
            >
              {checkingWindow ? "Checking SLST window…" : "Check window availability"}
            </button>
            {Object.keys(availabilityMap).length > 0 ? (
              <label className="inline-flex items-center gap-2 font-mono text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyAvailableForWindow}
                  onChange={(e) => setOnlyAvailableForWindow(e.target.checked)}
                />
                <span>Only free in window</span>
              </label>
            ) : null}
            {hasActiveFilters ? (
              <button
                type="button"
                onClick={resetAllFilters}
                className="font-mono text-xs uppercase tracking-wider text-[var(--brick)] underline cursor-pointer bg-transparent border-0"
              >
                Reset filters
              </button>
            ) : null}
          </div>
        </div>

        {/* MOBILE COMPACT BAR + VERTICAL SHEET TRIGGER */}
        <div className="flex lg:hidden flex-wrap items-center justify-between gap-3">
          <div className="flex-1 min-w-[11rem]">
            <label htmlFor="mobile-catalogue-q" className="sr-only">
              Search venues
            </label>
            <input
              id="mobile-catalogue-q"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search venues…"
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
            Filters &amp; sort
          </button>
        </div>
      </div>

      {/* MOBILE ACCESSIBLE VERTICAL FILTER SHEET */}
      {mobileSheetOpen ? (
        <div
          id="mobile-filter-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Filter and sort venues"
          className="fixed inset-0 z-50 bg-[var(--obsidian)]/65 flex flex-col justify-end lg:hidden"
        >
          <div className="bg-[var(--bone)] hairline-t max-h-[88dvh] overflow-y-auto p-5 flex flex-col gap-5">
            <div className="flex items-center justify-between gap-4 hairline-b pb-3">
              <h2 className="font-display text-2xl text-[var(--ink)] m-0">
                Filter &amp; sort venues
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
                Close
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="m-category" className="font-mono text-xs uppercase tracking-wider">
                Category
              </label>
              <select
                id="m-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="field-input"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.code || "all"} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="m-cap" className="font-mono text-xs uppercase tracking-wider">
                  Minimum capacity
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
                  Billing unit
                </label>
                <select
                  id="m-unit"
                  value={pricingUnit}
                  onChange={(e) => setPricingUnit(e.target.value)}
                  className="field-input"
                >
                  {PRICING_UNITS.map((u) => (
                    <option key={u.code || "any"} value={u.code}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="m-sort" className="font-mono text-xs uppercase tracking-wider">
                Sort order
              </label>
              <select
                id="m-sort"
                value={sort}
                onChange={(e) => setSort(e.target.value as "name" | "capacity" | "price")}
                className="field-input"
              >
                <option value="name">Name (A–Z)</option>
                <option value="capacity">Capacity (high to low)</option>
                <option value="price">Starting rate (low to high)</option>
              </select>
            </div>

            <div className="flex flex-col gap-2">
              <span className="font-mono text-xs uppercase tracking-wider">Amenities</span>
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
                Reset all
              </button>
              <button
                type="button"
                onClick={() => {
                  setMobileSheetOpen(false);
                  sheetTriggerRef.current?.focus();
                }}
                className="btn-primary py-2.5 px-5 text-xs"
              >
                Show {filteredSpaces.length} {filteredSpaces.length === 1 ? "venue" : "venues"}
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
          Showing <strong className="text-[var(--ink)]">{filteredSpaces.length}</strong> of{" "}
          {initialSpaces.length} published {initialSpaces.length === 1 ? "venue" : "venues"}
        </p>
        {hasActiveFilters ? (
          <button
            type="button"
            onClick={resetAllFilters}
            className="text-[var(--brick)] underline bg-transparent border-0 cursor-pointer font-mono text-xs"
          >
            Clear active filters
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
            const bookHref =
              checkDate && checkStart && checkEnd
                ? `/book?space=${encodeURIComponent(space.code)}&date=${encodeURIComponent(checkDate)}&start=${encodeURIComponent(checkStart)}&end=${encodeURIComponent(checkEnd)}`
                : `/book?space=${encodeURIComponent(space.code)}`;

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
                          ? `${avail.freeUnits} of ${avail.totalUnits} desks open`
                          : "Available for selected window"
                        : "Occupied in selected window"}
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
                      Inspect venue →
                    </Link>
                    <Link href={bookHref} className="btn-primary py-2 px-3.5 text-xs">
                      Book directly
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
            No venues match those filters.
          </h2>
          <p className="text-sm text-[var(--graphite)] max-w-md m-0">
            Try clearing a facility constraint or lowering the minimum capacity to view the rest of
            the published TRACE Expert City catalogue.
          </p>
          <button type="button" onClick={resetAllFilters} className="btn-primary">
            Reset all filters
          </button>
        </div>
      )}
    </div>
  );
}
