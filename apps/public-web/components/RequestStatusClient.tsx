"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { BookingRequest } from "../lib/types";
import { clientApiPath } from "../lib/api";
import { format } from "../lib/i18n";
import { useLocale, useT } from "./I18nProvider";

export function RequestStatusClient({
  request,
  reference,
  token,
}: {
  request: BookingRequest;
  reference: string;
  token: string;
}) {
  const t = useT();
  const locale = useLocale();
  const [current, setCurrent] = useState(request);
  const [advanceLkr, setAdvanceLkr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const stateLabel: Record<string, string> = {
    REQUESTED: t.status.stateRequested,
    APPROVED_AWAITING_PAYMENT: t.status.stateApproved,
    CONFIRMED: t.status.stateConfirmed,
    REJECTED: t.status.stateRejected,
    EXPIRED: t.status.stateExpired,
    PAYMENT_REVIEW_REQUIRED: t.status.stateReview,
    CANCELLED: t.status.stateCancelled,
  };
  const fee = current.payment?.bookingFeeCents ?? 0;
  const remaining = current.payment?.remainingBalanceCents ?? 0;
  const parsedAdvance = advanceLkr.trim() === "" ? 0 : Number(advanceLkr);
  const advanceCents = Number.isFinite(parsedAdvance) && parsedAdvance >= 0
    ? Math.round(parsedAdvance * 100)
    : -1;
  const paymentTotal = fee + Math.max(0, advanceCents);

  const money = (cents: number) => `${current.currency} ${(cents / 100).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  const maxAdvanceLkr = useMemo(() => (remaining / 100).toFixed(2), [remaining]);
  const when = (ms: number, opts: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleString(locale, {
    timeZone: "Asia/Colombo",
    ...opts,
  });

  async function pay() {
    if (advanceCents < 0 || advanceCents > remaining) {
      setError(t.status.advanceTooHigh);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(clientApiPath(`/api/public/booking-requests/${encodeURIComponent(reference)}/payment`), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ advanceCents }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || t.status.payError);
      const form = document.createElement("form");
      form.method = "POST";
      form.action = body.checkout.action;
      for (const [key, value] of Object.entries(body.checkout.fields)) {
        if (key === "attemptId") continue;
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = key;
        input.value = String(value ?? "");
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t.status.payError);
      setBusy(false);
    }
  }

  async function cancel() {
    if (!window.confirm(t.status.cancelConfirm)) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(clientApiPath(`/api/public/booking-requests/${encodeURIComponent(reference)}/cancel`), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || t.status.cancelError);
      setCurrent(body.request);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t.status.cancelError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh px-4 pb-20 pt-28 sm:px-6">
      <main className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-12">
        <section className="lg:col-span-7">
          <p className="font-mono text-xs uppercase tracking-[.18em] text-[var(--brick)]">
            {format(t.status.eyebrow, { ref: reference })}
          </p>
          <h1 className="font-display text-5xl leading-[.92] sm:text-7xl">{stateLabel[current.status] || current.status}</h1>
          <p className="mt-6 text-lg text-[var(--graphite)]">
            {current.status === "REQUESTED"
              ? t.status.bodyRequested
              : current.status === "APPROVED_AWAITING_PAYMENT"
                ? t.status.bodyApproved
                : current.status === "CONFIRMED"
                  ? t.status.bodyConfirmed
                  : current.status === "PAYMENT_REVIEW_REQUIRED"
                    ? t.status.bodyReview
                    : current.rejectionReason || t.status.bodyInactive}
          </p>
          {current.holdExpiresAt && current.status === "APPROVED_AWAITING_PAYMENT" ? (
            <p className="border-l-2 border-[var(--brick)] pl-4">
              {format(t.status.holdExpiry, { when: when(current.holdExpiresAt, { dateStyle: "medium", timeStyle: "short" }) })}
            </p>
          ) : null}

          {current.status === "APPROVED_AWAITING_PAYMENT" && fee > 0 ? (
            <div className="mt-7 rounded-2xl border border-[color:var(--ink)]/20 bg-white/55 p-5 sm:p-6">
              <label htmlFor="optional-advance" className="block font-medium">{t.status.optionalAdvance}</label>
              <p id="optional-advance-help" className="mt-1 max-w-xl text-sm text-[var(--graphite)]">
                {format(t.status.advanceHint, { max: money(remaining) })}
              </p>
              <div className="mt-4 flex max-w-sm items-stretch overflow-hidden rounded-xl border border-[var(--ink)] bg-[var(--bone)] focus-within:ring-2 focus-within:ring-[var(--chartreuse)]">
                <span className="grid place-items-center border-r border-[var(--ink)] px-3 font-mono text-xs">LKR</span>
                <input
                  id="optional-advance"
                  aria-describedby="optional-advance-help"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max={maxAdvanceLkr}
                  step="0.01"
                  value={advanceLkr}
                  onChange={(event) => setAdvanceLkr(event.target.value)}
                  placeholder="0.00"
                  className="min-w-0 flex-1 bg-transparent px-4 py-3 outline-none"
                />
              </div>
              <dl className="mt-5 grid max-w-sm grid-cols-[1fr_auto] gap-x-5 gap-y-2 border-t border-[color:var(--ink)]/15 pt-4 text-sm">
                <dt className="text-[var(--graphite)]">{t.status.registrationFee}</dt>
                <dd>{money(fee)}</dd>
                <dt className="text-[var(--graphite)]">{t.status.balanceLabel}</dt>
                <dd>{money(Math.max(0, remaining - Math.max(0, advanceCents)))}</dd>
              </dl>
            </div>
          ) : null}

          <div className="mt-6 flex flex-wrap gap-3">
            {current.status === "APPROVED_AWAITING_PAYMENT" && fee > 0 ? (
              <button onClick={pay} disabled={busy} className="btn-primary">
                {busy ? t.status.payOpening : format(t.status.payCta, { amount: money(paymentTotal) })}
              </button>
            ) : null}
            {(["REQUESTED", "APPROVED_AWAITING_PAYMENT"] as string[]).includes(current.status) ? (
              <button onClick={cancel} disabled={busy} className="btn-outline">{t.status.cancelCta}</button>
            ) : null}
          </div>
          {error ? <p role="alert" className="mt-4 text-[var(--brick)]">{error}</p> : null}
          <p className="mt-5 text-xs text-[var(--graphite)]">{t.status.paymentNote}</p>
        </section>

        <aside className="h-fit rounded-2xl border border-[var(--ink)] bg-white/35 p-6 shadow-[0_24px_80px_rgba(31,29,25,.08)] sm:p-8 lg:col-span-5">
          <p className="font-mono text-xs uppercase tracking-wider text-[var(--oxidized)]">{t.status.summaryTitle}</p>
          <h2 className="font-display text-4xl">{current.spaceName}</h2>
          <dl className="grid grid-cols-2 gap-y-4 text-sm">
            <dt>{t.status.dateLabel}</dt><dd>{when(current.startAt, { dateStyle: "medium" })}</dd>
            <dt>{t.status.timeLabel}</dt><dd>{when(current.startAt, { hour: "2-digit", minute: "2-digit" })}–{when(current.endAt, { hour: "2-digit", minute: "2-digit" })}</dd>
            <dt>{t.status.venueTotal}</dt><dd>{money(current.venueTotalCents)}</dd>
            {current.payment ? <><dt>{t.status.registrationFee}</dt><dd>{money(current.payment.bookingFeeCents)}</dd></> : null}
            {current.payment?.advancePaidCents ? <><dt>{t.status.advancePaid}</dt><dd>{money(current.payment.advancePaidCents)}</dd></> : null}
            {current.payment ? <><dt>{t.status.balanceLabel}</dt><dd>{money(current.payment.remainingBalanceCents)}</dd></> : null}
            <dt>{t.status.paymentStatusLabel}</dt><dd>{current.paymentStatus}</dd>
          </dl>
          <Link href={`/spaces/${encodeURIComponent(current.spaceCode)}`} className="btn-outline mt-8 w-full text-center">
            {t.status.viewSpace}
          </Link>
        </aside>
      </main>
    </div>
  );
}
