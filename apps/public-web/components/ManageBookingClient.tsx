"use client";

import Link from "next/link";
import { useState } from "react";
import { clientApiPath } from "../lib/api";
import { formatDateTime, formatMoney } from "../lib/format";
import type { Reservation } from "../lib/types";

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
  const [reservation, setReservation] = useState<Reservation>(initialReservation);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justCancelled, setJustCancelled] = useState(initiallyCancelled);

  const isCancelled = reservation.status === "CANCELLED";

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
        setError(body?.error?.message || "Could not cancel this reservation online.");
        setCancelling(false);
        return;
      }

      setReservation(body.data.reservation);
      setJustCancelled(true);
      setCancelling(false);
    } catch {
      setError("Network error while cancelling this reservation. Please retry.");
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
            Reservation <code>{reservation.reference}</code> has been cancelled and its inventory
            has been released.
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
                Reference <code className="text-[var(--ink)]">{reservation.reference}</code> · Venue{" "}
                <code className="text-[var(--ink)]">{reservation.spaceCode}</code>
              </p>
            </div>

            <div className="font-mono text-left sm:text-right">
              <span className="block text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
                Recorded tariff
              </span>
              <strong className="text-xl text-[var(--oxidized)]">
                {formatMoney(reservation.totalCents, reservation.currency)}
              </strong>
            </div>
          </header>

          <dl className="m-0 grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                Start (Sri Lanka Standard Time)
              </dt>
              <dd className="m-0 mt-1 text-sm font-medium text-[var(--ink)]">
                {formatDateTime(reservation.startAt)}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                End (Sri Lanka Standard Time)
              </dt>
              <dd className="m-0 mt-1 text-sm font-medium text-[var(--ink)]">
                {formatDateTime(reservation.endAt)}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                Allocated inventory
              </dt>
              <dd className="m-0 mt-1 text-sm font-medium text-[var(--ink)]">
                {reservation.unitCount} {reservation.unitCount === 1 ? "unit" : "units"}
                {reservation.attendees ? ` · ${reservation.attendees} attendees` : ""}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                Billing basis
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
              Inspect venue specifications
            </Link>
            <Link href="/book" className="btn-outline">
              Book another window
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
              Release reservation inventory
            </h2>
            <p className="text-xs text-[var(--graphite)] m-0">
              {isCancelled
                ? "This reservation has already been cancelled and no longer holds inventory."
                : "If your plans have changed, you can cancel this reservation before its start time to release the room or desks immediately."}
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
                {cancelling ? "Releasing…" : "Cancel reservation"}
              </button>
            </form>
          ) : null}
        </section>
      </div>
    </div>
  );
}
