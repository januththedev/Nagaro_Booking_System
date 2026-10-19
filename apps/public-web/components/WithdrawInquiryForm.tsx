"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

/**
 * Withdrawal keeps a native POST to the Node runtime (so it still works with
 * JavaScript disabled), but when scripting is available the response is
 * consumed here and the visitor stays inside the Next experience instead of
 * landing on the legacy receipt page.
 */
export function WithdrawInquiryForm({ reference, token }: { reference: string; token: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    // A malformed link falls back to the server, which renders the exact
    // explanation the visitor needs.
    if (!reference || !token || submitting) return;
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/booking-request/withdraw", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "text/html",
        },
        body: new URLSearchParams({ reference, token }).toString(),
        redirect: "manual",
      });

      if (response.ok || response.status === 409) {
        router.push(
          `/booking-request/withdraw?ref=${encodeURIComponent(reference)}`
            + `&token=${encodeURIComponent(token)}&withdrawn=1`,
        );
        return;
      }
      setError("That withdrawal link was not recognised. Open the complete link from your receipt.");
    } catch {
      setError("Network error while withdrawing this inquiry. Please retry.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      method="post"
      action="/booking-request/withdraw"
      onSubmit={handleSubmit}
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="reference" value={reference} />
      <input type="hidden" name="token" value={token} />
      {error ? (
        <p role="alert" className="text-sm text-[var(--brick)] m-0">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="btn-primary bg-[var(--brick)] border-[var(--brick)] disabled:opacity-60"
        >
          {submitting ? "Withdrawing inquiry." : "Confirm withdrawal"}
        </button>
        <Link href="/spaces" className="btn-outline">
          Keep inquiry
        </Link>
      </div>
    </form>
  );
}
