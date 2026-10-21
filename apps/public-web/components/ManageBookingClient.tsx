"use client";

import Link from "next/link";
import { useState } from "react";
import { clientApiPath } from "../lib/api";
import { formatDateTime, formatMoney } from "../lib/format";
import { format } from "../lib/i18n";
import type { Reservation } from "../lib/types";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { useT } from "./I18nProvider";

export function ManageBookingClient({
  initialReservation,
  reference,
  token,
  initiallyCancelled = false,
}: {
  initialReservation: Reservation;
  reference: string;
  token: string;
  initiallyCancelled?: boolean;
}) {
  const t = useT();
  const [reservation, setReservation] = useState<Reservation>(initialReservation);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justCancelled, setJustCancelled] = useState(initiallyCancelled);

  const isCancelled = reservation.status === "CANCELLED";

  useLiveRefresh(
    async (signal) => {
      const res = await fetch(
        clientApiPath(`/api/public/bookings/${encodeURIComponent(reference)}`),
        {
          cache: "no-store",
          signal,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
        },
      );
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: { reservation: Reservation };
      } | null;
      if (!res.ok || !body?.ok || !body.data?.reservation) return;

      const next = body.data.reservation;
      if (reservation.status !== "CANCELLED" && next.status === "CANCELLED") {
        setJustCancelled(true);
      }
      setReservation(next);
    },
    { enabled: !cancelling, intervalMs: 8_000, runOnMount: true },
  );

  async function handleCancel(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (cancelling || isCancelled) return;
    setCancelling(true);
    setError(null);

    try {
      const res = await fetch(
        clientApiPath(`/api/public/bookings/${encodeURIComponent(reference)}/cancel`),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ reference, token }),
        },
      );
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: { reservation: Reservation };
        error?: { message?: string };
      } | null;

      if (!res.ok || !body?.ok || !body.data?.reservation) {
        setError(body?.error?.message || t.manage.errorCancel);
        setCancelling(false);
        return;
      }

      setReservation(body.data.reservation);
      setJustCancelled(true);
      setCancelling(false);
    } catch {
      setError(t.manage.errorNetwork);
      setCancelling(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-14 sm:py-20">
      <div className="mx-auto max-w-3xl flex flex-col gap-8">
        {justCancelled ? (
          <div
            role="status"
            className="p-4 border-l-4 border-[var(--oxidized)] bg-[#e6f2ec] text-[var(--oxidized)] text-sm"
          >
            {format(t.manage.cancelledBanner, { ref: reservation.reference })}
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="p-4 border-l-4 border-[var(--brick)] bg-[#faeae6] text-[var(--brick)] text-sm"
          >
            {error}
          </div>
        ) : null}

        {/* PRIMARY BOOKING SUMMARY CARD */}
        <article className="hairline-box bg-[var(--paper-card)] p-6 sm:p-10 flex flex-col gap-7">
          <header className="hairline-b pb-5 flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-2">
              <span className="inline-flex items-center gap-2 font-mono text-[0.68rem] uppercase tracking-[0.14em] text-[var(--oxidized)]" aria-live="polite">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--chartreuse)] shadow-[0_0_0_3px_rgba(202,239,54,.18)]" aria-hidden="true" />
                {t.status.liveUpdates}
              </span>
              <span
                className={`inline-flex w-fit font-mono text-xs uppercase tracking-[0.16em] px-2.5 py-1 ${
                  isCancelled
                    ? "bg-[var(--brick)] text-[var(--bone)]"
                    : "bg-[var(--oxidized)] text-[var(--bone)]"
                }`}
              >
                {reservation.status}
              </span>
              <h1 className="font-display text-3xl sm:text-5xl text-[var(--ink)] m-0 mt-1">
                {reservation.spaceName}
              </h1>
              <p className="font-mono text-xs text-[var(--graphite)] m-0">
                {t.manage.referenceLabel} <code className="text-[var(--ink)]">{reservation.reference}</code> ·{" "}
                {t.manage.venueLabel} <code className="text-[var(--ink)]">{reservation.spaceCode}</code>
              </p>
            </div>

            <div className="font-mono text-left sm:text-right">
              <span className="block text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
                {t.manage.recordedTariff}
              </span>
              <strong className="text-xl text-[var(--oxidized)]">
                {formatMoney(reservation.totalCents, reservation.currency)}
              </strong>
            </div>
          </header>

          <dl className="m-0 grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                {t.manage.startLabel}
              </dt>
              <dd className="m-0 mt-1 text-sm font-medium text-[var(--ink)]">
                {formatDateTime(reservation.startAt)}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                {t.manage.endLabel}
              </dt>
              <dd className="m-0 mt-1 text-sm font-medium text-[var(--ink)]">
                {formatDateTime(reservation.endAt)}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                {t.manage.allocatedLabel}
              </dt>
              <dd className="m-0 mt-1 text-sm font-medium text-[var(--ink)]">
                {format(
                  reservation.unitCount === 1 ? t.manage.unitsOne : t.manage.unitsMany,
                  { n: reservation.unitCount },
                )}
                {reservation.attendees
                  ? ` · ${format(t.manage.attendees, { n: reservation.attendees })}`
                  : ""}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                {t.manage.billingLabel}
              </dt>
              <dd className="m-0 mt-1 text-sm font-medium text-[var(--ink)]">
                {reservation.billingQuantity} × {reservation.billingUnit}
              </dd>
            </div>
          </dl>

          <div className="hairline-t pt-5 flex flex-wrap items-center gap-3">
            <Link
              href={`/spaces/${encodeURIComponent(reservation.spaceCode)}`}
              className="btn-outline"
            >
              {t.manage.inspectVenue}
            </Link>
            <Link href="/book" className="btn-outline">
              {t.manage.bookAnother}
            </Link>
          </div>
        </article>

        {/* SECONDARY CANCELLATION PANEL (CLEAR BUT NOT VISUALLY DOMINANT) */}
        <section
          aria-labelledby="cancel-section-heading"
          className="hairline-box bg-[var(--concrete)]/55 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <div className="flex flex-col gap-1 max-w-xl">
            <h2
              id="cancel-section-heading"
              className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--ink)] m-0"
            >
              {t.manage.cancelHeading}
            </h2>
            <p className="text-xs text-[var(--graphite)] m-0">
              {isCancelled ? t.manage.cancelBodyDone : t.manage.cancelBodyActive}
            </p>
          </div>

          {!isCancelled ? (
            <form method="post" action="/book/cancel" onSubmit={handleCancel} className="shrink-0">
              <input type="hidden" name="reference" value={reference} />
              <input type="hidden" name="token" value={token} />
              <button
                type="submit"
                disabled={cancelling}
                className="btn-outline text-xs py-2.5 px-4 border-[var(--brick)] text-[var(--brick)]"
              >
                {cancelling ? t.manage.cancelling : t.manage.cancelCta}
              </button>
            </form>
          ) : null}
        </section>
      </div>
    </div>
  );
}
