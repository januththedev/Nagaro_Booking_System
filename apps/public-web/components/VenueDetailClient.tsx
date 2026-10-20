"use client";

import Link from "next/link";
import { useState } from "react";
import { clientApiPath } from "../lib/api";
import { isoDateInColombo } from "../lib/format";
import { format } from "../lib/i18n";
import { galleryFor } from "../lib/media";
import type { Availability, PublicSpace } from "../lib/types";
import { useT } from "./I18nProvider";

function formatDurationMinutes(mins: number | null | undefined, flexible: string): string {
  if (!mins) return flexible;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function formatAttributeKey(key: string): string {
  return key.replace(/_/g, " ");
}

function formatAttributeValue(val: unknown, included: string, no: string): string {
  if (typeof val === "boolean") return val ? included : no;
  if (Array.isArray(val)) return val.join(", ");
  return String(val ?? "—");
}

export function VenueDetailClient({ space }: { space: PublicSpace }) {
  const t = useT();
  const galleryItems = galleryFor(space);

  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const activeImage = galleryItems[activeImageIndex] ?? galleryItems[0];

  const [date, setDate] = useState(() => isoDateInColombo(2));
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("11:00");
  const [desks, setDesks] = useState("1");
  const [availability, setAvailability] = useState<{
    state: "idle" | "checking" | "ok" | "busy" | "error";
    headline: string;
    detail?: string;
  }>({
    state: "idle",
    headline: t.venue.availabilityIdle,
  });

  async function handleAvailabilityCheck(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const startIso = `${date}T${startTime}:00+05:30`;
    const endIso = `${date}T${endTime}:00+05:30`;
    if (Date.parse(endIso) <= Date.parse(startIso)) {
      setAvailability({
        state: "error",
        headline: t.catalogue.windowErrorOrder,
      });
      return;
    }
    setAvailability({ state: "checking", headline: t.venue.availabilityChecking });
    try {
      const qs = new URLSearchParams({
        space: space.code,
        start: startIso,
        end: endIso,
        desks: space.category === "COWORKING" ? String(Math.max(1, Number(desks) || 1)) : "1",
      });
      const res = await fetch(clientApiPath(`/api/public/availability?${qs.toString()}`), {
        headers: { Accept: "application/json" },
      });
      const body = (await res.json().catch(() => null)) as
        | (Availability & { error?: { message?: string } })
        | null;
      if (!res.ok || !body) {
        setAvailability({
          state: "error",
          headline: body?.error?.message || t.venue.availabilityErrorWindow,
        });
        return;
      }
      if (body.isAvailable) {
        setAvailability({
          state: "ok",
          headline: body.isPooled
            ? format(t.venue.availabilityOkPooled, {
                free: body.freeUnits,
                total: body.totalUnits,
              })
            : t.venue.availabilityOk,
          detail: t.venue.availabilityOkDetail,
        });
      } else {
        setAvailability({
          state: "busy",
          headline: body.label || t.venue.availabilityBusy,
          detail: t.venue.availabilityBusyDetail,
        });
      }
    } catch {
      setAvailability({
        state: "error",
        headline: t.venue.availabilityError,
      });
    }
  }

  const directBookHref = `/spaces/${encodeURIComponent(space.code)}/book`;

  const attributeEntries = Object.entries(space.attributes ?? {});

  return (
    <div className="pb-24 lg:pb-12">
      {/* VENUE MEDIA-LED HERO */}
      <section className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 pt-8 pb-10 hairline-b">
        <nav aria-label={t.venue.breadcrumbLabel} className="mb-6 font-mono text-xs text-[var(--graphite)]">
          <ol className="list-none p-0 m-0 flex flex-wrap items-center gap-2">
            <li>
              <Link href="/" className="hover:underline text-[var(--graphite)] no-underline">
                {t.venue.breadcrumbCampus}
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <Link href="/spaces" className="hover:underline text-[var(--graphite)] no-underline">
                {t.venue.breadcrumbSpaces}
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-[var(--ink)] font-medium">
              {space.name}
            </li>
          </ol>
        </nav>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-end mb-8">
          <div className="lg:col-span-8 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
              <span className="uppercase tracking-[0.14em] px-2.5 py-1 bg-[var(--oxidized)] text-[var(--bone)]">
                {space.categoryLabel}
              </span>
              <span className="text-[var(--graphite)]">
                {t.venue.codeLabel} <code className="text-[var(--ink)]">{space.code}</code>
              </span>
            </div>
            <h1 className="font-display text-4xl sm:text-6xl text-[var(--ink)] m-0">
              {space.name}
            </h1>
            <p className="text-base sm:text-lg text-[var(--graphite)] max-w-2xl m-0">
              {[
                space.location || t.venue.locationFallback,
                space.floor ? format(t.venue.floor, { floor: space.floor }) : null,
                space.capacity ? format(t.venue.upTo, { n: space.capacity }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>

          <div className="lg:col-span-4 flex flex-wrap lg:justify-end gap-3">
            <Link href={directBookHref} className="btn-primary">
              {t.venue.requestCta}
            </Link>
          </div>
        </div>

        {/* MOSAIC GALLERY */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-9 aspect-[16/9] w-full overflow-hidden hairline-box bg-[var(--concrete)]">
            <img
              src={activeImage.src}
              alt={activeImage.alt}
              className="w-full h-full object-cover"
            />
          </div>
          <div
            role="group"
            aria-label={t.venue.galleryLabel}
            className="lg:col-span-3 grid grid-cols-2 lg:grid-cols-1 gap-3 content-start"
          >
            {galleryItems.map((item, idx) => {
              const selected = idx === activeImageIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={selected ? "true" : "false"}
                  aria-label={format(t.venue.thumbLabel, { n: idx + 1, alt: item.alt })}
                  onClick={() => setActiveImageIndex(idx)}
                  className={`relative aspect-[16/10] w-full overflow-hidden p-0 cursor-pointer border-2 transition-opacity ${
                    selected
                      ? "border-[var(--oxidized)] opacity-100"
                      : "border-transparent opacity-75 hover:opacity-100"
                  }`}
                >
                  <img
                    src={item.src}
                    alt={item.alt}
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                  {item.isCover ? (
                    <span className="absolute bottom-2 left-2 bg-[var(--obsidian)]/85 text-[var(--bone)] font-mono text-[0.65rem] uppercase tracking-wider px-2 py-0.5">
                      {t.venue.primaryView}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* FACTUAL SPECIFICATION BAR */}
        <dl className="mt-8 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 hairline-t pt-6 m-0">
          <div className="border-l-2 border-[var(--oxidized)] pl-3">
            <dt className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
              {t.venue.capacityLabel}
            </dt>
            <dd className="m-0 mt-1 font-mono text-sm font-medium text-[var(--ink)]">
              {space.capacity ? format(t.venue.upTo, { n: space.capacity }) : t.venue.flexible}
            </dd>
          </div>
          <div className="border-l-2 border-[var(--oxidized)] pl-3">
            <dt className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
              {t.venue.inventoryLabel}
            </dt>
            <dd className="m-0 mt-1 font-mono text-sm font-medium text-[var(--ink)]">
              {space.category === "COWORKING"
                ? format(t.venue.inventoryDesks, { n: space.unitCount })
                : t.venue.inventoryRoom}
            </dd>
          </div>
          <div className="border-l-2 border-[var(--oxidized)] pl-3">
            <dt className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
              {t.venue.operatingLabel}
            </dt>
            <dd className="m-0 mt-1 font-mono text-sm font-medium text-[var(--ink)]">
              {format(t.venue.operatingWindow, { open: space.openTime, close: space.closeTime })}
            </dd>
          </div>
          <div className="border-l-2 border-[var(--oxidized)] pl-3">
            <dt className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
              {t.venue.durationLabel}
            </dt>
            <dd className="m-0 mt-1 font-mono text-sm font-medium text-[var(--ink)]">
              {formatDurationMinutes(space.minDurationMinutes, t.venue.flexible)} –{" "}
              {space.maxDurationMinutes
                ? formatDurationMinutes(space.maxDurationMinutes, t.venue.flexible)
                : t.venue.durationOpen}
            </dd>
          </div>
          <div className="border-l-2 border-[var(--oxidized)] pl-3">
            <dt className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
              {t.venue.bufferLabel}
            </dt>
            <dd className="m-0 mt-1 font-mono text-sm font-medium text-[var(--ink)]">
              {space.bufferMinutes > 0
                ? format(t.venue.bufferReset, { m: space.bufferMinutes })
                : t.venue.bufferNone}
            </dd>
          </div>
        </dl>
      </section>

      {/* TWO-COLUMN CONTENT & STICKY BOOKING CONSOLE */}
      <section className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-12 grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
        <div className="lg:col-span-7 flex flex-col gap-12">
          <article className="flex flex-col gap-4 hairline-b pb-10">
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--brick)] m-0">
              {t.venue.overviewEyebrow}
            </p>
            <h2 className="font-display text-3xl text-[var(--ink)] m-0">{t.venue.overviewTitle}</h2>
            <p className="text-base sm:text-lg text-[var(--graphite)] leading-relaxed m-0">
              {space.description ||
                space.shortDescription ||
                t.venue.overviewFallback}
            </p>
          </article>

          {space.amenities?.length > 0 ? (
            <article className="flex flex-col gap-4 hairline-b pb-10">
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--oxidized)] m-0">
                {t.venue.facilitiesEyebrow}
              </p>
              <h2 className="font-display text-3xl text-[var(--ink)] m-0">
                {t.venue.facilitiesTitle}
              </h2>
              <ul className="list-none p-0 m-0 grid grid-cols-1 sm:grid-cols-2 gap-3">
                {space.amenities.map((item) => (
                  <li
                    key={item}
                    className="hairline-box bg-[var(--paper-card)] px-4 py-3 font-mono text-xs text-[var(--ink)] flex items-center gap-2.5"
                  >
                    <span className="text-[var(--oxidized)] font-bold">✓</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>
          ) : null}

          {attributeEntries.length > 0 ? (
            <article className="flex flex-col gap-4 hairline-b pb-10">
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--oxidized)] m-0">
                {t.venue.specEyebrow}
              </p>
              <h2 className="font-display text-3xl text-[var(--ink)] m-0">{t.venue.specTitle}</h2>
              <dl className="m-0 grid grid-cols-1 sm:grid-cols-2 gap-4">
                {attributeEntries.map(([k, v]) => (
                  <div key={k} className="hairline-box bg-[var(--paper-card)] p-4">
                    <dt className="font-mono text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
                      {formatAttributeKey(k)}
                    </dt>
                    <dd className="m-0 mt-1 text-sm font-medium text-[var(--ink)] break-words">
                      {formatAttributeValue(v, t.venue.attrIncluded, t.venue.attrNo)}
                    </dd>
                  </div>
                ))}
              </dl>
            </article>
          ) : null}

          <article className="flex flex-col gap-4">
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--brick)] m-0">
              {t.venue.ratesEyebrow}
            </p>
            <h2 className="font-display text-3xl text-[var(--ink)] m-0">{t.venue.ratesTitle}</h2>
            {space.rateList?.length > 0 ? (
              <div className="hairline-box bg-[var(--paper-card)]">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="hairline-b bg-[var(--concrete)]/60 font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                      <th scope="col" className="py-3 px-4">
                        {t.venue.billingUnitCol}
                      </th>
                      <th scope="col" className="py-3 px-4 text-right">
                        {t.venue.rateCol}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--rule)]">
                    {space.rateList.map((rate) => (
                      <tr key={rate.unit}>
                        <th scope="row" className="py-3.5 px-4 font-medium text-[var(--ink)]">
                          {rate.unitLabel}
                          {rate.isDefault ? (
                            <span className="ml-2 font-mono text-[0.68rem] uppercase tracking-wider px-2 py-0.5 bg-[var(--concrete)] text-[var(--oxidized)]">
                              {t.venue.rateDefault}
                            </span>
                          ) : null}
                        </th>
                        <td className="py-3.5 px-4 text-right font-mono font-medium text-[var(--ink)]">
                          {rate.amountLabel}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-[var(--graphite)]">{t.venue.rateOnRequest}</p>
            )}
            <p className="text-xs font-mono text-[var(--graphite)] m-0">
              {t.venue.ratesNote}
            </p>
          </article>
        </div>

        {/* STICKY DESKTOP BOOKING & LIVE AVAILABILITY CONSOLE */}
        <aside className="lg:col-span-5 lg:sticky lg:top-24 flex flex-col gap-6">
          <div className="hairline-box bg-[var(--paper-card)] p-6 sm:p-7 flex flex-col gap-5">
            <div className="hairline-b pb-4">
              <p className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--oxidized)] m-0">
                {t.venue.consoleEyebrow}
              </p>
              <h2 className="font-display text-2xl sm:text-3xl text-[var(--ink)] mt-1 mb-2">
                {t.venue.consoleTitle}
              </h2>
              <p className="font-mono text-xs text-[var(--brick)] m-0">{space.rateSummary}</p>
            </div>

            <form onSubmit={handleAvailabilityCheck} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <label htmlFor="detail-date" className="font-mono text-xs uppercase tracking-wider">
                  {t.venue.dateLabel}
                </label>
                <input
                  id="detail-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="field-input"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="detail-start" className="font-mono text-xs uppercase tracking-wider">
                    {t.venue.fromLabel}
                  </label>
                  <input
                    id="detail-start"
                    type="time"
                    step={900}
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="field-input"
                    required
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="detail-end" className="font-mono text-xs uppercase tracking-wider">
                    {t.venue.toLabel}
                  </label>
                  <input
                    id="detail-end"
                    type="time"
                    step={900}
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="field-input"
                    required
                  />
                </div>
              </div>

              {space.category === "COWORKING" ? (
                <div className="flex flex-col gap-1">
                  <label htmlFor="detail-desks" className="font-mono text-xs uppercase tracking-wider">
                    {format(t.venue.desksLabel, { n: space.unitCount })}
                  </label>
                  <input
                    id="detail-desks"
                    type="number"
                    min={1}
                    max={space.unitCount || 500}
                    value={desks}
                    onChange={(e) => setDesks(e.target.value)}
                    className="field-input"
                  />
                </div>
              ) : null}

              <button type="submit" className="btn-outline w-full">
                {availability.state === "checking" ? t.venue.checkingCta : t.venue.checkCta}
              </button>

              <div
                role="status"
                aria-live="polite"
                className={`p-3.5 text-sm border-l-4 ${
                  availability.state === "ok"
                    ? "border-[var(--oxidized)] bg-[#e6f2ec] text-[var(--oxidized)]"
                    : availability.state === "busy" || availability.state === "error"
                      ? "border-[var(--brick)] bg-[#faeae6] text-[var(--brick)]"
                      : "border-[var(--ink)]/30 bg-[var(--concrete)]/50 text-[var(--graphite)]"
                }`}
              >
                <p className="font-medium m-0">{availability.headline}</p>
                {availability.detail ? (
                  <p className="text-xs mt-1 m-0">{availability.detail}</p>
                ) : null}
              </div>
            </form>

            <div className="flex flex-col gap-2.5 hairline-t pt-4">
              <Link href={directBookHref} className="btn-primary w-full text-center">
                {t.venue.requestCta} →
              </Link>
            </div>

            <p className="text-xs text-[var(--graphite)] m-0 leading-relaxed">
              {t.venue.consoleNote}
            </p>
          </div>
        </aside>
      </section>

      {/* PERSISTENT MOBILE BOTTOM CTA */}
      <div className="fixed bottom-0 inset-x-0 z-30 lg:hidden bg-[var(--paper-card)]/95 backdrop-blur-md hairline-t px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-lg text-[var(--ink)] truncate m-0">{space.name}</p>
          <p className="font-mono text-[0.7rem] text-[var(--oxidized)] truncate m-0">
            {space.rateSummary}
          </p>
        </div>
        <Link href={directBookHref} className="btn-primary py-2.5 px-4 text-xs shrink-0">
          {t.venue.requestSpace}
        </Link>
      </div>
    </div>
  );
}
