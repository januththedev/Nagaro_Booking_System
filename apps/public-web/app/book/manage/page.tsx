import Link from "next/link";
import { getBooking } from "../../../lib/api";
import { ManageBookingClient } from "../../../components/ManageBookingClient";

export default async function ManageBookingPage({
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
  const cancelled = pick("cancelled") === "1";
  const reservation = ref && token ? await getBooking(ref, token) : null;

  if (!reservation) {
    return (
      <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-16">
        <div className="hairline-box bg-[var(--paper-card)] p-8 sm:p-12 max-w-2xl flex flex-col gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--brick)] m-0">
            Private booking management
          </p>
          <h1 className="font-display text-3xl sm:text-5xl text-[var(--ink)] m-0">
            That private booking link was not recognised.
          </h1>
          <p className="text-sm text-[var(--graphite)] m-0">
            Open the complete management link issued on your booking receipt, or contact the TRACE
            Expert City operations desk with your reference code.
          </p>
          <div className="pt-2 flex flex-wrap gap-3">
            <Link href="/book" className="btn-primary">
              Direct booking
            </Link>
            <Link href="/spaces" className="btn-outline">
              Browse venues
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ManageBookingClient
      initialReservation={reservation}
      reference={ref}
      token={token}
      initiallyCancelled={cancelled}
    />
  );
}
