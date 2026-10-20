"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { clientApiPath } from "../lib/api";
import { isoDateInColombo, spaceMeta } from "../lib/format";
import { format } from "../lib/i18n";
import { OFFICIAL_MEDIA, coverFor } from "../lib/media";
import type { Availability, PublicSpace } from "../lib/types";
import { useT } from "./I18nProvider";

const HeroWebGLCanvas = dynamic(() => import("./HeroWebGLCanvas"), {
  ssr: false,
});

const NARRATIVE_CHAPTERS = [
  {
    key: "Meet",
    image: OFFICIAL_MEDIA.studio,
    alt: "TRACE Idea Studio arranged for a focused team session",
    filterHref: "/spaces?category=MEETING_ROOM",
  },
  {
    key: "Make",
    image: OFFICIAL_MEDIA.coworking,
    alt: "Active coworking floor inside the restored brick-and-steel hall at TRACE Expert City",
    filterHref: "/spaces?category=COWORKING",
  },
  {
    key: "Gather",
    image: OFFICIAL_MEDIA.creator,
    alt: "Creator Space at TRACE Expert City during an interactive presentation",
    filterHref: "/spaces?category=MEETING_ROOM",
  },
  {
    key: "Launch",
    image: OFFICIAL_MEDIA.bay,
    alt: "Bay 07 brick event hall staged with conference lighting at TRACE Expert City",
    filterHref: "/spaces?category=AUDITORIUM",
  },
] as const;

/** Maps each chapter key onto its t.programme.chapters slug. */
const CHAPTER_TEXT_KEYS = {
  Meet: "meet",
  Make: "make",
  Gather: "gather",
  Launch: "launch",
} as const;

const GALLERY_RATIOS = [
  "aspect-[16/10]",
  "aspect-[4/5]",
  "aspect-[16/9]",
  "aspect-[3/2]",
  "aspect-[16/10]",
] as const;

const GALLERY_SPANS = [
  "lg:col-span-7",
  "lg:col-span-5 lg:mt-16",
  "lg:col-span-5",
  "lg:col-span-7 lg:-mt-12",
  "lg:col-span-8",
] as const;

