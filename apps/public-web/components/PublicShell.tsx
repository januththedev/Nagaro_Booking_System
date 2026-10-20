"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

const NAV_ITEMS = [
  { href: "/spaces", label: "Spaces" },
  { href: "/book", label: "Book directly" },
  { href: "/booking-request", label: "Concierge inquiry" },
];

export function PublicShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const isHome = pathname === "/";
  const overlayHeader = isHome && !scrolled && !menuOpen;

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 36);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        toggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <div className="min-h-dvh flex flex-col bg-[var(--bone)] text-[var(--ink)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:bg-[var(--ink)] focus:text-[var(--bone)] focus:px-4 focus:py-2 font-mono text-xs uppercase tracking-widest"
      >
        Skip to main content
      </a>

      <header
        className={`${isHome ? "fixed inset-x-0 top-0" : "sticky top-0"} z-40 transition-[background-color,border-color,color] duration-300 ${
          overlayHeader
            ? "bg-transparent text-[var(--bone)] border-b border-white/15"
            : "bg-[var(--bone)]/95 text-[var(--ink)] backdrop-blur-xl hairline-b"
        }`}
      >
        <div className="mx-auto max-w-[96rem] px-4 sm:px-6 lg:px-10 min-h-[4.75rem] flex items-center justify-between gap-4">
          <Link href="/" className="group inline-flex items-center gap-3 no-underline">
            <span
              aria-hidden="true"
              className={`h-9 w-px transition-colors ${overlayHeader ? "bg-[var(--chartreuse)]" : "bg-[var(--brick)]"}`}
            >
              &nbsp;
            </span>
            <span className="flex items-center gap-2.5">
              <span
                className={`font-display text-[1.45rem] leading-none tracking-tight ${
                  overlayHeader ? "text-[var(--bone)]" : "text-[var(--ink)]"
                }`}
              >
                TRACE
              </span>
              <span
                className={`flex flex-col font-mono text-[0.58rem] uppercase leading-[1.35] tracking-[0.2em] ${
                  overlayHeader ? "text-[var(--bone)]/72" : "text-[var(--graphite)]"
                }`}
              >
                <span>Spaces</span>
                <span>Colombo</span>
              </span>
            </span>
          </Link>

          <nav aria-label="Primary" className="hidden md:flex items-center gap-7">
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`font-mono text-[0.7rem] uppercase tracking-[0.16em] no-underline py-1 border-b transition-colors ${
                    active
                      ? overlayHeader
                        ? "border-[var(--chartreuse)] text-[var(--bone)] font-medium"
                        : "border-[var(--brick)] text-[var(--ink)] font-medium"
                      : overlayHeader
                        ? "border-transparent text-[var(--bone)]/78 hover:text-[var(--bone)]"
                        : "border-transparent text-[var(--graphite)] hover:text-[var(--ink)]"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="hidden md:flex items-center gap-3">
            <a
              href="/admin"
              className={`font-mono text-[0.7rem] uppercase tracking-[0.14em] no-underline px-3 py-2 transition-colors ${
                overlayHeader
                  ? "text-[var(--bone)]/70 hover:text-[var(--bone)]"
                  : "text-[var(--graphite)] hover:text-[var(--ink)]"
              }`}
            >
              Staff console
            </a>
            <Link href="/book" className={`${overlayHeader ? "btn-chartreuse" : "btn-primary"} py-2.5 px-4`}>
              Book now
            </Link>
          </div>

          <button
            ref={toggleRef}
            type="button"
            aria-expanded={menuOpen}
            aria-controls="mobile-primary-nav"
            onClick={() => setMenuOpen((prev) => !prev)}
            className={`md:hidden font-mono text-xs uppercase tracking-[0.14em] px-3 py-2 border transition-colors ${
              overlayHeader
                ? "border-white/55 bg-black/15 text-[var(--bone)] backdrop-blur-md"
                : "border-[var(--ink)] bg-[var(--paper-card)] text-[var(--ink)]"
            }`}
          >
            {menuOpen ? "Close" : "Menu"}
          </button>
        </div>

        {menuOpen ? (
          <nav
            id="mobile-primary-nav"
            aria-label="Mobile primary"
            className="md:hidden hairline-t bg-[var(--paper-card)] px-4 py-5 flex flex-col gap-3"
          >
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className="font-mono text-xs uppercase tracking-[0.14em] py-2 text-[var(--ink)] no-underline border-b border-[var(--rule)]"
                >
                  {item.label}
                </Link>
              );
            })}
            <a
              href="/admin"
              className="font-mono text-xs uppercase tracking-[0.14em] py-2 text-[var(--graphite)] no-underline"
            >
              Staff console →
            </a>
          </nav>
        ) : null}
      </header>

      <main id="main-content" className="flex-1">
        {children}
      </main>

      <footer className="surface-dark hairline-t mt-20">
        <div className="mx-auto max-w-[90rem] px-4 sm:px-6 lg:px-10 py-16 grid grid-cols-1 md:grid-cols-12 gap-10">
          <div className="md:col-span-5 flex flex-col gap-4">
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--chartreuse)]">
              TRACE Expert City · Maradana, Colombo
            </p>
            <h2 className="font-display text-3xl sm:text-4xl text-[var(--bone)]">
              Restored red-brick bays, courtyard canopy and working studios.
            </h2>
            <p className="text-sm text-[var(--bone)]/75 max-w-md">
              Direct online bookings lock live inventory immediately inside the TRACE booking engine,
              with LKR settlement recorded for offline completion. Custom production briefs and
              multi-day programmes can also be sent to the concierge desk.
            </p>
          </div>

          <div className="md:col-span-3 flex flex-col gap-3">
            <h3 className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--bone)]/60">
              Campus navigation
            </h3>
            <ul className="list-none p-0 m-0 flex flex-col gap-2.5 text-sm">
              <li>
                <Link href="/" className="text-[var(--bone)]/85 hover:text-[var(--chartreuse)] no-underline">
                  Campus overview
                </Link>
              </li>
              <li>
                <Link href="/spaces" className="text-[var(--bone)]/85 hover:text-[var(--chartreuse)] no-underline">
                  Venue catalogue
                </Link>
              </li>
              <li>
                <Link href="/book" className="text-[var(--bone)]/85 hover:text-[var(--chartreuse)] no-underline">
                  Direct booking checkout
                </Link>
              </li>
              <li>
                <Link href="/booking-request" className="text-[var(--bone)]/85 hover:text-[var(--chartreuse)] no-underline">
                  Concierge inquiry
                </Link>
              </li>
            </ul>
          </div>

          <div className="md:col-span-4 flex flex-col gap-3">
            <h3 className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--bone)]/60">
              Operations &amp; time zone
            </h3>
            <p className="text-sm text-[var(--bone)]/75">
              All schedules operate in Sri Lanka Standard Time (Asia/Colombo, UTC+05:30). Rates are
              quoted in Sri Lankan Rupees (LKR).
            </p>
            <p className="text-sm">
              <a href="/admin" className="text-[var(--chartreuse)] hover:underline font-mono text-xs uppercase tracking-[0.12em]">
                Staff operations console →
              </a>
            </p>
          </div>
        </div>
        <div className="border-t border-[var(--rule-dark)] mx-auto max-w-[90rem] px-4 sm:px-6 lg:px-10 py-6 flex flex-wrap items-center justify-between gap-4 text-xs font-mono text-[var(--bone)]/60">
          <span>TRACE Spaces · Trippane Road, Maradana, Colombo 10</span>
          <span>Direct confirmation &amp; capability-secured booking management</span>
        </div>
      </footer>
    </div>
  );
}
