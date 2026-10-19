# Public Frontend Report — Next.js cut-over for TRACE Spaces

**Branch** `ui/premium-hackathon-redesign` · **Commit** `COMMIT_SHA_PLACEHOLDER`
**Date** 19 October 2026 · **Scope** public experience only; the staff console, booking engine,
data model and migrations 0001–0004 are unchanged in behaviour.

---

## 1. What was delivered

The public experience (landing page, catalogue, venue detail, direct checkout, private booking
management, concierge inquiry and withdrawal) now renders from a Next.js 15 / React 19 / TypeScript
app in `apps/public-web`, art-directed as an "urban creative campus" surface: brick/concrete/bone
palette, Libre Caslon Display + IBM Plex, full-bleed photography, editorial layout, one signature
WebGL hero.

The tested Node booking engine is untouched as the source of truth. Node remains the only public
listener and keeps `/api/*`, `/admin/*`, `/assets/*`, `/media/*` and the no-JavaScript form posts.
The legacy server-rendered public pages remain in the build behind one environment variable.

| | |
|---|---|
| Next.js public app | `apps/public-web` (39 source files, App Router, Tailwind 4) |
| Public pages | `/`, `/spaces`, `/spaces/[code]`, `/book`, `/book/confirmed`, `/book/manage`, `/booking-request`, `/booking-request/received`, `/booking-request/withdraw` |
| Gateway | `src/server/http/publicFrontendProxy.js` (method-aware, same-origin) |
| Public JSON contract | `POST /api/public/bookings`, `GET /api/public/bookings/:reference`, `POST …/cancel`, `POST /api/public/inquiries` |
| Rollback | `PUBLIC_FRONTEND=legacy` (default) — no rebuild, no data migration |

### Design brief compliance

