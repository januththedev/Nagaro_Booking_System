import Link from "next/link";

export default async function BookingRequestReceivedPage({
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
  const space = pick("space");
  const emailStatus = pick("emailStatus") || "NOT_CONFIGURED";
  const withdrawHref =
    ref && token
      ? `/booking-request/withdraw?ref=${encodeURIComponent(ref)}&token=${encodeURIComponent(token)}`
      : null;

  return (
    <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-16">
      <article className="mx-auto max-w-2xl hairline-box bg-[var(--paper-card)] p-8 sm:p-12 flex flex-col gap-6">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--brick)] m-0">
          Provisional concierge inquiry recorded
        </p>
        <h1 className="font-display text-3xl sm:text-5xl text-[var(--ink)] m-0">
          Your inquiry has been received.
        </h1>
        <p className="text-sm text-[var(--graphite)] m-0">
          <strong>This inquiry is provisional and has not locked inventory.</strong> Our operations
          desk will review your brief in the queue and contact you. If you want to lock a slot
          immediately instead, use{" "}
          <Link href="/book" className="text-[var(--oxidized)] underline">
            direct online checkout
          </Link>
          .
        </p>

        <dl className="m-0 grid grid-cols-1 sm:grid-cols-2 gap-4 hairline-t hairline-b py-5 text-sm">
          <div>
            <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
              Inquiry reference
            </dt>
            <dd className="m-0 mt-1 font-mono font-semibold text-[var(--ink)]">{ref || "—"}</dd>
          </div>
          {space ? (
            <div>
              <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
                Space code
              </dt>
              <dd className="m-0 mt-1 font-mono text-[var(--ink)]">{space}</dd>
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <dt className="font-mono text-xs uppercase tracking-wider text-[var(--graphite)]">
              Notification status
            </dt>
            <dd className="m-0 mt-1 text-xs text-[var(--graphite)]">
              {emailStatus === "SENT"
                ? "A notification email was sent to the operations desk."
                : "Email delivery is not configured on this server; your request is saved directly in the staff inquiry queue."}
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap items-center gap-3">
          <Link href="/spaces" className="btn-primary">
            Browse venues
          </Link>
          {withdrawHref ? (
            <Link href={withdrawHref} className="btn-outline text-[var(--brick)] border-[var(--brick)]">
              Withdraw this inquiry
            </Link>
          ) : null}
        </div>
      </article>
    </div>
  );
}
