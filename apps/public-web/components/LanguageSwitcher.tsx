"use client";

import { useRouter } from "next/navigation";
import { useLocale, useT } from "./I18nProvider";
import { LOCALES, LOCALE_COOKIE, LOCALE_LABELS, type Locale } from "../lib/i18n";

/** A compact, grouped language control that keeps the floating header calm. */
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
    <div role="group" aria-label={t.chrome.languageLabel} className="language-switcher">
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          onClick={() => choose(code)}
          aria-label={LOCALE_LABELS[code]}
          aria-pressed={locale === code}
          title={LOCALE_LABELS[code]}
          className={`language-switcher__option ${locale === code ? "is-active" : ""}`}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
