import Link from "next/link";
import { cookies, headers } from "next/headers";
import { getBooking, getBookingRequest } from "../../../lib/api";
import { getDictionary, resolveLocale, LOCALE_COOKIE } from "../../../lib/i18n";
import { ManageBookingClient } from "../../../components/ManageBookingClient";
import { RequestStatusClient } from "../../../components/RequestStatusClient";

export default async function ManageBookingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const store = await cookies();
  const headerStore = await headers();
  const t = getDictionary(
    resolveLocale(store.get(LOCALE_COOKIE)?.value, headerStore.get("accept-language")),
  );
  const params = await searchParams;
  const pick = (key: string) => {
    const val = params[key];
    return typeof val === "string" ? val : Array.isArray(val) ? val[0] ?? "" : "";
  };

  const ref = pick("ref") || pick("reference");
  const token = pick("token");
  const cancelled = pick("cancelled") === "1";
  const request = ref && token ? await getBookingRequest(ref, token) : null;
  if(request) return <RequestStatusClient request={request} reference={ref} token={token}/>;
  const reservation = ref && token ? await getBooking(ref, token) : null;

  if (!reservation) {
    return (
      <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-16">
        <div className="hairline-box bg-[var(--paper-card)] p-8 sm:p-12 max-w-2xl flex flex-col gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--brick)] m-0">
            {t.manage.eyebrow}
          </p>
          <h1 className="font-display text-3xl sm:text-5xl text-[var(--ink)] m-0">
            {t.withdraw.notFound}
          </h1>
          <p className="text-sm text-[var(--graphite)] m-0">
            {t.manage.linkBody}
          </p>
          <div className="pt-2 flex flex-wrap gap-3">
            <Link href="/spaces" className="btn-primary">{t.manifesto.secondaryCta}</Link>
            <Link href="/spaces" className="btn-outline">
              {t.common.browseVenues}
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
