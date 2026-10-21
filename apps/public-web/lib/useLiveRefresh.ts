"use client";

import { useEffect, useRef } from "react";

type LiveRefreshOptions = {
  enabled?: boolean;
  intervalMs?: number;
  runOnMount?: boolean;
};

/**
 * Revalidates read-only public data without overlapping requests.
 * Hidden/offline tabs pause, then refresh immediately when they become useful
 * again. Mutations remain separate and the booking transaction stays the
 * authority for inventory conflicts.
 */
export function useLiveRefresh(
  refresh: (signal: AbortSignal) => Promise<void>,
  {
    enabled = true,
    intervalMs = 10_000,
    runOnMount = false,
  }: LiveRefreshOptions = {},
) {
  const refreshRef = useRef(refresh);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let running = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const schedule = () => {
      if (disposed) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void run(), intervalMs);
    };

    const run = async () => {
      if (disposed || running) return;
      if (document.visibilityState === "hidden" || navigator.onLine === false) {
        schedule();
        return;
      }

      running = true;
      controller = new AbortController();
      try {
        await refreshRef.current(controller.signal);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          // Keep the last trusted snapshot. The next scheduled/focus refresh
          // retries without turning a temporary network failure into UI churn.
        }
      } finally {
        running = false;
        controller = null;
        schedule();
      }
    };

    const wake = () => {
      window.clearTimeout(timer);
      void run();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") wake();
    };

    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", onVisibility);
    if (runOnMount) void run();
    else schedule();

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller?.abort();
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs, runOnMount]);
}
