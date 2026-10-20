import Link from "next/link";
import { getBooking } from "../../../lib/api";
import { formatDateTime, formatMoney } from "../../../lib/format";

export default async function BookingConfirmedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const pick = (key: string) => {
    const val = params[key];
    return typeof val === "string" ? val : Array.isArray(val) ? val[0] ?? "" : "";
  };

  const ref = pick("ref") || pick("reference");
  const token = pick("token");
  const reservation = ref && token ? await getBooking(ref, token) : null;

  if (!reservation) {
    return (
      <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-16">
        <div className="hairline-box bg-[var(--paper-card)] p-8 sm:p-12 max-w-2xl flex flex-col gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--brick)] m-0">
            Private booking receipt
          </p>
          <h1 className="font-display text-3xl sm:text-5xl text-[var(--ink)] m-0">
            That private booking link was not recognised.
          </h1>
          <p className="text-sm text-[var(--graphite)] m-0">
            A confirmed reservation can only be viewed with both its booking reference and the
            private capability token issued at checkout.
          </p>
          <div className="pt-2 flex flex-wrap gap-3">
            <Link href="/spaces" className="btn-primary">
              Book a Space
            </Link>
            <Link href="/spaces" className="btn-outline">
              Browse venues
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const manageHref = `/book/manage?ref=${encodeURIComponent(reservation.reference)}&token=${encodeURIComponent(token)}`;

  return (
    <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-14 sm:py-20">
      <article className="mx-auto max-w-3xl hairline-box bg-[var(--paper-card)] p-6 sm:p-12 flex flex-col gap-8">
        <header className="hairline-b pb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <span className="inline-flex w-fit font-mono text-xs uppercase tracking-[0.16em] px-2.5 py-1 bg-[var(--oxidized)] text-[var(--bone)]">
              Reservation {reservation.status}
            </span>
            <h1 className="font-display text-3xl sm:text-5xl text-[var(--ink)] m-0 mt-1">
              Booking receipt
            </h1>
            <p className="text-sm text-[var(--graphite)] m-0">
              Your reservation is confirmed in the TRACE Expert City booking ledger and the
              inventory is locked for your window.
            </p>
          </div>
          <div className="text-left sm:text-right font-mono">
            <span className="block text-[0.7rem] uppercase tracking-wider text-[var(--graphite)]">
              Booking reference
            </span>
            <code className="text-lg font-semibold text-[var(--ink)]">
              {reservation.reference}
            </code>
          </div>
        </header>

        <dl className="m-0 grid grid-cols-1 sm:grid-cols-2 gap-6 hairline-b pb-8">
          <div>
            <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
              Venue
            </dt>
            <dd className="m-0 mt-1 font-display text-2xl text-[var(--ink)]">
              {reservation.spaceName}
            </dd>
            <dd className="m-0 font-mono text-xs text-[var(--graphite)]">
              Code {reservation.spaceCode}
            </dd>
          </div>

          <div>
            <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
              Allocation
            </dt>
            <dd className="m-0 mt-1 text-base font-medium text-[var(--ink)]">
              {reservation.unitCount}{" "}
              {reservation.unitCount === 1 ? "bookable unit" : "bookable units"}
              {reservation.attendees ? ` · ${reservation.attendees} attendees` : ""}
            </dd>
          </div>

          <div>
            <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
              Starts (Sri Lanka Standard Time)
            </dt>
            <dd className="m-0 mt-1 text-sm font-medium text-[var(--ink)]">
              {formatDateTime(reservation.startAt)}
            </dd>
          </div>

          <div>
            <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
              Ends (Sri Lanka Standard Time)
            </dt>
            <dd className="m-0 mt-1 text-sm font-medium text-[var(--ink)]">
              {formatDateTime(reservation.endAt)}
            </dd>
          </div>

          <div className="sm:col-span-2 hairline-t pt-4 flex flex-wrap items-baseline justify-between gap-4">
            <div>
              <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                Recorded tariff ({reservation.billingQuantity} × {reservation.billingUnit})
              </dt>
              <dd className="m-0 mt-1 text-xs text-[var(--graphite)]">
                Settled offline with the TRACE Expert City operations desk.
              </dd>
            </div>
            <dd className="m-0 font-mono text-2xl font-semibold text-[var(--oxidized)]">
              {formatMoney(reservation.totalCents, reservation.currency)}
            </dd>
          </div>
        </dl>

        <div className="flex flex-col gap-3">
          <p className="text-xs font-mono text-[var(--graphite)] m-0">
            Bookmark your private management link below. It carries your capability token and is
            the only way to review or cancel this booking online.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Link href={manageHref} className="btn-primary">
              Manage booking
            </Link>
            <Link
              href={`/spaces/${encodeURIComponent(reservation.spaceCode)}`}
              className="btn-outline"
            >
              Venue details
            </Link>
            <Link href="/spaces" className="btn-outline">
              Browse catalogue
            </Link>
          </div>
        </div>
      </article>
    </div>
  );
}
