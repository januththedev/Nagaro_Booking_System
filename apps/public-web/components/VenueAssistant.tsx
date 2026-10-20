"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { clientApiPath } from "../lib/api";
import { useT } from "./I18nProvider";

type Message = { role: "user" | "assistant"; content: string };
type Candidate = Record<string, string | number | null>;

/**
 * Floating AI venue guide.
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
          className="mb-3 w-[min(25rem,calc(100vw-2rem))] h-[min(38rem,calc(100dvh-7rem))] bg-[var(--paper-card)] border border-[var(--ink)] shadow-2xl flex flex-col"
          aria-label={t.assistant.ariaLabel}
        >
          <header className="p-4 border-b border-[var(--rule)] flex justify-between gap-4">
            <div>
              <p className="font-mono text-[0.65rem] uppercase tracking-[0.16em] m-0 text-[var(--brick)]">{t.assistant.title}</p>
              <p className="text-xs text-[var(--graphite)] m-0 mt-1">{t.assistant.subtitle}</p>
            </div>
            <button onClick={() => setOpen(false)} aria-label={t.assistant.launcherClose} className="text-xl leading-none px-1">
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
                className={`text-sm p-3 m-0 max-w-[90%] ${
                  m.role === "user" ? "ml-auto bg-[var(--ink)] text-[var(--bone)]" : "bg-[var(--concrete)] text-[var(--ink)]"
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
                    className="text-[0.68rem] text-left border border-[var(--rule)] bg-[var(--concrete)]/50 px-2 py-1.5 cursor-pointer hover:border-[var(--ink)]"
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
              className="min-w-0 flex-1"
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
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="bg-[var(--chartreuse)] text-[var(--ink)] border border-[var(--ink)] px-5 py-3 font-mono text-xs uppercase tracking-[0.13em] shadow-xl"
      >
        {open ? t.assistant.launcherClose : t.assistant.launcherOpen}
      </button>
    </div>
  );
}
