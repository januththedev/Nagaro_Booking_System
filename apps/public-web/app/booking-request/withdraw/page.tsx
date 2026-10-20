import Link from "next/link";
import { cookies, headers } from "next/headers";
import { format, getDictionary, resolveLocale, LOCALE_COOKIE } from "../../../lib/i18n";
import { WithdrawInquiryForm } from "../../../components/WithdrawInquiryForm";

export default async function WithdrawInquiryPage({
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
  const withdrawn = pick("withdrawn") === "1";

  return (
    <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-16">
      <article className="mx-auto max-w-xl hairline-box bg-[var(--paper-card)] p-8 sm:p-12 flex flex-col gap-6">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--brick)] m-0">
          {t.withdraw.eyebrow}
        </p>
        {withdrawn ? (
          <>
            <h1 className="font-display text-3xl sm:text-4xl text-[var(--ink)] m-0">
              {t.withdraw.done}
            </h1>
            <p className="text-sm text-[var(--graphite)] m-0">
              {ref ? <strong>{ref}</strong> : null} {t.withdraw.withdrawnBody}
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/spaces" className="btn-primary">
                {t.common.browseVenues}
              </Link>
              <Link href="/spaces" className="btn-outline">
                {t.chrome.bookCta}
              </Link>
            </div>
          </>
        ) : (
          <>
            <h1 className="font-display text-3xl sm:text-4xl text-[var(--ink)] m-0">
              {format(t.withdraw.title, { ref: ref || "" })}
            </h1>
            <p className="text-sm text-[var(--graphite)] m-0">
              {t.withdraw.intro}
            </p>
            <WithdrawInquiryForm reference={ref} token={token} />
          </>
        )}
      </article>
    </div>
  );
}
