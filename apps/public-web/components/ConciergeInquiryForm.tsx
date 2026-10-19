"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { clientApiPath } from "../lib/api";
import { isoDateInColombo } from "../lib/format";
import type { PublicSpace } from "../lib/types";

export function ConciergeInquiryForm({
  spaces,
  initialSpaceCode = "",
  initialDate = "",
  initialStart = "",
  initialEnd = "",
}: {
  spaces: PublicSpace[];
  initialSpaceCode?: string;
  initialDate?: string;
  initialStart?: string;
  initialEnd?: string;
}) {
  const router = useRouter();
  const [spaceCode, setSpaceCode] = useState(
    initialSpaceCode.toUpperCase() || spaces[0]?.code || "",
  );
  const [date, setDate] = useState(initialDate || isoDateInColombo(3));
  const [startTime, setStartTime] = useState(initialStart || "09:00");
  const [endTime, setEndTime] = useState(initialEnd || "12:00");
  const [desks, setDesks] = useState("");
  const [attendees, setAttendees] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [organization, setOrganization] = useState("");
  const [message, setMessage] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      const res = await fetch(clientApiPath("/api/public/inquiries"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          space_code: spaceCode,
          date,
          start_time: startTime,
          end_time: endTime,
          desks,
          attendees,
          customer_name: customerName,
          email,
          phone,
          organization,
          message,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: {
          requestRef: string;
          reference?: string;
          spaceCode?: string;
          emailStatus?: string;
          withdrawToken?: string | null;
          withdrawPath?: string;
        };
        error?: {
          message?: string;
          details?: Record<string, string | string[]>;
        };
      } | null;

      if (!res.ok || !body?.ok || !body.data) {
        const nextErrs: Record<string, string> = {};
        for (const [k, v] of Object.entries(body?.error?.details ?? {})) {
          if (typeof v === "string") nextErrs[k] = v;
        }
        setFieldErrors(nextErrs);
        setError(body?.error?.message || "Please check the highlighted fields and try again.");
        setSubmitting(false);
        return;
      }

      const ref = body.data.reference || body.data.requestRef;
      const qs = new URLSearchParams({
        ref,
        space: body.data.spaceCode || spaceCode,
        emailStatus: body.data.emailStatus || "NOT_CONFIGURED",
      });
      if (body.data.withdrawToken) qs.set("token", body.data.withdrawToken);
      router.push(`/booking-request/received?${qs.toString()}`);
    } catch {
      setError("Network error while sending your inquiry. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 py-12 sm:py-16">
      <header className="pb-10 hairline-b flex flex-col gap-3">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--brick)] m-0">
          TRACE Concierge Desk · Provisional Brief
        </p>
        <h1 className="font-display text-4xl sm:text-6xl text-[var(--ink)] m-0">
          Submit a bespoke venue inquiry.
        </h1>
        <p className="text-base sm:text-lg text-[var(--graphite)] max-w-2xl m-0">
          Use this concierge form for custom production setups, catering coordination or
          multi-room enquiries. Note that an inquiry is <strong>provisional</strong> and does not
          lock inventory. To lock a room or desk immediately, use{" "}
          <Link href={`/book?space=${encodeURIComponent(spaceCode)}`} className="text-[var(--oxidized)] underline">
            direct online checkout
          </Link>
          .
        </p>
      </header>

      {error ? (
        <div role="alert" className="mt-6 p-4 border-l-4 border-[var(--brick)] bg-[#faeae6] text-[var(--brick)] text-sm">
          {error}
        </div>
      ) : null}

      <div className="pt-10 grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
        <form
          method="post"
          action="/booking-request"
          onSubmit={handleSubmit}
          noValidate
          className="lg:col-span-7 hairline-box bg-[var(--paper-card)] p-6 sm:p-8 flex flex-col gap-6"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="inq-space" className="font-mono text-xs uppercase tracking-wider">
              Preferred venue *
            </label>
            <select
              id="inq-space"
              name="space_code"
              value={spaceCode}
              onChange={(e) => setSpaceCode(e.target.value)}
              className="field-input"
              required
            >
              {spaces.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name} — {s.categoryLabel}
                </option>
              ))}
            </select>
            {fieldErrors.space_code ? (
              <p role="alert" className="text-xs text-[var(--brick)] m-0">
                {fieldErrors.space_code}
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="inq-date" className="font-mono text-xs uppercase tracking-wider">
                Date (SLST) *
              </label>
              <input
                id="inq-date"
                name="date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="field-input"
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="inq-start" className="font-mono text-xs uppercase tracking-wider">
                Start time *
              </label>
              <input
                id="inq-start"
                name="start_time"
                type="time"
                step={900}
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="field-input"
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="inq-end" className="font-mono text-xs uppercase tracking-wider">
                End time *
              </label>
              <input
                id="inq-end"
                name="end_time"
                type="time"
                step={900}
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="field-input"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="inq-name" className="font-mono text-xs uppercase tracking-wider">
                Your name *
              </label>
              <input
                id="inq-name"
                name="customer_name"
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                className="field-input"
                required
              />
              {fieldErrors.customer_name ? (
                <p role="alert" className="text-xs text-[var(--brick)] m-0">
                  {fieldErrors.customer_name}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="inq-email" className="font-mono text-xs uppercase tracking-wider">
                Email address *
              </label>
              <input
                id="inq-email"
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="field-input"
                required
              />
              {fieldErrors.email ? (
                <p role="alert" className="text-xs text-[var(--brick)] m-0">
                  {fieldErrors.email}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="inq-phone" className="font-mono text-xs uppercase tracking-wider">
                Telephone
              </label>
              <input
                id="inq-phone"
                name="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="field-input"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="inq-org" className="font-mono text-xs uppercase tracking-wider">
                Organisation
              </label>
              <input
                id="inq-org"
                name="organization"
                type="text"
                value={organization}
                onChange={(e) => setOrganization(e.target.value)}
                className="field-input"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="inq-desks" className="font-mono text-xs uppercase tracking-wider">
                Desks (co-working only)
              </label>
              <input
                id="inq-desks"
                name="desks"
                type="number"
                min={1}
                value={desks}
                onChange={(e) => setDesks(e.target.value)}
                className="field-input"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="inq-attendees" className="font-mono text-xs uppercase tracking-wider">
                Expected attendees
              </label>
              <input
                id="inq-attendees"
                name="attendees"
                type="number"
                min={1}
                value={attendees}
                onChange={(e) => setAttendees(e.target.value)}
                className="field-input"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="inq-message" className="font-mono text-xs uppercase tracking-wider">
              Production brief, layout or access requirements
            </label>
            <textarea
              id="inq-message"
              name="message"
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="field-input"
            />
          </div>

          <div className="pt-2 flex flex-wrap items-center gap-3">
            <button type="submit" disabled={submitting} className="btn-primary">
              {submitting ? "Sending inquiry…" : "Submit concierge inquiry"}
            </button>
            <Link href="/book" className="btn-outline">
              Switch to direct booking
            </Link>
          </div>
        </form>

        <aside className="lg:col-span-5 hairline-box bg-[var(--concrete)]/55 p-6 sm:p-8 flex flex-col gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--oxidized)] m-0">
            How inquiries differ from direct checkout
          </p>
          <h2 className="font-display text-2xl sm:text-3xl text-[var(--ink)] m-0">
            Need instant confirmation instead?
          </h2>
          <p className="text-sm text-[var(--graphite)] m-0">
            Direct checkout (<code>/book</code>) locks inventory immediately inside the booking
            engine. Concierge inquiries (<code>/booking-request</code>) record a provisional brief
            with an <code>INQ-YYYY-NNNNN</code> reference for manual review by the TRACE operations
            team.
          </p>
          <div className="pt-2">
            <Link href={`/book?space=${encodeURIComponent(spaceCode)}`} className="btn-primary">
              Go to direct booking →
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
