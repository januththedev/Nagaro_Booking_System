"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { clientApiPath } from "../lib/api";
import { formatMoney, isoDateInColombo, spaceMeta } from "../lib/format";
import { coverFor } from "../lib/media";
import { estimateBookingQuote } from "../lib/quote";
import type { Availability, PublicSpace, Reservation } from "../lib/types";

type StageName = "Space & time" | "Your details" | "Review & confirm";
const STAGES: StageName[] = ["Space & time", "Your details", "Review & confirm"];

export function DirectBookingForm({
  spaces,
  initialSpaceCode = "",
  initialDate = "",
  initialStart = "",
  initialEnd = "",
  initialDesks = "1",
  initialFormToken,
}: {
  spaces: PublicSpace[];
  initialSpaceCode?: string;
  initialDate?: string;
  initialStart?: string;
  initialEnd?: string;
  initialDesks?: string;
  initialFormToken: string;
}) {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [activeStage, setActiveStage] = useState<StageName>("Space & time");

  const [spaceCode, setSpaceCode] = useState(
    initialSpaceCode.toUpperCase() || spaces[0]?.code || "",
  );
  const [date, setDate] = useState(initialDate || isoDateInColombo(2));
  const [startTime, setStartTime] = useState(initialStart || "09:00");
  const [endTime, setEndTime] = useState(initialEnd || "11:00");
  const [desks, setDesks] = useState(initialDesks || "1");
  const [attendees, setAttendees] = useState("6");
  const [purpose, setPurpose] = useState("");

  const [customerName, setCustomerName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [organization, setOrganization] = useState("");

  const [formToken] = useState(initialFormToken);
  const [availability, setAvailability] = useState<{
    state: "idle" | "checking" | "ok" | "busy" | "error";
    message: string;
  }>({
    state: "idle",
    message: "Live availability will be verified for your selected window.",
  });

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  const selectedSpace = useMemo(
    () => spaces.find((s) => s.code.toUpperCase() === spaceCode.toUpperCase()) ?? spaces[0],
    [spaces, spaceCode],
  );

  const quote = useMemo(
    () =>
      estimateBookingQuote(
        selectedSpace,
        date,
        startTime,
        endTime,
        Math.max(1, Number(desks) || 1),
      ),
    [selectedSpace, date, startTime, endTime, desks],
  );

  useEffect(() => {
    if (!selectedSpace || !date || !startTime || !endTime) return;
    const startIso = `${date}T${startTime}:00+05:30`;
    const endIso = `${date}T${endTime}:00+05:30`;
    if (Date.parse(endIso) <= Date.parse(startIso)) {
      setAvailability({
        state: "error",
        message: "The end time must be after the start time.",
      });
      return;
    }

    let cancelled = false;
    setAvailability({ state: "checking", message: "Checking live occupancy ledger…" });

    const timer = window.setTimeout(async () => {
      try {
        const qs = new URLSearchParams({
          space: selectedSpace.code,
          start: startIso,
          end: endIso,
          desks:
            selectedSpace.category === "COWORKING"
              ? String(Math.max(1, Number(desks) || 1))
              : "1",
        });
        const res = await fetch(clientApiPath(`/api/public/availability?${qs.toString()}`), {
          headers: { Accept: "application/json" },
        });
        if (cancelled) return;
        const body = (await res.json().catch(() => null)) as
          | (Availability & { error?: { message?: string } })
          | null;
        if (!res.ok || !body) {
          setAvailability({
            state: "error",
            message: body?.error?.message || "Window falls outside operating rules.",
          });
          return;
        }
        if (body.isAvailable) {
          setAvailability({
            state: "ok",
            message: body.isPooled
              ? `Available — ${body.freeUnits} of ${body.totalUnits} desks open for immediate confirmation.`
              : `Available — ${selectedSpace.name} is open for immediate confirmation.`,
          });
        } else {
          setAvailability({
            state: "busy",
            message: body.label || "This window conflicts with an existing booking or maintenance block.",
          });
        }
      } catch {
        if (!cancelled) {
          setAvailability({
            state: "idle",
            message: "Availability will be verified inside the booking transaction on submit.",
          });
        }
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedSpace, date, startTime, endTime, desks]);

  function validateStageOne(): boolean {
    const errs: Record<string, string> = {};
    if (!selectedSpace) errs.space_code = "Choose a published venue.";
    if (!date) errs.date = "Choose a date.";
    if (!startTime) errs.start_time = "Choose a start time.";
    if (!endTime) errs.end_time = "Choose an end time.";
    if (date && startTime && endTime) {
      const s = Date.parse(`${date}T${startTime}:00+05:30`);
      const e = Date.parse(`${date}T${endTime}:00+05:30`);
      if (e <= s) errs.end_time = "End time must be after the start time.";
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function validateStageTwo(): boolean {
    const errs: Record<string, string> = {};
    if (!customerName.trim()) errs.customer_name = "Enter your full name.";
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errs.email = "Enter a valid email address for your booking receipt.";
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (!validateStageOne()) {
      setActiveStage("Space & time");
      return;
    }
    if (!validateStageTwo()) {
      setActiveStage("Your details");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    setFieldErrors({});

    try {
      const res = await fetch(clientApiPath("/api/public/bookings"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          form_token: formToken,
          space_code: selectedSpace?.code ?? spaceCode,
          date,
          start_time: startTime,
          end_time: endTime,
          desks: selectedSpace?.category === "COWORKING" ? desks : "1",
          attendees,
          message: purpose,
          customer_name: customerName,
          email,
          phone,
          organization,
        }),
      });

      const payload = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: {
          reservation: Reservation;
          manageToken: string | null;
          managePath: string | null;
          idempotent: boolean;
        };
        error?: {
          code?: string;
          message?: string;
          details?: Record<string, string | string[]>;
        };
      } | null;

      if (!res.ok || !payload?.ok || !payload.data) {
        const details = payload?.error?.details ?? {};
        const nextFieldErrors: Record<string, string> = {};
        for (const [k, v] of Object.entries(details)) {
          if (typeof v === "string") nextFieldErrors[k] = v;
        }
        setFieldErrors(nextFieldErrors);
        setSubmitError(
          payload?.error?.message ||
            "Could not confirm this reservation. Please review the highlighted fields.",
        );
        if (nextFieldErrors.space_code || nextFieldErrors.date || nextFieldErrors.start_time || nextFieldErrors.end_time) {
          setActiveStage("Space & time");
        } else if (nextFieldErrors.customer_name || nextFieldErrors.email || nextFieldErrors.phone) {
          setActiveStage("Your details");
        }
        setSubmitting(false);
        return;
      }

      const { reservation, manageToken } = payload.data;
      if (manageToken) {
        try {
          sessionStorage.setItem(
            `trace_booking_${reservation.reference}`,
            JSON.stringify({ reservation, manageToken }),
          );
        } catch {
          // Ignore storage quota errors
        }
        router.push(
          `/book/confirmed?ref=${encodeURIComponent(reservation.reference)}&token=${encodeURIComponent(manageToken)}`,
        );
      } else {
        router.push(`/book/confirmed?ref=${encodeURIComponent(reservation.reference)}`);
      }
    } catch {
      setSubmitError("Network error while confirming your booking. Please try again.");
      setSubmitting(false);
    }
  }

  const cover = selectedSpace ? coverFor(selectedSpace) : null;

  return (
    <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-12 sm:py-16">
      <header className="pb-10 hairline-b flex flex-col gap-3">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--oxidized)] m-0">
          Direct reservation checkout · Sri Lanka Standard Time
        </p>
        <h1 className="font-display text-4xl sm:text-6xl text-[var(--ink)] m-0">
          Confirm a space at TRACE Expert City.
        </h1>
        <p className="text-base sm:text-lg text-[var(--graphite)] max-w-2xl m-0">
          Direct checkout locks your room or desk allocation immediately inside the transactional
          booking engine and issues a private capability link. Need a custom multi-day or bespoke
          event brief instead?{" "}
          <Link href="/booking-request" className="text-[var(--brick)] underline">
            Submit a provisional concierge inquiry
          </Link>
          .
        </p>

        {/* NAMED STAGE BAR (NO NUMERIC PILLS) */}
        <nav aria-label="Booking stages" className="pt-4 flex flex-wrap gap-2">
          {STAGES.map((stage) => {
            const current = activeStage === stage;
            return (
              <button
                key={stage}
                type="button"
                aria-current={current ? "step" : undefined}
                onClick={() => setActiveStage(stage)}
                className={`font-mono text-xs uppercase tracking-[0.14em] px-4 py-2.5 border cursor-pointer transition-colors ${
                  current
                    ? "bg-[var(--ink)] text-[var(--bone)] border-[var(--ink)] font-medium"
                    : "bg-[var(--paper-card)] text-[var(--graphite)] border-[var(--rule-strong)] hover:text-[var(--ink)]"
                }`}
              >
                {stage}
              </button>
            );
          })}
        </nav>
      </header>

      {submitError ? (
        <div
          role="alert"
          className="mt-6 p-4 border-l-4 border-[var(--brick)] bg-[#faeae6] text-[var(--brick)] text-sm"
        >
          <p className="font-semibold m-0">{submitError}</p>
        </div>
      ) : null}

      <div className="pt-10 grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
        <div className="lg:col-span-7">
          <form method="post" action="/book" onSubmit={handleSubmit} noValidate className="flex flex-col gap-8">
            <input type="hidden" name="form_token" value={formToken} />

            {/* STAGE: SPACE & TIME */}
            <fieldset
              className={`hairline-box bg-[var(--paper-card)] p-6 sm:p-8 m-0 flex flex-col gap-5 ${
                hydrated && activeStage !== "Space & time" ? "hidden" : ""
              }`}
            >
              <legend className="font-display text-2xl sm:text-3xl text-[var(--ink)] px-1">
                Space &amp; time
              </legend>
              <p className="text-sm text-[var(--graphite)] m-0">
                All booking windows are evaluated in Sri Lanka Standard Time (Asia/Colombo,
                UTC+05:30).
              </p>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="space_code" className="font-mono text-xs uppercase tracking-wider">
                  Published venue *
                </label>
                <select
                  id="space_code"
                  name="space_code"
                  value={spaceCode}
                  onChange={(e) => setSpaceCode(e.target.value)}
                  aria-invalid={Boolean(fieldErrors.space_code)}
                  className="field-input"
                  required
                >
                  {spaces.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name} — {s.categoryLabel} ({s.rateSummary})
                    </option>
                  ))}
                </select>
                {fieldErrors.space_code ? (
                  <p role="alert" className="text-xs text-[var(--brick)] m-0">
                    {fieldErrors.space_code}
                  </p>
                ) : null}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="date" className="font-mono text-xs uppercase tracking-wider">
                    Date (SLST) *
                  </label>
                  <input
                    id="date"
                    name="date"
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    aria-invalid={Boolean(fieldErrors.date || fieldErrors.start_at)}
                    className="field-input"
                    required
                  />
                  {fieldErrors.date || fieldErrors.start_at ? (
                    <p role="alert" className="text-xs text-[var(--brick)] m-0">
                      {fieldErrors.date || fieldErrors.start_at}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="start_time" className="font-mono text-xs uppercase tracking-wider">
                    Start time *
                  </label>
                  <input
                    id="start_time"
                    name="start_time"
                    type="time"
                    step={900}
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    aria-invalid={Boolean(fieldErrors.start_time)}
                    className="field-input"
                    required
                  />
                  {fieldErrors.start_time ? (
                    <p role="alert" className="text-xs text-[var(--brick)] m-0">
                      {fieldErrors.start_time}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="end_time" className="font-mono text-xs uppercase tracking-wider">
                    End time *
                  </label>
                  <input
                    id="end_time"
                    name="end_time"
                    type="time"
                    step={900}
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    aria-invalid={Boolean(fieldErrors.end_time || fieldErrors.end_at)}
                    className="field-input"
                    required
                  />
                  {fieldErrors.end_time || fieldErrors.end_at ? (
                    <p role="alert" className="text-xs text-[var(--brick)] m-0">
                      {fieldErrors.end_time || fieldErrors.end_at}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="desks" className="font-mono text-xs uppercase tracking-wider">
                    Desks (co-working only)
                  </label>
                  <input
                    id="desks"
                    name="desks"
                    type="number"
                    min={1}
                    max={selectedSpace?.unitCount || 500}
                    value={desks}
                    onChange={(e) => setDesks(e.target.value)}
                    className="field-input"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="attendees" className="font-mono text-xs uppercase tracking-wider">
                    Expected attendees
                  </label>
                  <input
                    id="attendees"
                    name="attendees"
                    type="number"
                    min={1}
                    max={selectedSpace?.capacity || 1000}
                    value={attendees}
                    onChange={(e) => setAttendees(e.target.value)}
                    aria-invalid={Boolean(fieldErrors.attendees)}
                    className="field-input"
                  />
                  {fieldErrors.attendees ? (
                    <p role="alert" className="text-xs text-[var(--brick)] m-0">
                      {fieldErrors.attendees}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="message" className="font-mono text-xs uppercase tracking-wider">
                  Session purpose &amp; room setup notes (optional)
                </label>
                <textarea
                  id="message"
                  name="message"
                  rows={3}
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="e.g. Architecture sprint review, boardroom layout, HDMI projection"
                  className="field-input"
                />
              </div>

              {hydrated ? (
                <div className="pt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      if (validateStageOne()) setActiveStage("Your details");
                    }}
                    className="btn-primary"
                  >
                    Continue to your details →
                  </button>
                </div>
              ) : null}
            </fieldset>

            {/* STAGE: YOUR DETAILS */}
            <fieldset
              className={`hairline-box bg-[var(--paper-card)] p-6 sm:p-8 m-0 flex flex-col gap-5 ${
                hydrated && activeStage !== "Your details" ? "hidden" : ""
              }`}
            >
              <legend className="font-display text-2xl sm:text-3xl text-[var(--ink)] px-1">
                Your details
              </legend>
              <p className="text-sm text-[var(--graphite)] m-0">
                Recorded on your reservation for reception check-in at TRACE Expert City. Never
                exposed on public endpoints.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="customer_name" className="font-mono text-xs uppercase tracking-wider">
                    Full name *
                  </label>
                  <input
                    id="customer_name"
                    name="customer_name"
                    type="text"
                    autoComplete="name"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    aria-invalid={Boolean(fieldErrors.customer_name || fieldErrors.full_name)}
                    className="field-input"
                    required
                  />
                  {fieldErrors.customer_name || fieldErrors.full_name ? (
                    <p role="alert" className="text-xs text-[var(--brick)] m-0">
                      {fieldErrors.customer_name || fieldErrors.full_name}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="email" className="font-mono text-xs uppercase tracking-wider">
                    Email address *
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-invalid={Boolean(fieldErrors.email)}
                    className="field-input"
                    required
                  />
                  {fieldErrors.email ? (
                    <p role="alert" className="text-xs text-[var(--brick)] m-0">
                      {fieldErrors.email}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="phone" className="font-mono text-xs uppercase tracking-wider">
                    Telephone (optional)
                  </label>
                  <input
                    id="phone"
                    name="phone"
                    type="tel"
                    autoComplete="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+94 77 000 0000"
                    className="field-input"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="organization" className="font-mono text-xs uppercase tracking-wider">
                    Organisation (optional)
                  </label>
                  <input
                    id="organization"
                    name="organization"
                    type="text"
                    autoComplete="organization"
                    value={organization}
                    onChange={(e) => setOrganization(e.target.value)}
                    className="field-input"
                  />
                </div>
              </div>

              {hydrated ? (
                <div className="pt-2 flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setActiveStage("Space & time")}
                    className="btn-outline"
                  >
                    ← Back to space &amp; time
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (validateStageTwo()) setActiveStage("Review & confirm");
                    }}
                    className="btn-primary"
                  >
                    Continue to review &amp; confirm →
                  </button>
                </div>
              ) : null}
            </fieldset>

            {/* STAGE: REVIEW & CONFIRM */}
            <fieldset
              className={`hairline-box bg-[var(--paper-card)] p-6 sm:p-8 m-0 flex flex-col gap-5 ${
                hydrated && activeStage !== "Review & confirm" ? "hidden" : ""
              }`}
            >
              <legend className="font-display text-2xl sm:text-3xl text-[var(--ink)] px-1">
                Review &amp; confirm
              </legend>
              <p className="text-sm text-[var(--graphite)] m-0">
                Submitting this form executes an atomic reservation transaction against live
                inventory. If the slot is free, your booking is confirmed immediately.
              </p>

              <dl className="m-0 grid grid-cols-1 sm:grid-cols-2 gap-4 hairline-t hairline-b py-4 text-sm">
                <div>
                  <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                    Venue
                  </dt>
                  <dd className="m-0 mt-1 font-medium text-[var(--ink)]">
                    {selectedSpace?.name ?? spaceCode} ({selectedSpace?.code})
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                    Schedule (SLST)
                  </dt>
                  <dd className="m-0 mt-1 font-medium text-[var(--ink)]">
                    {date} · {startTime}–{endTime}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                    Guest &amp; contact
                  </dt>
                  <dd className="m-0 mt-1 font-medium text-[var(--ink)]">
                    {customerName || "—"} ({email || "—"})
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                    Estimated settlement
                  </dt>
                  <dd className="m-0 mt-1 font-mono font-semibold text-[var(--oxidized)]">
                    {quote && quote.validWindow
                      ? `${formatMoney(quote.totalCents)} (${quote.quantity} × ${quote.unitLabel})`
                      : selectedSpace?.rateSummary ?? "—"}
                  </dd>
                </div>
              </dl>

              <div className="flex flex-wrap items-center justify-between gap-3">
                {hydrated ? (
                  <button
                    type="button"
                    onClick={() => setActiveStage("Your details")}
                    className="btn-outline"
                  >
                    ← Edit details
                  </button>
                ) : null}
                <button
                  type="submit"
                  disabled={submitting}
                  aria-busy={submitting}
                  className="btn-primary"
                >
                  {submitting ? "Confirming reservation…" : "Confirm reservation now"}
                </button>
              </div>
            </fieldset>
          </form>
        </div>

        {/* LIVE SUMMARY & VENUE PREVIEW SIDEBAR */}
        <aside className="lg:col-span-5 lg:sticky lg:top-24 flex flex-col gap-6">
          {selectedSpace && cover ? (
            <div className="hairline-box bg-[var(--paper-card)] overflow-hidden">
              <div className="aspect-[16/10] w-full bg-[var(--concrete)] relative">
                <img
                  src={cover.src}
                  alt={cover.alt}
                  className="w-full h-full object-cover"
                />
                <span className="absolute top-3 left-3 bg-[var(--obsidian)]/85 text-[var(--bone)] font-mono text-[0.7rem] uppercase tracking-[0.14em] px-2.5 py-1">
                  {selectedSpace.categoryLabel}
                </span>
              </div>
              <div className="p-6 flex flex-col gap-4">
                <div>
                  <p className="font-mono text-xs text-[var(--graphite)] m-0">
                    {spaceMeta(selectedSpace)}
                  </p>
                  <h2 className="font-display text-2xl text-[var(--ink)] mt-1 mb-0">
                    {selectedSpace.name}
                  </h2>
                </div>

                <div
                  role="status"
                  aria-live="polite"
                  className={`p-3.5 text-xs font-mono border-l-4 ${
                    availability.state === "ok"
                      ? "border-[var(--oxidized)] bg-[#e6f2ec] text-[var(--oxidized)]"
                      : availability.state === "busy" || availability.state === "error"
                        ? "border-[var(--brick)] bg-[#faeae6] text-[var(--brick)]"
                        : "border-[var(--ink)]/30 bg-[var(--concrete)]/50 text-[var(--graphite)]"
                  }`}
                >
                  {availability.message}
                </div>

                {quote && quote.validWindow ? (
                  <div className="hairline-t pt-4 flex flex-col gap-1.5 text-sm">
                    <div className="flex justify-between font-mono text-xs text-[var(--graphite)]">
                      <span>
                        Rate ({quote.quantity} × {quote.unitLabel}
                        {selectedSpace.category === "COWORKING" && Number(desks) > 1
                          ? ` × ${desks} desks`
                          : ""}
                        )
                      </span>
                      <span>{formatMoney(quote.totalCents)}</span>
                    </div>
                    <div className="flex justify-between items-baseline pt-2 hairline-t">
                      <span className="font-mono text-xs uppercase tracking-wider text-[var(--ink)]">
                        Offline settlement total
                      </span>
                      <strong className="font-mono text-lg text-[var(--oxidized)]">
                        {formatMoney(quote.totalCents)}
                      </strong>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
