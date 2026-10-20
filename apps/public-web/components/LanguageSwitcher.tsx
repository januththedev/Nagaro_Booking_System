"use client";

import { useRouter } from "next/navigation";
import { useLocale, useT } from "./I18nProvider";
import { LOCALES, LOCALE_COOKIE, LOCALE_LABELS, type Locale } from "../lib/i18n";

/**
 * Discreet language control for the minimal header. Choosing a language sets a
 * year-long cookie and re-renders the current route in that language; no
 * navigation, no URL change, no layout shift.
 */
export function LanguageSwitcher() {
  const router = useRouter();
  const locale = useLocale();
  const t = useT();

  const choose = (next: Locale) => {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };

  return (
    <div role="group" aria-label={t.chrome.languageLabel} className="flex items-center gap-1">
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          onClick={() => choose(code)}
          aria-pressed={locale === code}
          title={LOCALE_LABELS[code]}
          className={`font-mono text-[0.62rem] uppercase tracking-[0.12em] px-2 py-2 border cursor-pointer transition-colors ${
            locale === code ? "bg-white text-black border-white" : "bg-transparent text-inherit border-current hover:bg-white hover:text-black"
          }`}
        >
          {LOCALE_LABELS[code]}
        </button>
      ))}
    </div>
  );
}
