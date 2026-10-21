"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { clientApiPath } from "../lib/api";
import { useT } from "./I18nProvider";

type Message = { role: "user" | "assistant"; content: string };
type Candidate = Record<string, string | number | null>;

/**
 * Floating Guider assistant.
 *
 * The assistant is advisory only: it reads live venue data through whitelisted
 * server tools and can prepare an *editable* booking draft. It can never
 * submit a request, confirm a reservation or start a payment — those remain
 * the customer's explicit actions in the booking workflow.
 */
export function VenueAssistant() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [messages, setMessages] = useState<Message[]>([{ role: "assistant", content: t.assistant.intro }]);
  const panelRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLInputElement | null>(null);

  // Escape closes the panel and returns focus to the launcher.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        composerRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    composerRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const value = input.trim();
    if (!value || busy) return;
    const next = [...messages, { role: "user" as const, content: value }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch(clientApiPath("/api/public/assistant/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const body = await res.json();
      setMessages([...next, { role: "assistant", content: body.message || t.assistant.error }]);
      if (body.draftCandidate) setCandidate(body.draftCandidate);
    } catch {
      setMessages([...next, { role: "assistant", content: t.assistant.unavailable }]);
    } finally {
      setBusy(false);
    }
  }

  async function reviewDraft() {
    if (!candidate) return;
    const currentCode = pathname.match(/^\/spaces\/([^/]+)(?:\/book)?$/)?.[1];
    const payload = { ...candidate, spaceCode: candidate.spaceCode || currentCode || null };
    const res = await fetch(clientApiPath("/api/public/assistant/drafts"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (body?.draft?.token) {
      const target = payload.spaceCode ? `/spaces/${encodeURIComponent(String(payload.spaceCode))}/book` : "/spaces";
      router.push(`${target}#draft=${encodeURIComponent(body.draft.token)}`);
    }
  }

  function reset() {
    setMessages([{ role: "assistant", content: t.assistant.intro }]);
    setCandidate(null);
    setInput("");
    composerRef.current?.focus();
  }

  return (
    <div className="fixed right-4 bottom-4 z-[70] sm:right-6 sm:bottom-6">
      {open ? (
        <section
          ref={panelRef}
          className="guider-panel mb-3 flex h-[min(38rem,calc(100dvh-7rem))] w-[min(25rem,calc(100vw-2rem))] flex-col overflow-hidden"
          aria-label={t.assistant.ariaLabel}
        >
          <header className="flex justify-between gap-4 border-b border-[var(--rule)] p-4 sm:p-5">
            <div className="flex gap-3">
              <span aria-hidden="true" className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--chartreuse)] shadow-[0_0_0_5px_rgba(212,242,72,0.18)]" />
              <div>
                <p className="font-mono text-[0.65rem] uppercase tracking-[0.16em] m-0 text-[var(--brick)]">{t.assistant.title}</p>
                <p className="text-xs text-[var(--graphite)] m-0 mt-1">{t.assistant.subtitle}</p>
              </div>
            </div>
            <button onClick={() => setOpen(false)} aria-label={t.assistant.launcherClose} className="guider-close">
              ×
            </button>
          </header>

          <p className="px-4 pt-3 m-0 text-[0.66rem] leading-relaxed text-[var(--graphite)] border-b border-[var(--rule)] pb-3">
            {t.assistant.disclosure}
          </p>

          <div className="flex-1 overflow-y-auto p-4 space-y-3" aria-live="polite">
            {messages.map((m, i) => (
              <p
                key={i}
                className={`guider-message text-sm p-3 m-0 max-w-[90%] ${
                  m.role === "user" ? "guider-message--user ml-auto bg-[var(--ink)] text-[var(--bone)]" : "bg-[var(--concrete)] text-[var(--ink)]"
                }`}
              >
                {m.content}
              </p>
            ))}
            {busy ? <p className="font-mono text-xs text-[var(--graphite)]">{t.assistant.loading}</p> : null}
          </div>

          {messages.length <= 2 ? (
            <div className="px-4 pb-2">
              <p className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-[var(--graphite)] m-0 mb-1.5">
                {t.assistant.startersLabel}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[t.assistant.starter1, t.assistant.starter2, t.assistant.starter3, t.assistant.starter4].map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => {
                      setInput(starter);
                      composerRef.current?.focus();
                    }}
                    className="guider-starter text-left text-[0.68rem]"
                  >
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {candidate ? (
            <div className="px-4 pb-3">
              <button onClick={reviewDraft} className="btn-outline w-full text-xs">
                {t.assistant.draftCta}
              </button>
              <p className="text-[0.68rem] text-[var(--graphite)] mt-2 mb-0">{t.assistant.draftNote}</p>
            </div>
          ) : null}

          <form onSubmit={send} className="p-3 border-t border-[var(--rule)] flex gap-2">
            <label className="sr-only" htmlFor="ai-message">
              {t.assistant.placeholder}
            </label>
            <input
              id="ai-message"
              ref={composerRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={1200}
              placeholder={t.assistant.placeholder}
              className="field-input min-w-0 flex-1"
            />
            <button className="btn-primary px-4" disabled={busy}>
              {t.assistant.send}
            </button>
          </form>
          <button
            type="button"
            onClick={reset}
            className="border-0 bg-transparent text-[0.66rem] underline text-[var(--graphite)] cursor-pointer py-2"
          >
            {t.assistant.reset}
          </button>
        </section>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? t.assistant.launcherClose : t.assistant.launcherOpen}
        title={open ? t.assistant.launcherClose : t.assistant.launcherOpen}
        className="guider-launcher"
      >
        {open ? (
          <svg aria-hidden="true" viewBox="0 0 24 24" className="guider-launcher__icon">
            <path d="M6.75 6.75 17.25 17.25M17.25 6.75 6.75 17.25" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 24 24" className="guider-launcher__icon">
            <path d="M5.25 17.25 3.75 20.5l4.35-1.3c1.16.52 2.49.8 3.9.8 4.97 0 9-3.58 9-8s-4.03-8-9-8-9 3.58-9 8c0 1.98.81 3.8 2.25 5.25Z" />
            <path d="M8.25 12h.01M12 12h.01M15.75 12h.01" className="guider-launcher__dots" />
          </svg>
        )}
      </button>
    </div>
  );
}
