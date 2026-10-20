"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { VenueAssistant } from "./VenueAssistant";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useT } from "./I18nProvider";

export function PublicShell({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div className="min-h-dvh flex flex-col bg-[var(--bone)] text-[var(--ink)]">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[80] focus:bg-[var(--ink)] focus:text-[var(--bone)] focus:px-4 focus:py-2">
        {t.chrome.skip}
      </a>
      <header className="fixed inset-x-0 top-0 z-40 text-[var(--bone)] mix-blend-difference">
        <div className="mx-auto max-w-[96rem] px-4 sm:px-6 lg:px-10 h-20 flex items-center justify-between gap-4">
          <Link href="/" className="inline-flex items-center gap-3 no-underline text-inherit" aria-label={t.chrome.home}>
            <span aria-hidden="true" className="h-9 w-px bg-current" />
            <span className="font-display text-2xl leading-none tracking-tight">TRACE</span>
            <span className="font-mono text-[0.58rem] uppercase leading-[1.35] tracking-[0.2em] opacity-70">Spaces<br />Colombo</span>
          </Link>
          <div className="flex items-center gap-3 sm:gap-5">
            <LanguageSwitcher />
            <Link href="/spaces" className="font-mono text-[0.68rem] uppercase tracking-[0.16em] border border-current px-4 py-3 no-underline text-inherit hover:bg-white hover:text-black transition-colors">
              {t.chrome.bookCta} <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>
      </header>
      <main id="main-content" className="flex-1">{children}</main>
      <footer className="surface-dark mt-0">
        <div className="mx-auto max-w-[90rem] px-4 sm:px-6 lg:px-10 py-12 grid md:grid-cols-12 gap-8 items-end">
          <div className="md:col-span-8">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--chartreuse)]">{t.footer.place}</p>
            <p className="font-display text-3xl sm:text-5xl text-[var(--bone)] max-w-3xl">{t.footer.statement}</p>
          </div>
          <div className="md:col-span-4 md:text-right text-sm text-[var(--bone)]/65">
            <p>{t.footer.scheduleNote}<br />{t.footer.rateNote}</p>
            <Link href="/spaces" className="text-[var(--chartreuse)] font-mono text-xs uppercase tracking-wider">{t.footer.explore} →</Link>
          </div>
        </div>
      </footer>
      <VenueAssistant />
    </div>
  );
}
