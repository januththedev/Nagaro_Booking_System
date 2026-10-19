import Link from "next/link";
import { getSpace } from "../../../lib/api";
import { VenueDetailClient } from "../../../components/VenueDetailClient";

export default async function VenueDetailPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const space = await getSpace(code);

  if (!space) {
    return (
      <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-20">
        <div className="hairline-box bg-[var(--paper-card)] p-10 max-w-2xl flex flex-col gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--brick)] m-0">
            Error 404 · Venue not found
          </p>
          <h1 className="font-display text-4xl text-[var(--ink)] m-0">
            That venue is not in the published catalogue.
          </h1>
          <p className="text-sm text-[var(--graphite)] m-0">
            It may have been archived, renamed or held in draft while photography is updated.
          </p>
          <div className="pt-2 flex flex-wrap gap-3">
            <Link href="/spaces" className="btn-primary">
              Browse published venues
            </Link>
            <Link href="/book" className="btn-outline">
              Direct booking
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <VenueDetailClient space={space} />;
}