export function LandingExperience({ spaces }: { spaces: PublicSpace[] }) {
  const t = useT();
  const [activeChapter, setActiveChapter] = useState<number>(0);
  const chapterRefs = useRef<Array<HTMLElement | null>>([]);

  const defaultSpace = spaces[0]?.code ?? "";
  const [bridgeSpace, setBridgeSpace] = useState<string>(defaultSpace);
  const [bridgeDate, setBridgeDate] = useState<string>(() => isoDateInColombo(2));
  const [bridgeStart, setBridgeStart] = useState<string>("09:00");
  const [bridgeEnd, setBridgeEnd] = useState<string>("11:00");
  const [bridgeStatus, setBridgeStatus] = useState<{
    state: "idle" | "checking" | "ok" | "busy" | "error";
    message: string;
  }>({
    state: "idle",
    message: t.bridge.idle,
  });

  useEffect(() => {
    if (!bridgeSpace && spaces[0]?.code) {
      setBridgeSpace(spaces[0].code);
    }
  }, [spaces, bridgeSpace]);

  useEffect(() => {
    const nodes = chapterRefs.current.filter((n): n is HTMLElement => Boolean(n));
    if (!nodes.length || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = Number((entry.target as HTMLElement).dataset.chapterIndex ?? 0);
            if (Number.isFinite(idx)) setActiveChapter(idx);
          }
        }
      },
      { rootMargin: "-28% 0px -42% 0px", threshold: 0.15 },
    );

    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, []);

  async function handleBridgeCheck(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bridgeSpace) {
      setBridgeStatus({ state: "error", message: t.bridge.errorChoose });
      return;
    }
    const startIso = `${bridgeDate}T${bridgeStart}:00+05:30`;
    const endIso = `${bridgeDate}T${bridgeEnd}:00+05:30`;
    if (Date.parse(endIso) <= Date.parse(startIso)) {
      setBridgeStatus({ state: "error", message: t.bridge.errorOrder });
      return;
    }
    setBridgeStatus({ state: "checking", message: t.bridge.checking });
    try {
      const qs = new URLSearchParams({
        space: bridgeSpace,
        start: startIso,
        end: endIso,
        desks: "1",
      });
      const res = await fetch(clientApiPath(`/api/public/availability?${qs.toString()}`), {
        headers: { Accept: "application/json" },
      });
      const body = (await res.json().catch(() => null)) as
        | (Availability & { error?: { message?: string } })
        | null;
      if (!res.ok || !body) {
        setBridgeStatus({
          state: "error",
          message: body?.error?.message || t.bridge.errorWindow,
        });
        return;
      }
      if (body.isAvailable) {
        setBridgeStatus({
          state: "ok",
          message: body.isPooled
            ? format(t.bridge.okPooled, { free: body.freeUnits, total: body.totalUnits })
            : format(t.bridge.okSingle, { name: body.spaceName }),
        });
      } else {
        setBridgeStatus({
          state: "busy",
          message: body.label || t.bridge.busyFallback,
        });
      }
    } catch {
      setBridgeStatus({
        state: "error",
        message: t.bridge.errorService,
      });
    }
  }

  const bookingBridgeHref = bridgeSpace
    ? `/spaces/${encodeURIComponent(bridgeSpace)}/book`
    : "/spaces";

  const activeChapterData = NARRATIVE_CHAPTERS[activeChapter];
  const activeChapterText = activeChapterData
    ? t.programme.chapters[CHAPTER_TEXT_KEYS[activeChapterData.key]]
    : undefined;

  return (
    <div className="flex flex-col">
      {/* FULL-VIEWPORT ARCHITECTURAL ARRIVAL */}
      <section
        aria-label="TRACE Spaces arrival"
        className="relative min-h-[100svh] sm:min-h-[100dvh] w-full surface-dark flex flex-col justify-end overflow-hidden"
      >
        <picture className="absolute inset-0 w-full h-full">
          <img
            src={OFFICIAL_MEDIA.hero}
            alt={t.hero.imageAlt}
            fetchPriority="high"
            className="w-full h-full object-cover opacity-85 scale-[1.015]"
          />
        </picture>

        <HeroWebGLCanvas imageSrc={OFFICIAL_MEDIA.hero} />

        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[linear-gradient(90deg,rgba(7,11,9,0.82)_0%,rgba(7,11,9,0.38)_58%,rgba(7,11,9,0.08)_100%),linear-gradient(0deg,rgba(7,11,9,0.9)_0%,rgba(7,11,9,0.12)_65%)] pointer-events-none"
        />

        <div
          aria-hidden="true"
          className="hidden sm:block absolute -right-[0.03em] top-[13%] z-[1] font-display text-[clamp(10rem,22vw,22rem)] leading-none tracking-[-0.08em] text-transparent opacity-[0.16] pointer-events-none [-webkit-text-stroke:1px_rgba(244,241,234,0.8)]"
        >
          TRACE
        </div>

        <div className="relative z-10 mx-auto w-full max-w-[96rem] px-4 sm:px-6 lg:px-10 pt-28 pb-7 sm:pt-36 sm:pb-14 grid grid-cols-1 lg:grid-cols-12 gap-8 items-end">
          <div className="hero-arrival lg:col-span-9 flex flex-col gap-4 sm:gap-5">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--chartreuse)]">
              {t.hero.eyebrow}
            </p>
            <h1 className="font-display text-[2.7rem] sm:text-[clamp(4.25rem,7vw,7.35rem)] text-[var(--bone)] leading-[0.9] tracking-[-0.045em] max-w-[12ch]">
              {t.hero.headline}
            </h1>
            <p className="text-[0.98rem] sm:text-lg text-[var(--bone)]/82 max-w-xl leading-relaxed">
              {t.hero.body}
            </p>
            <div className="hero-actions flex flex-wrap items-center gap-2 sm:gap-3 pt-2">
              <Link href="/spaces" className="btn-chartreuse">
                {t.hero.exploreCta}
              </Link>
              <Link href="/spaces" className="btn-outline text-[var(--bone)]">{t.hero.bookCta}</Link>
            </div>
          </div>

          <div className="hidden lg:col-span-3 lg:border-l border-[var(--rule-dark)] lg:pl-6 lg:flex flex-col gap-2 text-xs font-mono text-[var(--bone)]/70">
            <span className="uppercase tracking-[0.14em] text-[var(--chartreuse)]">
              {t.hero.enterLabel}
            </span>
            <span>{t.hero.address}</span>
            <span>{t.hero.liveLine}</span>
            <span>{t.hero.scaleLine}</span>
            <span className="mt-5 uppercase tracking-[0.16em] text-[var(--bone)]/50">{t.hero.scrollNote} ↓</span>
          </div>
        </div>
      </section>

      {/* HERITAGE & ARCHITECTURAL CHARACTER */}
      <section
        data-editorial-reveal
        className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-20 sm:py-28 hairline-b"
      >
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-start">
          <div className="lg:col-span-5 flex flex-col gap-4">
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--brick)]">
              {t.heritage.eyebrow}
            </p>
            <h2 className="font-display text-3xl sm:text-5xl text-[var(--ink)]">
              {t.heritage.headline}
            </h2>
          </div>
          <div className="lg:col-span-7 flex flex-col gap-6 text-base sm:text-lg text-[var(--graphite)]">
            <p>
              {t.heritage.body}
            </p>
            <p className="text-sm font-mono uppercase tracking-[0.1em] text-[var(--ink)]">
              {t.heritage.facts}
            </p>
          </div>
        </div>

        <figure className="mt-12 m-0">
          <div className="aspect-[21/9] w-full overflow-hidden bg-[var(--concrete)] hairline-box">
            <img
              src={OFFICIAL_MEDIA.longExterior}
              alt="Long exterior perspective of TRACE Expert City's restored red-brick warehouse bays and courtyard greenery"
              loading="lazy"
              className="w-full h-full object-cover"
            />
          </div>
          <figcaption className="mt-3 flex flex-wrap justify-between gap-2 font-mono text-xs text-[var(--graphite)]">
            <span>{t.heritage.figureCaption}</span>
            <span>{t.heritage.figureCredit}</span>
          </figcaption>
        </figure>
      </section>

      {/* OVERLAPPING-IMAGE MANIFESTO */}
      <section
        data-editorial-reveal
        className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-20 sm:py-28"
      >
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
          <div className="lg:col-span-7 relative">
            <div className="aspect-[16/10] w-full sm:w-5/6 overflow-hidden hairline-box bg-[var(--concrete)]">
              <img
                src={OFFICIAL_MEDIA.privateOffices}
                alt="Bright collaborative work table inside TRACE Expert City"
                loading="lazy"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="mt-6 sm:mt-0 sm:w-3/5 sm:ml-auto sm:-mt-20 relative z-10 aspect-[4/3] overflow-hidden hairline-box bg-[var(--paper-card)] p-2 shadow-sm">
              <img
                src={OFFICIAL_MEDIA.community}
                alt="Community gathering inside the Third Place Lobby at TRACE Expert City"
                loading="lazy"
                className="w-full h-full object-cover"
              />
            </div>
          </div>

          <div className="lg:col-span-5 flex flex-col gap-5">
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--oxidized)]">
              {t.manifesto.eyebrow}
            </p>
            <h2 className="font-display text-3xl sm:text-5xl text-[var(--ink)]">
              {t.manifesto.headline}
            </h2>
            <p className="text-[var(--graphite)]">
              {t.manifesto.body}
            </p>
            <div className="pt-2 flex flex-wrap gap-3">
              <Link href="/spaces" className="btn-primary">
                {t.manifesto.primaryCta}
              </Link>
              <Link href="/spaces" className="btn-outline">{t.manifesto.secondaryCta}</Link>
            </div>
          </div>
        </div>
      </section>

      {/* STICKY VERTICAL MEDIA CHAPTER: MEET, MAKE, GATHER, LAUNCH */}
      <section className="surface-dark py-20 sm:py-28 hairline-t hairline-b">
        <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10">
          <div className="max-w-3xl mb-14">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--chartreuse)]">
              {t.programme.eyebrow}
            </p>
            <h2 className="font-display text-3xl sm:text-5xl text-[var(--bone)] mt-2">
              {t.programme.headline}
            </h2>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-14 items-start">
            <div className="hidden lg:block lg:col-span-6 lg:sticky lg:top-28">
              <div className="relative aspect-[16/11] w-full overflow-hidden border border-[var(--rule-dark)] bg-[#141a17]">
                {NARRATIVE_CHAPTERS.map((chapter, index) => (
                  <img
                    key={chapter.key}
                    src={chapter.image}
                    alt={chapter.alt}
                    loading="lazy"
                    className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${
                      activeChapter === index ? "opacity-100" : "opacity-0"
                    }`}
                  />
                ))}
                <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-[#0d110f] via-[#0d110f]/80 to-transparent p-6 flex items-center justify-between gap-4">
                  <span className="font-display text-2xl text-[var(--bone)]">
                    {activeChapterText?.verb}
                  </span>
                  <span className="font-mono text-xs text-[var(--chartreuse)]">
                    {activeChapterText?.caption}
                  </span>
                </div>
              </div>
            </div>

            <div className="lg:col-span-6 flex flex-col divide-y divide-[var(--rule-dark)]">
              {NARRATIVE_CHAPTERS.map((chapter, index) => {
                const isCurrent = activeChapter === index;
                const chapterText = t.programme.chapters[CHAPTER_TEXT_KEYS[chapter.key]];
                return (
                  <article
                    key={chapter.key}
                    ref={(el) => {
                      chapterRefs.current[index] = el;
                    }}
                    data-chapter-index={index}
                    className="py-10 first:pt-0 last:pb-0 flex flex-col gap-4"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <span
                        className={`font-mono text-xs uppercase tracking-[0.18em] px-2.5 py-1 border ${
                          isCurrent
                            ? "border-[var(--chartreuse)] text-[var(--chartreuse)]"
                            : "border-[var(--rule-dark)] text-[var(--bone)]/60"
                        }`}
                      >
                        {chapterText.verb}
                      </span>
                      <span className="font-mono text-xs text-[var(--bone)]/60">
                        {chapterText.caption}
                      </span>
                    </div>

                    <div className="lg:hidden aspect-[16/10] w-full overflow-hidden border border-[var(--rule-dark)] my-2">
                      <img
                        src={chapter.image}
                        alt={chapter.alt}
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                    </div>

                    <h3 className="font-display text-2xl sm:text-4xl text-[var(--bone)]">
                      {chapterText.headline}
                    </h3>
                    <p className="text-[var(--bone)]/75 text-base leading-relaxed">
                      {chapterText.body}
                    </p>
                    <div className="pt-1">
                      <Link
                        href={chapter.filterHref}
                        className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--chartreuse)] hover:underline no-underline"
                      >
                        {chapterText.link} →
                      </Link>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ASYMMETRIC VENUE GALLERY USING REAL DETAIL LINKS */}
      <section
        data-editorial-reveal
        className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-20 sm:py-28 hairline-b"
      >
        <div className="flex flex-wrap items-end justify-between gap-6 mb-14">
          <div className="max-w-2xl">
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--brick)]">
              {t.ledger.eyebrow}
            </p>
            <h2 className="font-display text-3xl sm:text-5xl text-[var(--ink)] mt-2">
              {t.ledger.headline}
            </h2>
          </div>
          <Link href="/spaces" className="btn-outline">
            {t.ledger.catalogueCta} →
          </Link>
        </div>

        {spaces.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
            {spaces.map((space, idx) => {
              const cover = coverFor(space);
              const ratioClass = GALLERY_RATIOS[idx % GALLERY_RATIOS.length];
              const spanClass = GALLERY_SPANS[idx % GALLERY_SPANS.length];
              return (
                <article
                  key={space.code}
                  className={`${spanClass} flex flex-col gap-4 hairline-b pb-8`}
                >
                  <Link
                    href={`/spaces/${encodeURIComponent(space.code)}`}
                    className={`group block ${ratioClass} w-full overflow-hidden hairline-box bg-[var(--concrete)] relative no-underline`}
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
                  </Link>

                  <div className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-xs text-[var(--graphite)]">
                    <span>{spaceMeta(space)}</span>
                    <code className="text-[var(--ink)]">{space.code}</code>
                  </div>

                  <h3 className="font-display text-2xl sm:text-3xl text-[var(--ink)] m-0">
                    <Link
                      href={`/spaces/${encodeURIComponent(space.code)}`}
                      className="no-underline hover:underline text-[var(--ink)]"
                    >
                      {space.name}
                    </Link>
                  </h3>

                  {space.shortDescription ? (
                    <p className="text-sm text-[var(--graphite)] m-0">{space.shortDescription}</p>
                  ) : null}

                  <div className="pt-2 flex flex-wrap items-center justify-between gap-4">
                    <span className="font-mono text-xs font-medium text-[var(--oxidized)]">
                      {space.rateSummary}
                    </span>
                    <div className="flex flex-wrap items-center gap-3">
                      <Link
                        href={`/spaces/${encodeURIComponent(space.code)}`}
                        className="font-mono text-xs uppercase tracking-[0.12em] text-[var(--ink)] hover:text-[var(--brick)]"
                      >
                        {t.ledger.specsCta} →
                      </Link>
                      <Link
                        href={`/spaces/${encodeURIComponent(space.code)}/book`}
                        className="btn-primary py-2 px-3.5 text-xs"
                      >
                        {t.ledger.bookVenue}
                      </Link>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="hairline-box bg-[var(--paper-card)] p-8">
            <p className="font-display text-2xl text-[var(--ink)]">
              {t.ledger.emptyTitle}
            </p>
            <p className="text-sm text-[var(--graphite)] mt-2">
              {t.ledger.emptyBody}
            </p>
          </div>
        )}
      </section>

      {/* LIVE AVAILABILITY BRIDGE INTO BOOKING */}
      <section
        data-editorial-reveal
        className="surface-concrete hairline-b py-16 sm:py-24"
      >
        <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
          <div className="lg:col-span-5 flex flex-col gap-3">
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--oxidized)]">
              {t.bridge.eyebrow}
            </p>
            <h2 className="font-display text-3xl sm:text-4xl text-[var(--ink)]">
              {t.bridge.headline}
            </h2>
            <p className="text-sm text-[var(--graphite)]">
              {t.bridge.body}
            </p>
          </div>

          <div className="lg:col-span-7 hairline-box bg-[var(--paper-card)] p-5 sm:p-7">
            <form onSubmit={handleBridgeCheck} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2 flex flex-col gap-1.5">
                <label htmlFor="bridge-space" className="font-mono text-xs uppercase tracking-wider">
                  {t.bridge.venueLabel}
                </label>
                <select
                  id="bridge-space"
                  value={bridgeSpace}
                  onChange={(e) => setBridgeSpace(e.target.value)}
                  className="field-input"
                >
                  {spaces.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name} ({s.categoryLabel} · {s.rateSummary})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="bridge-date" className="font-mono text-xs uppercase tracking-wider">
                  {t.bridge.dateLabel}
                </label>
                <input
                  id="bridge-date"
                  type="date"
                  value={bridgeDate}
                  onChange={(e) => setBridgeDate(e.target.value)}
                  className="field-input"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="bridge-start" className="font-mono text-xs uppercase tracking-wider">
                    {t.bridge.startLabel}
                  </label>
                  <input
                    id="bridge-start"
                    type="time"
                    step={900}
                    value={bridgeStart}
                    onChange={(e) => setBridgeStart(e.target.value)}
                    className="field-input"
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="bridge-end" className="font-mono text-xs uppercase tracking-wider">
                    {t.bridge.endLabel}
                  </label>
                  <input
                    id="bridge-end"
                    type="time"
                    step={900}
                    value={bridgeEnd}
                    onChange={(e) => setBridgeEnd(e.target.value)}
                    className="field-input"
                    required
                  />
                </div>
              </div>

              <div
                role="status"
                aria-live="polite"
                className={`sm:col-span-2 p-3.5 text-sm border-l-4 ${
                  bridgeStatus.state === "ok"
                    ? "border-[var(--oxidized)] bg-[#e6f2ec] text-[var(--oxidized)]"
                    : bridgeStatus.state === "busy" || bridgeStatus.state === "error"
                      ? "border-[var(--brick)] bg-[#faeae6] text-[var(--brick)]"
                      : "border-[var(--ink)]/30 bg-[var(--concrete)]/60 text-[var(--graphite)]"
                }`}
              >
                {bridgeStatus.message}
              </div>

              <div className="sm:col-span-2 flex flex-wrap items-center gap-3 pt-1">
                <button type="submit" className="btn-outline">
                  {t.bridge.checkCta}
                </button>
                <Link href={bookingBridgeHref} className="btn-primary">
                  {t.bridge.requestCta} →
                </Link>
              </div>
            </form>
          </div>
        </div>
      </section>

      {/* FULL-BLEED CLOSING IMAGE & DECISIVE BOOKING CTA */}
      <section className="relative surface-dark py-24 sm:py-32 overflow-hidden">
        <img
          src={OFFICIAL_MEDIA.outdoor}
          alt="TRACE Expert City outdoor courtyard and water feature at dusk"
          loading="lazy"
          className="absolute inset-0 w-full h-full object-cover opacity-35"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-r from-[#0d110f] via-[#0d110f]/85 to-[#0d110f]/55 pointer-events-none"
        />
        <div className="relative z-10 mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 flex flex-col gap-6 max-w-3xl">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--chartreuse)]">
            {t.closing.eyebrow}
          </p>
          <h2 className="font-display text-4xl sm:text-6xl text-[var(--bone)]">
            {t.closing.headline}
          </h2>
          <p className="text-base sm:text-lg text-[var(--bone)]/80 max-w-2xl">
            {t.closing.body}
          </p>
          <div className="flex flex-wrap items-center gap-4 pt-2">
            <Link href="/spaces" className="btn-chartreuse">{t.closing.bookCta}</Link>
            <Link href="/spaces" className="btn-outline text-[var(--bone)]">
              {t.closing.exploreCta}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
