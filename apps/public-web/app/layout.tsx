import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { MotionProvider } from "../components/MotionProvider";
import { PublicShell } from "../components/PublicShell";
import { I18nProvider } from "../components/I18nProvider";
import {
  BCP47,
  LOCALES,
  getDictionary,
  resolveLocale,
  type Locale,
} from "../lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const store = await cookies();
  const headerStore = await headers();
  const locale = resolveLocale(
    store.get("trace_locale")?.value,
    headerStore.get("accept-language"),
  );
  const t = getDictionary(locale);
  return {
    title: t.meta.title,
    description: t.meta.description,
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  const headerStore = await headers();
  const locale: Locale = resolveLocale(
    store.get("trace_locale")?.value,
    headerStore.get("accept-language"),
  );

  return (
    <html lang={BCP47[locale]}>
      <body>
        <I18nProvider locale={locale}>
          <MotionProvider>
            <PublicShell>{children}</PublicShell>
          </MotionProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
