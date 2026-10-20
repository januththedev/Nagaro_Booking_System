import Link from "next/link";
import { cookies, headers } from "next/headers";
import { getSpace } from "../../../lib/api";
import { LOCALE_COOKIE, getDictionary, resolveLocale } from "../../../lib/i18n";
import { VenueDetailClient } from "../../../components/VenueDetailClient";

export default async function VenueDetailPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const space = await getSpace(code);

  if (!space) {
    const store = await cookies();
    const headerStore = await headers();
    const t = getDictionary(resolveLocale(store.get(LOCALE_COOKIE)?.value, headerStore.get("accept-language")));
    return (
      <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-20">
        <div className="hairline-box bg-[var(--paper-card)] p-10 max-w-2xl flex flex-col gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--brick)] m-0">
            {t.venue.notFoundEyebrow}
          </p>
          <h1 className="font-display text-4xl text-[var(--ink)] m-0">
            {t.venue.notFoundTitle}
          </h1>
          <p className="text-sm text-[var(--graphite)] m-0">
            {t.venue.notFoundBody}
          </p>
          <div className="pt-2 flex flex-wrap gap-3">
            <Link href="/spaces" className="btn-primary">
              {t.venue.notFoundPrimary}
            </Link>
            <Link href="/spaces" className="btn-outline">{t.venue.notFoundSecondary}</Link>
          </div>
        </div>
      </div>
    );
  }

  return <VenueDetailClient space={space} />;
}
