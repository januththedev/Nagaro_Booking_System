import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { MotionProvider } from "../components/MotionProvider";
import { PublicShell } from "../components/PublicShell";

export const metadata: Metadata = {
  title: "TRACE Spaces · Architectural Venues & Workspaces in Colombo",
  description:
    "Explore restored brick bays, meeting studios, auditorium halls and co-working spaces at TRACE Expert City, Maradana, Colombo. Check live SLST availability and book directly.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <MotionProvider>
          <PublicShell>{children}</PublicShell>
        </MotionProvider>
      </body>
    </html>
  );
}
