# UI/UX Implementation Report — Nagaro Space Booking (Phase 2)

**Repository:** https://github.com/januththedev/Nagaro_Booking_System · branch `main`
**Baseline for this pass:** `8c95e97` (post-redesign clean-up) · **Final commit:** see `git log --oneline -1`
**Date:** 2026-10-18
**Runtime:** Node.js v24.22.0 + SQLite (`node:sqlite`), server-rendered HTML, no client framework.

This report covers the Phase 2 redesign **and the independent verification/repair pass** that
followed it. It supersedes the Phase 1 report that previously occupied this file.

---

## 1. What this pass set out to do

1. Independently verify the Phase 2 redesign — in a real browser, not by reading CSS or trusting a green test suite.
2. Correct the venue's location, time zone and currency (TRACE Expert City is in **Colombo, Sri Lanka**, not Addis Ababa).
3. Repair any real defects found during verification without redesigning the product.
4. Re-run every automated suite and preserve the booking-safety invariants.
5. Bring the documentation in line with the corrected product.

## 2. Method and environment

- Booted the **real production entry point** (`src/server/index.js`) against an **isolated throwaway
  database and upload directory** (`%TEMP%\opencode\nagaro-qa\`) seeded with `seed.js --demo`
  (5 published spaces, 7 reservations, 5 customers, a bootstrap admin). Production data was never touched.
- Drove the app in a real Chromium browser through the harness: navigation, form fill/submit, clicks,
  accessibility-tree snapshots, `console` capture, network inspection and Lighthouse audits.
- Exercised responsive layout at the three required widths — **Desktop 1440×900, Tablet 768×1024,
  Mobile 390×844** — by rendering each route inside same-origin iframes pinned to those exact CSS
  pixel widths and measuring `documentElement.scrollWidth` against `clientWidth`, plus per-element
  overflow rects. (The harness has no device-viewport control and cannot rasterise screenshots — see
  §9, Known limitations.)
- Ran `npm test`, `npm run test:concurrency` and `npm run test:e2e` against the final tree.

## 3. Location, time zone and currency correction (root cause, not cosmetics)

**Defect.** The system is for Nagaro at TRACE Expert City, **Maradana, Colombo, Sri Lanka**, but the
business locale was wired to Addis Ababa, Ethiopia: business zone `Africa/Addis_Ababa` (UTC+03:00),
currency `ETB`, Ethiopian demo names, and `EAT`/`UTC+03:00` shown in the UI and docs.

**Fix (underlying calculations, not just the label):**

| Layer | Change |
|---|---|
| `src/server/domain/time.js` | `BUSINESS_TZ` → `Asia/Colombo`; `BUSINESS_TZ_OFFSET_MINUTES` → `330` (UTC+05:30). All helpers (`businessDateKey`, `businessDaySpan`, `businessLocalToEpoch`, …) derive from these two constants. |
| Display strings | `EAT` → `SLST`, `UTC+03:00` → `UTC+05:30` in `layout.js`, `authViews.js`, `publicViews.js`, `bookingViews.js`, `calendarViews.js`, `opsViews.js`, `spaceViews.js`, mail templates. |
| Client defaults | `src/web/public/public.js` and `admin.js` default date/time handling to `Asia/Colombo` / `+05:30`. |
| `startDateKey()` | `bookingViews.js` no longer applies a hard-coded `+3h` shift; it calls `businessDateKey()`, so it follows the same zone constant as everything else. |
| Currency | `ETB` → `LKR` (Sri Lankan Rupee) across validation, pricing, views, seed, scripts and tests. New migration `0003_currency_sri_lanka.sql` upgrades existing rows; `0001_init.sql` default is now `LKR` for fresh installs. |
| Demo data | Customers, organisations and phone numbers are now Sri Lankan (e.g. `Hasini Perera`, `+94 77 …`, `Colombo Digital Labs`). |
| Docs | `README.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `AUDIT_REPORT.md`, `IMPLEMENTATION_REPORT.md`, `REQUIREMENT_TEST_MATRIX.md`, `docs/BOOKING_RULES.md` updated. The only remaining `Addis`/`ETB` strings are in the migration's explanatory comment (history) and one test that deliberately asserts a *foreign* zone is rejected. |

**Invariants preserved:** timestamps remain **UTC epoch milliseconds** in storage; the business zone is
applied only for calendar/UI rendering and opening-hours checks. The single-zone guarantee (reservations,
maintenance and availability all use the same zone) is now enforced by tests rather than by convention.

### 3.1 New/updated automated coverage for the correction

- `tests/unit/businessTimeZone.test.js` and `tests/integration/businessTimeZone.test.js` — Colombo-local
  → UTC instant conversion, displayed business date, midnight boundaries, server-TZ independence
  (the suite re-runs with `TZ` set to a non-Colombo value and asserts identical results), and the
  single-zone guarantee across reservations / maintenance / availability.
- Existing overlap and concurrency guarantees are unchanged and still pass (see §7).

## 4. Defects found and fixed during verification

### 4.1 CSP required `style-src 'unsafe-inline'` for one inline style (fixed at the root)

The only inline style in the codebase was the occupancy meter's `style="width: N%"`. Rather than keep
the relaxed policy, the meter now emits a 5 %-bucket class (`meter__fill--0 … meter__fill--100`) and the
exact figure is exposed through `aria-valuenow`. Tone is selected server-side (`.meter--warning`,
`.meter--danger`). `src/server/http/response.js` is back to **`style-src 'self'`** with no
`unsafe-inline`. A repository-wide scan confirms there are now **no inline `style=` attributes, no
`<style>` blocks and no inline event handlers** in any rendered view.

### 4.2 `/admin/maintenance` overflowed horizontally on mobile (real layout defect)

At 390 px the page scrolled sideways (`scrollWidth` 800 px). Root cause: the maintenance tables live
inside a `.split-layout` grid whose items default to `min-width: auto`, so the 36 rem-wide data table
pushed the whole page open instead of scrolling inside its own wrapper. Fix in `styles.css`:

```css
.split-layout > * { min-width: 0; }
```

The tables now scroll inside their `.table-wrap`; page-level overflow is zero at all three widths.

### 4.3 Footer brand text failed WCAG contrast (1.05:1)

The shared brand lockup defaults to dark body text, but the footer is a dark surface — the site name
and tagline were effectively invisible (Lighthouse: 1.05:1 and 2.06:1). Fixed by re-colouring the
lockup inside `.site-footer` to the shell text tokens. The footer now passes; the footer was previously
the only contrast failure on the landing page.

### 4.4 Heading-order and data-table accessibility

- Admin card titles were `<h3>` directly after the page `<h1>`, skipping a level. Card titles are now
  `<h2>` (`layout.js`) and the nested subsection titles were normalised to `<h3>`, giving a clean
  `h1 → h2 → h3` hierarchy on every page.
- Scrollable data tables are now keyboard reachable: `.table-wrap` renders with `tabindex="0"`,
  `role="region"` and an accessible label, so the `:focus-visible` ring is actually usable.

### 4.5 Gallery button accessible-name mismatch

The venue gallery thumbnail buttons had an `aria-label` that did not contain their visible text
(the "Cover" badge on the cover frame), which fails `label-content-name-mismatch`. The label now
includes the image's alt text and the cover indicator.

### 4.6 `npm test` did not work on the required Node version

The documented scripts passed directories (`tests/unit tests/integration`) to `node --test`, which
Node ≥ 22 treats as module paths → `ERR_MODULE_NOT_FOUND`. Scripts now use globs
(`"tests/unit/**/*.test.js"` etc.), and a `test:e2e` script was added. No test assertions were changed.

### 4.7 Stale `nagaro.et` placeholder

The sign-in email placeholder read `staff@nagaro.et` (Ethiopia's TLD) → now `staff@nagaro.lk`.

## 5. Imagery: verification and provenance

- The redesign removed the committed `src/web/public/photos/*.jpg` fakes; demo imagery is now drawn
  in-process by a deterministic procedural renderer in `src/server/db/seed.js`
  (`renderSpaceScenePng`) and written to the **upload directory**, served through the existing
  `/media/:name` route. Nothing is written into the production public-asset directory.
- **Validity:** all 10 demo frames are structurally valid PNGs, **800×500**, MIME `image/png`,
  ~315–378 KB each, served with `X-Content-Type-Options: nosniff` and a `default-src 'none'; sandbox`
  media CSP. No broken images at any viewport.
- **Category mapping / cover / alternate:** each published space has exactly one `is_cover` frame and
  one alternate. Clicking the second thumbnail swaps the main `<img src>` and its alt text (verified in
  the browser).
- **Fallback:** spaces without images render the `.gallery--empty` state ("No image has been added for
  this space yet."); `coverImage()` falls back to the first available frame for cards.
- **CSP compatibility:** images load from `'self'` with no console errors on any page.
- **Provenance / honesty:** the frames are **illustrative renderings, not photographs**. The seed alt
  text now says so explicitly ("Illustrative rendering of …"), and the public gallery labels were
  changed from "photograph(s)" to "image(s)". Provenance is documented in
  [`docs/IMAGE_PROVENANCE.md`](docs/IMAGE_PROVENANCE.md).
- **Determinism / cost:** `renderSpaceScenePng(code, variant)` is byte-for-byte reproducible and all 10
  frames are distinct. Regression-tested in `tests/unit/seedSceneImages.test.js` (determinism, cover ≠
  alternate, valid PNG at 800×500, bounded size, bounded per-frame time). The renderer runs **only**
  during seeding (`NAGARO_DEMO_SEED` at boot, or `seed.js --demo`) — never on a normal page request.
- No unused committed image assets remain to remove: `src/web/public/` holds only `admin.js`,
  `favicon.svg`, `placeholder-space.svg`, `public.js`, `styles.css`.

## 6. Responsive verification (native measurement, no fabricated screenshots)

All public and admin templates were rendered at **390 / 768 / 1440 px** and measured:

| Surface | Routes checked | Result |
|---|---|---|
| Public | `/`, `/spaces`, `/spaces/:code` (meeting/co-working/auditorium), `/booking-request`, confirmation | **0 page-level overflow** at all three widths; nav collapses to the mobile toggle below the breakpoint |
| Admin | `/admin`, `/admin/reservations` (+ `/new`), `/admin/calendar`, `/admin/spaces` (+ `/new`, `/:id/edit`), `/admin/customers` (+ `/:id`), `/admin/inquiries`, `/admin/maintenance`, `/admin/audit` | **0 page-level overflow**; wide tables scroll inside `.table-wrap` |

**54 route × width combinations, 0 overflow, 0 console errors/warnings.** Browser console and CSP
violation capture were clean on every page.

## 7. Accessibility audit (Lighthouse, final tree)

| Page | Accessibility |
|---|---|
| `/` | 1.00 |
| `/spaces`, `/spaces/:code`, `/booking-request` | 1.00 |
| `/admin`, `/admin/calendar`, `/admin/spaces`, `/admin/spaces/new`, `/admin/spaces/:id/edit` | 1.00 |
| `/admin/customers`, `/admin/customers/:id`, `/admin/inquiries`, `/admin/maintenance`, `/admin/audit`, `/admin/reservations/new` | 1.00 |

No accessibility failures remain. The only outstanding Lighthouse item is `meta-description` on admin
pages (SEO, not accessibility) — deliberately left: the operations console is authenticated and not
meant to be indexed.

## 8. Workflow verification

| # | Workflow | How verified | Result |
|---|---|---|---|
| 1 | Browse the three categories | `/spaces?category=MEETING_ROOM\|AUDITORIUM\|COWORKING` | correct sets returned |
| 2 | Open a space and check availability | `/spaces/:code` gallery + checker | OK |
| 3 | Submit a public request | real form POST from the browser | 303 → honest "received, **not** confirmed" page with reference |
| 4 | A request must **not** create a confirmed reservation | DB inspection after step 3 | reservations still 7; inquiry `status=NEW`, `converted_reservation_id=NULL` |
| 5 | Sign in as staff | real login form, CSRF + cookie | redirect to `/admin` |
| 6 | Manage spaces / images | e2e harness (publish gate, upload) | pass |
| 7 | Create a confirmed reservation | e2e harness | pass |
| 8 | Overlapping reservation rejected | e2e + concurrency suite | pass |
| 9 | Cancel requires a reason; releases inventory | e2e (blank → 422, reason → 303, double-cancel → 409) | pass |
| 10 | Maintenance block affects availability | integration + e2e | pass |
| 11 | Inquiry queue and customer records | browser + e2e | pass |
| 12 | Public pages leak no private data | scan of `/`, `/spaces`, `/spaces/:code`, `/booking-request` for customer names/emails/phones/`internal_notes` | **no leaks** |

Booking-safety behaviour (single-writer `BEGIN IMMEDIATE`, DB anti-overlap triggers, CSRF, rate
limiting, upload magic-byte validation, privacy) was exercised, not weakened.

## 9. Known limitations (stated honestly)

- **No screenshots.** The browser tooling in this environment cannot rasterise a tab without a visible
  desktop window, so no PNG evidence is attached. Responsive claims above rest on **native layout
  measurement** (iframe pinned to exact CSS widths) and computed-style inspection, not on image diffs.
  No before/after screenshots are fabricated.
- **Server startup banner** prints `email: not configured` and `email status: SMTP configured`
  together when `NAGARO_MAIL_TRANSPORT=json`; the two lines describe different things (delivery vs.
  transport) but read as contradictory. Cosmetic; left as-is to avoid touching mail behaviour.
- The generated demo frames are ~300–380 KB each (~3.3 MB for 5 spaces); acceptable for a demo seed but
  large for a CDN. Real deployments use the validated upload path, not the renderer.

## 10. Test results (final tree)

| Suite | Command | Result |
|---|---|---|
| Unit + integration | `npm test` | **190/190 pass** |
| Concurrency (multi-process) | `npm run test:concurrency` | **37/37 pass** |
| End-to-end acceptance | `npm run test:e2e` | **63/63 pass** |
| **Total** | | **290/290 pass** |

New tests added this pass: `tests/unit/businessTimeZone.test.js`,
`tests/integration/businessTimeZone.test.js`, `tests/unit/seedSceneImages.test.js` (plus the migration
ledger and half-open-interval expectations were corrected to match the corrected behaviour).

## 11. Files changed (this pass, relative to `8c95e97`)

- **Time/currency:** `src/server/domain/time.js`, `validation.js`, `src/server/services/*.js`,
  `src/server/routes/adminBookingRoutes.js`, `src/server/db/seed.js`,
  `src/server/db/migrations/0003_currency_sri_lanka.sql` (new), `0001_init.sql`,
  `db/migrations-postgres/0001_init.sql`, mail templates.
- **Views/CSS/JS:** `src/web/views/**` (layout, auth, public, admin), `src/web/public/styles.css`,
  `admin.js`, `public.js`, `src/web/lib/html.js`.
- **HTTP:** `src/server/http/response.js` (CSP `style-src 'self'`).
- **Tests:** new timezone + scene tests; corrected ledger/interval expectations.
- **Docs:** `README.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `AUDIT_REPORT.md`,
  `IMPLEMENTATION_REPORT.md`, `REQUIREMENT_TEST_MATRIX.md`, `docs/BOOKING_RULES.md`,
  `docs/IMAGE_PROVENANCE.md` (new), `PROGRESS.md`, this report.
- **Tooling:** `package.json` (test globs, `test:e2e`).

No Supabase migration, no Vercel Blob work, no payments and no deployment were performed or required.

---

## 12. Addendum — layout and readability fixes (readiness pass, 2026-10-18)

Two visual defects survived the Phase 2 pass and were found during the readiness verification.
Both are recorded in `FINAL_READINESS_REPORT.md §3`; the essentials:

### 12.1 `.detail-list` value column collapsed to one character per line

The responsive two-column rule was `grid-template-columns: minmax(10rem, 14rem) 1fr`. A non-`fr`
track grows to its maximum before the `1fr` track is resolved, so inside any narrow card the value
column collapsed to roughly one character and was clipped by the list's `overflow: hidden`. This
affected the public venue sidebar, the booking-request preview and the admin detail panels.

Fixed at the root in `src/web/public/styles.css`:

```css
.detail-list { grid-template-columns: minmax(0, min(10rem, 40%)) minmax(0, 1fr); }
```

The label column is now capped relative to its container and both tracks have a zero minimum.
After the fix every value box measured 87–318 px with no overflow. Guarded by
`tests/unit/detailListLayout.test.js`, which was verified to fail against the old rule.

### 12.2 Admin data tables shredded names mid-word

`.data-table` cells used `overflow-wrap: anywhere`, which broke words at arbitrary characters in
narrow columns (`Acaci / a Train / ing Roo / m`). Changed to `overflow-wrap: break-word`, which
still breaks unbreakable tokens that would overflow but keeps a column at least one word wide.
Tables now scroll inside the existing focusable `.table-wrap` (`role="region"`, `tabindex="0"`)
rather than squeezing columns below legibility. The space column at the 912 px QA viewport went
from 71 px to 112 px and names now wrap at word boundaries; page-level horizontal overflow remains
0 at 1440/768/390.

### 12.3 Responsive re-verification after the fixes

15 routes × 1440 / 768 / 390 px = **45 combinations: 0 page overflow, 0 collapsed or clipped
detail lists.** Note that Phase 2's "0 page-level overflow" measurement was still true — a
collapsed grid track does not overflow its page — which is exactly why these two defects needed a
targeted check rather than the page-overflow metric alone.
