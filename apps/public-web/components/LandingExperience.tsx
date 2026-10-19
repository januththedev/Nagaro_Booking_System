"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { clientApiPath } from "../lib/api";
import { isoDateInColombo, spaceMeta } from "../lib/format";
import { OFFICIAL_MEDIA, coverFor } from "../lib/media";
import type { Availability, PublicSpace } from "../lib/types";

const HeroWebGLCanvas = dynamic(() => import("./HeroWebGLCanvas"), {
  ssr: false,
});

const NARRATIVE_CHAPTERS = [
  {
    key: "Meet",
    verb: "Meet",
    headline: "Quiet acoustic rooms for board reviews, sprint planning and executive alignment.",
    body: "High-ceilinged meeting studios set behind brick colonnades isolate teams from city noise while keeping wall-mounted projection, whiteboards and enterprise fibre within arm’s reach.",
    caption: "Idea Studio · intimate table geometry for 10 to 30 participants",
    image: OFFICIAL_MEDIA.studio,
    alt: "TRACE Idea Studio arranged for a focused team session",
    filterHref: "/spaces?category=MEETING_ROOM",
  },
  {
    key: "Make",
    verb: "Make",
    headline: "Open-span coworking bays engineered for deep engineering and design residencies.",
    body: "Long timber workbenches under exposed steel trusses give individual builders and visiting squads a permanent-feeling desk for a day, a week or a month.",
    caption: "Coworking Hall · individual desks Allocated per unit in real time",
    image: OFFICIAL_MEDIA.coworking,
    alt: "Active coworking floor inside the restored brick-and-steel hall at TRACE Expert City",
    filterHref: "/spaces?category=COWORKING",
  },
  {
    key: "Gather",
    verb: "Gather",
    headline: "Daylit training halls and seminar rooms that adapt to workshops and cohorts.",
    body: "Modular seating, dual-display sightlines and direct courtyard access let educators, accelerators and engineering leaders run full-day intensives without hotel-ballroom sterility.",
    caption: "Creator Space · configured for hands-on cohorts and technical forums",
    image: OFFICIAL_MEDIA.creator,
    alt: "Creator Space at TRACE Expert City during an interactive presentation",
    filterHref: "/spaces?category=MEETING_ROOM",
  },
  {
    key: "Launch",
    verb: "Launch",
    headline: "Industrial-scale auditorium and event bays for keynotes, screenings and town halls.",
    body: "Restored warehouse spans accommodate raked seating, stage lighting rigs and full-room audio so flagship announcements command architectural presence.",
    caption: "Bay 07 & Auditorium · full production scale in central Colombo",
    image: OFFICIAL_MEDIA.bay,
    alt: "Bay 07 brick event hall staged with conference lighting at TRACE Expert City",
    filterHref: "/spaces?category=AUDITORIUM",
  },
] as const;

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
    message: "Select a venue and Sri Lanka Standard Time window to inspect live inventory before checkout.",
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
      setBridgeStatus({ state: "error", message: "Choose a published venue to check." });
      return;
    }
    const startIso = `${bridgeDate}T${bridgeStart}:00+05:30`;
    const endIso = `${bridgeDate}T${bridgeEnd}:00+05:30`;
    if (Date.parse(endIso) <= Date.parse(startIso)) {
      setBridgeStatus({ state: "error", message: "End time must be after the start time." });
      return;
    }
    setBridgeStatus({ state: "checking", message: "Checking live occupancy ledger…" });
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
          message: body?.error?.message || "Could not verify that window. Try another time.",
        });
        return;
      }
      if (body.isAvailable) {
        setBridgeStatus({
          state: "ok",
          message: body.isPooled
            ? `Available — ${body.freeUnits} of ${body.totalUnits} desks open for immediate confirmation.`
            : `Available — ${body.spaceName} is open for immediate confirmation in this window.`,
        });
      } else {
        setBridgeStatus({
          state: "busy",
          message: body.label || "That window is already committed. Choose an adjacent time.",
        });
      }
    } catch {
      setBridgeStatus({
        state: "error",
        message: "Live availability service could not be reached. You can still proceed to booking.",
      });
    }
  }

  const bookingBridgeHref = bridgeSpace
    ? `/book?space=${encodeURIComponent(bridgeSpace)}&date=${encodeURIComponent(bridgeDate)}&start=${encodeURIComponent(bridgeStart)}&end=${encodeURIComponent(bridgeEnd)}`
    : "/book";

  return (
    <div className="flex flex-col">
      {/* FULL-VIEWPORT ARCHITECTURAL ARRIVAL */}
      <section
        aria-label="TRACE Spaces arrival"
        className="relative min-h-[calc(100dvh-4.5rem)] w-full surface-dark flex flex-col justify-end overflow-hidden"
      >
        <picture className="absolute inset-0 w-full h-full">
          <img
            src={OFFICIAL_MEDIA.hero}
            alt="Restored red-brick warehouse arches framed by mature trees at TRACE Expert City, Colombo"
            fetchPriority="high"
            className="w-full h-full object-cover opacity-75"
          />
        </picture>

        <HeroWebGLCanvas imageSrc={OFFICIAL_MEDIA.hero} />

        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-t from-[#0d110f] via-[#0d110f]/55 to-transparent pointer-events-none"
        />

        <div className="relative z-10 mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 pt-10 pb-8 sm:pt-16 sm:pb-16 grid grid-cols-1 lg:grid-cols-12 gap-8 items-end">
          <div className="lg:col-span-8 flex flex-col gap-4 sm:gap-5">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--chartreuse)]">
              TRACE Expert City · Maradana · Colombo 10
            </p>
            <h1 className="font-display text-[2rem] sm:text-6xl lg:text-[4.65rem] text-[var(--bone)] leading-[1.03]">
              Brick bays, timber spans and working halls for teams that build in public.
            </h1>
            <p className="text-base sm:text-lg text-[var(--bone)]/85 max-w-2xl">
              Reserve boardrooms, training studios, coworking benches and the grand auditorium inside
              Colombo’s restored nineteenth-century warehouse campus—backed by a live, conflict-proof
              booking ledger.
            </p>
            <div className="hero-actions flex flex-wrap items-center gap-2 sm:gap-3 pt-2">
              <Link href="/spaces" className="btn-chartreuse">
                Explore spaces
              </Link>
              <Link href="/book" className="btn-outline text-[var(--bone)]">
                Book now
              </Link>
            </div>
          </div>

          <div className="lg:col-span-4 border-t lg:border-t-0 lg:border-l border-[var(--rule-dark)] pt-4 lg:pt-0 lg:pl-6 flex flex-col gap-2 text-xs font-mono text-[var(--bone)]/75">
            <span className="uppercase tracking-[0.14em] text-[var(--chartreuse)]">
              Campus coordinates
            </span>
            <span>Trippane Road · Maradana Railway Precinct</span>
            <span>Time zone: Asia/Colombo (SLST · UTC+05:30)</span>
            <span>Direct online confirmation &amp; LKR offline settlement</span>
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
              Architectural character
            </p>
            <h2 className="font-display text-3xl sm:text-5xl text-[var(--ink)]">
              Industrial permanence adapted for contemporary engineering and discourse.
            </h2>
          </div>
          <div className="lg:col-span-7 flex flex-col gap-6 text-base sm:text-lg text-[var(--graphite)]">
            <p>
              Built across historic load-bearing masonry bays in Maradana, TRACE Expert City pairs
              deep brick arcades, cast-iron trusses and shaded water courts with acoustic glass
              enclosures, high-density fibre and production-grade audiovisual rigs.
            </p>
            <p className="text-sm font-mono uppercase tracking-[0.1em] text-[var(--ink)]">
              Load-bearing kiln brick · Cast-iron roof spans · Tropical courtyard canopy · Studio daylight
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
            <span>TRACE Expert City — restored warehouse bays along the Maradana precinct</span>
            <span>Official campus photography</span>
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
              Campus manifesto
            </p>
            <h2 className="font-display text-3xl sm:text-5xl text-[var(--ink)]">
              Rooms with weight, proportion and natural light change how people think together.
            </h2>
            <p className="text-[var(--graphite)]">
              Whether you are convening a twelve-person architecture review, hosting a 400-delegate
              keynote or claiming a quiet desk for the week, every space at TRACE is operated as a
              real architectural room—never a partitioned convention booth.
            </p>
            <div className="pt-2 flex flex-wrap gap-3">
              <Link href="/spaces" className="btn-primary">
                Inspect all venues
              </Link>
              <Link href="/booking-request" className="btn-outline">
                Concierge brief
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* STICKY VERTICAL MEDIA CHAPTER: MEET, MAKE, GATHER, LAUNCH */}
      <section className="surface-dark py-20 sm:py-28 hairline-t hairline-b">
        <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10">
          <div className="max-w-3xl mb-14">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--chartreuse)]">
              Spatial programme
            </p>
            <h2 className="font-display text-3xl sm:text-5xl text-[var(--bone)] mt-2">
              Four ways the campus works across a single week.
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
                    {NARRATIVE_CHAPTERS[activeChapter]?.verb}
                  </span>
                  <span className="font-mono text-xs text-[var(--chartreuse)]">
                    {NARRATIVE_CHAPTERS[activeChapter]?.caption}
                  </span>
                </div>
              </div>
            </div>

            <div className="lg:col-span-6 flex flex-col divide-y divide-[var(--rule-dark)]">
              {NARRATIVE_CHAPTERS.map((chapter, index) => {
                const isCurrent = activeChapter === index;
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
                        {chapter.verb}
                      </span>
                      <span className="font-mono text-xs text-[var(--bone)]/60">
                        {chapter.caption}
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
                      {chapter.headline}
                    </h3>
                    <p className="text-[var(--bone)]/75 text-base leading-relaxed">
                      {chapter.body}
                    </p>
                    <div className="pt-1">
                      <Link
                        href={chapter.filterHref}
                        className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--chartreuse)] hover:underline no-underline"
                      >
                        Explore {chapter.verb.toLowerCase()} venues →
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
              Published venue ledger
            </p>
            <h2 className="font-display text-3xl sm:text-5xl text-[var(--ink)] mt-2">
              Spaces open for direct reservation at TRACE Expert City.
            </h2>
          </div>
          <Link href="/spaces" className="btn-outline">
            Full venue catalogue →
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
                        Venue specifications →
                      </Link>
                      <Link
                        href={`/book?space=${encodeURIComponent(space.code)}`}
                        className="btn-primary py-2 px-3.5 text-xs"
                      >
                        Book venue
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
              Venue catalogue is currently being updated.
            </p>
            <p className="text-sm text-[var(--graphite)] mt-2">
              You can still submit a bespoke request through our concierge desk.
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
              Live availability bridge
            </p>
            <h2 className="font-display text-3xl sm:text-4xl text-[var(--ink)]">
              Test a window against the booking ledger, then lock it in.
            </h2>
            <p className="text-sm text-[var(--graphite)]">
              Every query checks active room and desk allocations in Sri Lanka Standard Time
              (UTC+05:30), including turnaround buffers and scheduled maintenance blocks.
            </p>
          </div>

          <div className="lg:col-span-7 hairline-box bg-[var(--paper-card)] p-5 sm:p-7">
            <form onSubmit={handleBridgeCheck} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2 flex flex-col gap-1.5">
                <label htmlFor="bridge-space" className="font-mono text-xs uppercase tracking-wider">
                  Venue
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
                  Date (SLST)
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
                    Start
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
                    End
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
                  Check live availability
                </button>
                <Link href={bookingBridgeHref} className="btn-primary">
                  Continue to direct booking →
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
            Reserve at TRACE Expert City
          </p>
          <h2 className="font-display text-4xl sm:text-6xl text-[var(--bone)]">
            Claim your room, desk or hall in Colombo’s innovation precinct.
          </h2>
          <p className="text-base sm:text-lg text-[var(--bone)]/80 max-w-2xl">
            Direct bookings confirm immediately and issue a private capability link for managing
            your reservation. Complex multi-space or custom AV productions can also be routed to our
            concierge team.
          </p>
          <div className="flex flex-wrap items-center gap-4 pt-2">
            <Link href="/book" className="btn-chartreuse">
              Book now
            </Link>
            <Link href="/spaces" className="btn-outline text-[var(--bone)]">
              Explore spaces
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
