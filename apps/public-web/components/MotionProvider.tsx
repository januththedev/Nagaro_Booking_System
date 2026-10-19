"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";

function shouldDisableSmoothMotion(): boolean {
  if (typeof window === "undefined") return true;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean };
    deviceMemory?: number;
  };
  const saveData = Boolean(nav.connection?.saveData);
  const lowCores = typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency < 4;
  const lowMemory = typeof nav.deviceMemory === "number" && nav.deviceMemory < 4;
  return reduced || coarse || saveData || lowCores || lowMemory;
}

export function MotionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (shouldDisableSmoothMotion()) return;

    let lenisInstance: { raf: (t: number) => void; destroy: () => void } | null = null;
    let rafId = 0;
    let cancelled = false;

    void (async () => {
      try {
        const [{ default: Lenis }, gsapModule, scrollTriggerModule] = await Promise.all([
          import("lenis"),
          import("gsap"),
          import("gsap/ScrollTrigger"),
        ]);
        if (cancelled) return;
        const gsap = gsapModule.default || gsapModule.gsap;
        const ScrollTrigger = scrollTriggerModule.ScrollTrigger || scrollTriggerModule.default;
        gsap.registerPlugin(ScrollTrigger);

        const lenis = new Lenis({
          duration: 1.05,
          smoothWheel: true,
          syncTouch: false,
        });
        lenisInstance = lenis;

        const tick = (time: number) => {
          lenis.raf(time);
          rafId = window.requestAnimationFrame(tick);
        };
        rafId = window.requestAnimationFrame(tick);

        const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-editorial-reveal]"));
        for (const el of targets) {
          if (el.dataset.revealed === "true") continue;
          el.dataset.revealed = "true";
          gsap.fromTo(
            el,
            { autoAlpha: 0, y: 22 },
            {
              autoAlpha: 1,
              y: 0,
              duration: 0.72,
              ease: "power2.out",
              scrollTrigger: {
                trigger: el,
                start: "top 88%",
                once: true,
              },
            },
          );
        }
      } catch {
        // Progressive enhancement only; native scrolling and visibility remain intact.
      }
    })();

    return () => {
      cancelled = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      if (lenisInstance) lenisInstance.destroy();
    };
  }, [pathname]);

  return <>{children}</>;
}