- No decorative `01 / 02 / 03` markers anywhere on public surfaces — the legacy home page, the
  checkout step labels and the form legends were re-worded (e.g. "Space & time → Your details →
  Review & confirm"), and `tests/unit/publicFrontendGuards.test.js` plus
  `apps/public-web/tests/surface.test.mjs` fail if a zero-padded numeral, a horizontal rail,
  `scroll-snap` or a `snap-*` utility returns.
- The generic floating statistic blocks, card grids and traces were replaced with an
  editorial chapter layout; the coworking "rail" is now a varied grid with real aspect ratios.
- One signature WebGL canvas: lazy (`ssr: false`, `import("three")` on idle), DPR capped at 1.5,
  paused off-screen via `IntersectionObserver`, recovers from `webglcontextlost`, and bails out on
  reduced motion, coarse pointers, `saveData`, <4 cores or <4 GB memory. A real `<picture>` +
  `fetchPriority="high"` photograph paints first, so the hero is complete with JavaScript disabled.
- Lenis runs only for fine-pointer desktop users, together with GSAP `ScrollTrigger` (`once: true`,
  compositor-only `autoAlpha`/`y`), and is destroyed on route change. CSS `prefers-reduced-motion`
  collapses every animation to 0.001 ms as a second safety net.

---

## 2. One origin, two owners

```
browser ──► Node :4173  (the only public listener)
              ├─ /api/*, /admin/*, /assets/*, /media/*        → Node (engine, console, files)
              ├─ POST /book, /book/cancel, /booking-request,
              │  /booking-request/withdraw                     → Node (no-JS form fallback)
              └─ every other GET                               → streamed to Next :4174
```

- `isBackendOwnedPath(pathname, method)` and `BACKEND_FORM_POSTS` in
  `src/server/http/publicFrontendProxy.js` decide ownership, so the same cookie jar, CSRF secret,
  rate limiter and booking service serve both stacks.
- `apps/public-web/next.config.mjs` rewrites `/api`, `/admin`, `/assets`, `/media` back to Node, so
  the Next port is never a second origin.
- Capability pages carry `Cache-Control: no-store, private`, `Referrer-Policy: no-referrer`,
  `X-Robots-Tag: noindex` (middleware); the JSON booking endpoints set the same headers server-side.

---

## 3. Engine preservation

Nothing about the integrity guarantees changed:

- **Immediate confirmation.** Direct checkout still commits inside `BEGIN IMMEDIATE` through the
  staff `createReservation` path, so `occupancy` triggers, status semantics and the optimistic
  `UPDATE … WHERE status = 'CONFIRMED'` all still apply. Every "a member of staff will confirm"
  sentence was removed from direct-booking copy; only concierge inquiries are described as
  provisional, and both the inquiry receipt and the venue note say so explicitly.
- **Idempotency.** The JSON checkout reuses `form_token` idempotency: a retry returns `200` with the
  original reference and `idempotent: true` (verified by the e2e harness).
- **Capability tokens.** Private links stay capability-only (`Authorization: Bearer`,
  `x-booking-capability` or `?token=`), hashed at rest, and a wrong token still reads as *not
  recognised* rather than leaking existence.
- **Overlap protection.** Unchanged and still proven by `npm run test:concurrency` and
  `npm run demo:double-booking`.
- **LKR + Asia/Colombo.** Unchanged; every price is integer cents formatted as LKR and every
  customer-facing instant is rendered in SLST.
- **Private projection.** Public responses still emit exactly `PUBLIC_SPACE_KEYS` with no customer
  PII; `tests/unit/publicPrivacy.test.js` enforces it.

### Defects found and fixed while verifying

| Defect | Fix |
|---|---|
| The checkout's "estimated settlement" used the rate row flagged `is_default` (MONTH) while the engine bills the space's own pricing unit (DAY) — a 4-hour desk booking was estimated at LKR 10,500 and recorded at LKR 600 | `pricingUnit` added to the public space projection; the estimate moved to `apps/public-web/lib/quote.ts`, mirroring `pricingService.js` rule for rule; `apps/public-web/tests/quote.test.mjs` compares the client mirror against the real server module |
| At 320 px the two hero actions wrapped and fell 8 px below a 568 px first viewport | Compact base scale (`pt-10 pb-8`, `text-[2rem]`), `gap-2`, and a ≤359 px rule that keeps both actions on one line; hero CTAs now end at 533 px |
| Withdrawing an inquiry from the Next UI posted natively to Node and landed the visitor on the legacy receipt page | `WithdrawInquiryForm` intercepts the submit with `fetch`, keeps the native `method="post" action="/booking-request/withdraw"` fallback, and returns the visitor to a Next confirmation state |

---

## 4. Verification evidence

All suites were run on the committed tree.

| Suite | Command | Result |
|---|---|---|
| Unit + integration | `npm test` | **220 passed, 0 failed** (7 suites) |
| Public app | `npm run test:public` | **31 passed, 0 failed** |
| Booking acceptance (HTTP, real forms/CSRF/upload) | `npm run test:e2e` | **84 passed, 0 failed** |
| Frontend cut-over | `npm run test:cutover` | **63 passed, 0 failed** |

`npm run test:cutover` is new: it boots `src/server/index.js` with `PUBLIC_FRONTEND=next` plus
`next start`, drives the **public** origin, and asserts which process answered, that the
no-JavaScript form posts reach the booking engine, that capability pages stay unshareable, that the
server payload is complete without JavaScript, and finally restarts the runtime with
`PUBLIC_FRONTEND=legacy` to prove the rollback.

### Interactions exercised in a real browser (Chromium, live stack)

| Interaction | Result |
|---|---|
| Hero "Explore spaces" click | client-side navigation to `/spaces` |
| Catalogue search "auditorium" | "Showing 1 of 5 published venues", Acacia filtered out |
| Category filter "co-working desks" | 2 of 5, Co-working Floor + Quiet Pods |
| Venue card → `/spaces/TRC-CW-02` | detail with gallery, attributes, rates, availability console |
| "Check live availability" (2 h) | engine validation surfaced: "Minimum booking duration for this space is 4h." |
| "Check live availability" (4 h) | `GET /api/public/availability?…T09:00:00+05:30…` → "Available — 8 of 8 desks free." |
| "Confirm booking online" | `/book` pre-filled (space, date, 09:00–13:00, 1 desk) |
| Checkout stages 1→3 + submit | "RESERVATION CONFIRMED", `NG-2026-00009`, estimated settlement LKR 600 (1 × per day) now equal to the recorded tariff |
| "Manage booking" | `/book/manage?ref=…&token=…` shows CONFIRMED + capability-protected details |
| "Cancel reservation" | `POST /api/public/bookings/NG-2026-00009/cancel` → CANCELLED, inventory released |
| Concierge inquiry submit | `INQ-2026-00003`, "provisional … has not locked inventory", honest `emailStatus=NOT_CONFIGURED`, withdrawal link |
| Inquiry withdrawal | stays in Next, "Inquiry withdrawn." with no inventory to release |
| Mobile menu (375 px) | toggles open with 4 links, Escape closes, navigation closes it |
| Skip link | focuses, sets `#main-content`, target present |

`browser.console` reported **no warnings or errors** on `/`, `/spaces`, `/spaces/[code]`, `/book`,
`/book/manage`, `/booking-request`, `/booking-request/received` and `/booking-request/withdraw`
(the only error anywhere was the expected 404 resource fetch for an unknown path).

### Lighthouse (local production build, through the gateway)

| Page | Accessibility | Best practices | SEO |
|---|---|---|---|
| `/` | 1.00 | 1.00 | 1.00 |
| `/spaces` | 1.00 | 1.00 | 1.00 |
| `/book` | 1.00 | 1.00 | 1.00 |

### Responsive matrix

Measured in real Chromium layout at exact CSS widths inside a same-origin harness (document
`scrollWidth` vs viewport, plus every `main` descendant's right edge):

| Width × height | `/` | `/spaces` | `/book` | Hero CTA bottoms (`/`) |
|---|---|---|---|---|
| 320 × 568 | ok (305/320) | ok | ok | 533 / 533 (in viewport) |
| 375 × 667 | ok (360/375) | ok | ok | 483 / 483 |
| 390 × 844 | ok (375/390) | ok | ok | 660 / 660 |
| 768 × 1024 | ok (753/768) | ok | ok | 824 / 824 |
| 1024 × 768 | ok (1009/1024) | ok | ok | 705 / 705 |
| 1440 × 900 | ok (1425/1440) | ok | ok | 837 / 837 |

No horizontal overflow, no clipped interactive element, and both first-viewport calls to action
fully visible at every width. The desktop nav swaps to the mobile toggle at the `md` breakpoint.

---

## 5. Documents and run instructions

```bash
npm install --prefix apps/public-web   # frontend dependencies
npm run build:public                   # production build
npm run start:full                     # Node :4173 + next start :4174, one public origin
# development
npm run dev:full
# rollback
PUBLIC_FRONTEND=legacy npm start
```

Updated in this phase: `README.md` (frontend + scripts + rollback), `ARCHITECTURE.md` §3 and the new
§12 (gateway and ownership split, environment variables), `API_CONTRACTS.md` (public JSON routes and
the `pricingUnit` field), plus the legacy renderer and stylesheet in `src/web/views/publicViews.js`
and `src/web/public/styles.css`.

---

## 6. Limitations and follow-ups

1. **Device emulation, not devices.** Responsive checks used Chromium layout inside a same-origin
   iframe harness at exact CSS widths; no physical device, no CPU/network throttling, no Safari.
2. **`prefers-reduced-motion` could not be forced at runtime** (no DevTools-protocol access in this
   environment). It is covered by source guards, the CSS override, and by proving the server payload
   never hides content pending animation — but a manual check in a browser with the OS setting on
   is still worth doing.
3. **Screenshots were not captured**: the browser tool requires a visible desktop window. The live
   stack is left running on `http://127.0.0.1:4173` (demo seed, admin `admin@nagaro.local` /
   `NagaroDemo2026`) for review in the Review pane.
4. **No hosted verification.** Vercel/Supabase/Blob deployment and SMTP delivery were not exercised;
   locally email status is honestly reported as `NOT_CONFIGURED`.
5. **Demo pricing is monthly-biased for desks.** Seeded co-working spaces declare a DAY pricing unit
   with weekly/monthly rate rows; a 4-hour desk booking is therefore billed as one day (LKR 600).
   The estimate now mirrors the engine, but the demo catalogue itself is worth revisiting before a
   public launch.
6. **`next build` prints a multiple-lockfile warning** (root and app lockfiles). It does not affect
   `next start`; set `outputFileTracingRoot` if the app is ever built as a standalone bundle.
7. The legacy renderer stays one release behind the flag, as agreed; it is not being updated feature
   for feature from here.
