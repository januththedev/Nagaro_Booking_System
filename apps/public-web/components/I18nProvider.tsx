"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_LOCALE, getDictionary, type Dictionary, type Locale } from "../lib/i18n";

/**
 * Client-side access to the active dictionary.
 *
 * The server resolves the locale (cookie, then Accept-Language) in
 * app/layout.tsx and passes it here once; every client component simply calls
 * `useT()` for strings and `useLocale()` for formatting.
 */
const I18nContext = createContext<{ t: Dictionary; locale: Locale }>({
  t: getDictionary(DEFAULT_LOCALE),
  locale: DEFAULT_LOCALE,
});

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <I18nContext.Provider value={{ t: getDictionary(locale), locale }}>{children}</I18nContext.Provider>;
}

export function useT(): Dictionary {
  return useContext(I18nContext).t;
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}
