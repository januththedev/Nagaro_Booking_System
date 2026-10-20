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
      <header className="pointer-events-none fixed inset-x-0 top-0 z-40 px-3 pt-3 sm:px-5 sm:pt-4">
        <div className="premium-nav pointer-events-auto mx-auto flex h-[4.15rem] max-w-[92rem] items-center justify-between gap-2 px-3 sm:gap-4 sm:px-5 lg:px-6">
          <Link href="/" className="group inline-flex min-w-0 items-center gap-2.5 no-underline text-inherit sm:gap-3" aria-label={t.chrome.home}>
            <span aria-hidden="true" className="h-8 w-1 rounded-full bg-[var(--chartreuse)] transition-transform duration-300 group-hover:scale-y-75" />
            <span className="font-display text-[1.65rem] leading-none tracking-tight">TRACE</span>
            <span className="brand-location font-mono text-[0.54rem] uppercase leading-[1.35] tracking-[0.18em] text-white/60">Spaces<br />Colombo</span>
          </Link>
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <LanguageSwitcher />
            <Link href="/spaces" className="header-book-link no-underline" aria-label={t.chrome.bookCta}>
              <span className="header-book-label">{t.chrome.bookCta}</span>
              <span aria-hidden="true">↗</span>
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
