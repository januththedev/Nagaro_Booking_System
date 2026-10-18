# Requirements Implementation & Verification Report

**System:** Nagaro Space Booking and Rental Management System, **TRACE Expert City**, Maradana, Colombo, Sri Lanka.
**Repository:** `https://github.com/januththedev/Nagaro_Booking_System` (branch `main`).
**Base commit for this document:** `a32f0f2444465efa42f2357a86077248fef8d50c`.
**Date:** 18 October 2026.
**Scope of this pass:** requirements documentation, evidence grading, and making the
presentation self-contained. **No application behaviour was changed.**

---

## 1. What this report is

This report summarises, for the requirement set defined in `USER_STORIES.md` and
`ACCEPTANCE_CRITERIA.md`:

- what is **completed and verified**;
- what is **implemented but unverified**;
- what is **partially implemented**;
- what is **not implemented** or **blocked**;
- the **test commands actually run** in this pass and their real results;
- which **implementation defects were found** and what was (and was not) done about them.

It preserves four distinctions that earlier reports blurred:

| Question | Where it is answered |
|---|---|
| What does the system *intend* to do? | `USER_STORIES.md`, `ACCEPTANCE_CRITERIA.md` |
| What *exists in the code*? | `USER_STORY_TRACEABILITY.md` (implementation-location column) |
| What has actually been *tested*? | `USER_STORY_TRACEABILITY.md` (status + evidence columns) and §4 below |
| Where does it actually *run*? | §8 below — **locally only** |

## 2. Deliverables produced

| # | Deliverable | Status |
|---|---|---|
| 1 | `USER_STORIES.md` — 58 stories across 9 required epics plus a production-boundary epic | Created |
| 2 | `ACCEPTANCE_CRITERIA.md` — 176 measurable criteria | Created |
| 3 | `USER_STORY_TRACEABILITY.md` — per-criterion implementation + test matrix | Created |
| 4 | `REQUIREMENT_TEST_MATRIX.md` — legacy `R-*` snapshot updated with a cross-reference (section 14) | Updated |
| 5 | `presentation/slides.html` + `presentation/assets/` — self-contained 10-slide deck | Updated |
| 6 | This report | Created |
| — | `README.md` — documentation index + project-status note | Updated |

## 3. Requirement counts

| Dimension | Count |
|---|---|
| User stories | 58 |
| Acceptance criteria | 176 |
| Epics | 9 required + 1 production-boundary epic |

### 3.1 Acceptance criteria by status

| Status | Criteria | Share |
|---|---|---|
| **Verified** | 133 | 75.6% |
| **Implemented, not verified** | 36 | 20.5% |
| **Partially implemented** | 1 | 0.6% |
| **Not implemented** | 4 | 2.3% |
| **Blocked** | 2 | 1.1% |
| **Total** | **176** | |

### 3.2 Stories by status

| Status | Stories | IDs |
|---|---|---|
| **Verified** | 32 | US-01, 03, 05–09, 13, 16, 17, 20–22, 24, 27, 29, 32–34, 37–42, 44, 45, 47, 48, 50, 51, 53 |
| **Implemented, not verified** | 22 | US-02, 04, 10, 12, 14, 15, 18, 19, 23, 25, 26, 28, 30, 31, 35, 36, 43, 46, 49, 52, 55, 58 |
| **Partially implemented** | 1 | US-11 |
| **Not implemented** | 2 | US-54, US-56 |
| **Blocked** | 1 | US-57 |
| **Total** | **58** | |

## 4. What was actually run (this pass)

All commands were executed on 18 October 2026 with the portable Node.js
v24.22.0 runtime (`node:sqlite` requires ≥ 22.5). Nothing below is copied from an
earlier report.

| Command | Result |
|---|---|
| `npm test` (unit + integration) | **192 passed, 0 failed** (7 suites, ~13.5 s) |
| `npm run test:concurrency` | **37 passed, 0 failed** (~28 s) |
| `npm run test:e2e` | **63 passed, 0 failed** — `=== RESULT: 63 passed, 0 failed ===` |
| Documentation validator (`validate-docs.mjs`, written for this pass) | **16/16 checks passed** |
| Deck verification (real browser, served from tracked assets) | **10 slides, 10 images, 0 broken**, navigation and deep links working |

**Total automated tests: 292 passed, 0 failed.**

### 4.1 Documentation validator checks (16/16)

- story IDs unique, and exactly `US-01`…`US-58`;
- acceptance-criteria IDs unique (176 defined);
- every story links to at least one criterion; every criterion is referenced by a story; every criterion a story lists actually exists;
- every criterion is represented in the traceability matrix, exactly once;
- every traceability status is from the allowed vocabulary;
- declared criterion counts match the matrix rows;
- `REQUIREMENT_TEST_MATRIX.md` `US-*` (35) and `AC-*` (40) references all resolve;
- all 8 `slides.html` image references exist on disk;
- `slides.html` no longer references the gitignored `artifacts/` directory;
- `slides.html` contains 10 slides.

### 4.2 Deck verification detail

Served over HTTP and inspected in a real browser:

```
slideCount: 10        pager: "1 / 10"        broken images: []
imgs: 10 references, all naturalWidth > 0 (1120 px wide)
ArrowRight  -> active slide 2, hash #2
deep link #6 -> active slide 6
```

Images are referenced as `assets/<name>.jpg` (relative), so the deck works from a
fresh clone with no `artifacts/` directory present.

## 5. Completed and verified

The core booking system is verified end to end:

- **Space discovery** — published-only public directory and detail pages, no PII (US-01, US-03; partially US-04).
- **Booking requests and inquiries** — submission, a reference, "this is not a confirmation", per-field validation, durable-before-email, token withdrawal (US-05 – US-09).
- **Authentication and dashboard** — sign-in, anonymous access blocked, `ADMIN`/`STAFF` authorization, live dashboard figures (US-13, US-16, US-17).
- **Space and pricing management** — create, edit, the publication gate, photograph management and upload safety, category-correct LKR pricing, archive/restore (US-20 – US-22, US-24).
- **Reservation management** — cancellation with a mandatory reason and atomic inventory release, customer records with duplicate detection (US-27, US-29).
- **Availability and integrity** — the defining guarantee (no double booking), half-open intervals and buffers, opening hours/duration/capacity, maintenance as occupancy, availability previews (US-32 – US-34, US-37 – US-38).
- **Time and money** — UTC epoch-ms storage with SLST display and host-zone independence, integer-cent LKR pricing (US-39 – US-41).
- **Notifications, auditing, security** — honest email delivery state, audit entries, public privacy, CSRF, security headers/CSP/inert media/no stack traces, server-side validation (US-42 – US-48).
- **Reliability** — readable tables and detail lists, consistent error and empty states, reproducible tests (US-50, US-51, US-53).

The strongest single piece of evidence remains the concurrency suite:
`tests/concurrency/roomDoubleBooking.test.js` CASE 4 runs **10 rounds × 8 real OS
processes** on fresh databases and observes exactly one winner every round, and
`tests/concurrency/triggerDirectWrite.test.js` proves the database refuses an
overlapping `ACTIVE` occupancy row even when the service check is bypassed.

## 6. Implemented but unverified (36 criteria / 22 stories)

These are real, readable implementations whose specific acceptance criterion is
not exercised by any test in the repository. They are **testing** gaps, not
feature gaps. Full detail is in `USER_STORY_TRACEABILITY.md`; the notable ones:

- **Reservation and calendar routes have no integration tests** — only e2e happy paths and service-level concurrency tests. Missing negative paths: missing space/customer (AC-25.3), editing a cancelled reservation (AC-26.3), the reservation list and its filters (AC-28.1/28.2), calendar event contents (AC-31.2).
- **Session internals** — hash-only token storage (AC-46.1), absolute expiry (AC-46.2) and idle timeout (AC-46.3) are implemented but not asserted; revocation *is* tested (AC-46.4).
- **Login lockout and rate limiting** (AC-14.1 – 14.3) and the generic wrong-password refusal (AC-12.2) are implemented (`sessions.js`, `rateLimit.js`) but untested.
- **Audit-log atomicity** (AC-43.2) — the audit row is written inside `withWriteTransaction`; no rollback test asserts it disappears with the mutation.
- **Guard-only rules** — duplicate space code (AC-18.3), category change under occupancy (AC-19.3), non-co-working desk inventory (AC-23.3), blank maintenance reason (AC-35.1), maintenance-block cancellation (US-36), public directory filters (US-02), the DRAFT/ARCHIVED 404 (AC-04.2), migration idempotency (AC-52.1).
- **Manual-only evidence** — responsive layout (US-49) was verified by hand (15 routes × 1440/768/390, 0 overflow) but has no automated viewport test; LKR formatting (AC-22.3) was observed in the running demo; auto-completion of past reservations (US-30) was observed in the boot log.

## 7. Partially implemented, not implemented and blocked

### 7.1 Partially implemented — US-11 (convert an inquiry into a reservation)

- **Works:** `GET /admin/reservations/new?inquiry=<id>` pre-fills the form from the inquiry (`adminBookingRoutes.js`), and `inquiryService.convertInquiryToReservation` exists and is unit-tested.
- **Gap:** **no route calls `convertInquiryToReservation`.** `inquiry.converted_reservation_id` is therefore never set, and `POST /admin/inquiries/:id/status` refuses the `CONVERTED` transition (`adminOpsRoutes.js` L241). The inquiry cannot reach `CONVERTED` through the user interface.
- **Impact:** staff can still create the reservation and mark the inquiry `CONTACTED`/`CLOSED` manually, so this is not release-blocking — but the "convert" workflow is incomplete.
- **Not fixed in this pass** (deliberately: it is a workflow-completeness gap, not a correctness or security defect, and the brief asked not to add features).

### 7.2 Not implemented

| ID | Requirement | Why |
|---|---|---|
| US-54 | PostgreSQL persistence at runtime | `db/migrations-postgres/0001_init.sql` exists and `pg` is declared, but no runtime code path loads it — `connection.js` opens a local SQLite file only. |
| US-56 | Production deployment | No `vercel.json`, no `api/` entry point, no serverless handler; `src/server/index.js` is a long-running `node:http` server with local disk. No deployment has been performed. |

### 7.3 Blocked

| ID | Requirement | Blocker |
|---|---|---|
| US-57 | Real SMTP delivery | No SMTP credentials/server are configured. The delivery machinery is implemented and tested through transport seams (`tests/unit/mailer.test.js`), but real delivery cannot be verified. Boot reports `email status: NOT configured`; inquiries are still stored and flagged undelivered. |

### 7.4 Related, and honest about it

- **Durable object storage (US-55)** is **implemented, not verified**: the Vercel
  Blob adapter *is* wired (`uploads.js` imports `blobEnabled`/`storeBlob`;
  `adminUploadRoutes.js` imports `deleteBlob`) and activates when
  `BLOB_READ_WRITE_TOKEN` is set, but the remote path is never exercised. (An
  earlier note claimed this adapter was "not wired"; it is wired.)
- **Accessibility (US-58)** is **implemented, not verified**: forms use labelled
  controls, tables sit in focusable scroll containers and the markup is semantic,
  but **no axe/Lighthouse/WCAG audit was run in this pass**, so **no accessibility
  score is claimed**. The "Lighthouse accessibility 1.00" figure in the banner of
  `REQUIREMENT_TEST_MATRIX.md` is a historical claim from an earlier pass and is
  explicitly not re-verified here.

## 8. Deployment status

**Local demo readiness only. Not deployed anywhere.**

- The runtime is a long-running `node:http` process writing a local SQLite file
  (`data/`) and a local uploads folder (`storage/`).
- A production-mode local boot smoke test was performed and is recorded in
  `FINAL_READINESS_REPORT.md` (`/`, `/spaces`, `/booking-request` → 200; `/admin`
  → 303; security headers present). **This is not a deployment.**
- No production URL exists, so **no post-deployment smoke test exists**.
- No real booking data was exposed or migrated.

## 9. Implementation defects found

Reconciling the legacy defect list (`REQUIREMENT_TEST_MATRIX.md` §13.4) against
the current code:

| Defect | Status after this pass |
|---|---|
| **D-1** maintenance insert placeholder/column mismatch | **Fixed** (earlier commit); regression in `tests/concurrency/intervalBoundaries.test.js` CASE 10c. |
| **D-2** multi-day/overnight bookings rejected (`checkBookingRules`) | **Fixed** (earlier commit); regression in CASE 11c. |
| **D-3** `checkBookingRules` reads snake_case `space.open_time` | **Still present, latent.** Every in-tree caller passes a raw row, so nothing fails today; the contract is fragile. **Documented, not changed** (changing it would alter booking logic). |
| **D-4** deactivated desks are not reactivated; codes accumulate | **Still present.** Counts remain correct; the table accumulates retired desks. Documented under US-23. |
| **D-5** `occupancy.maintenance_block_id` lacks a `REFERENCES` clause | **Still present.** Harmless because maintenance blocks are never deleted. Documented. |

**No new correctness, security or data-integrity defect was found in this pass.**
**No application code or booking logic was modified.** The only non-documentation
change is the deck's image paths (see §10).

## 10. Presentation self-containment

- The deck referenced **8 unique screenshots** under the gitignored
  `artifacts/presentation/screens/` directory (the brief anticipated nine; the
  deck actually references eight). The exact referenced set is:
  `01-public-home`, `03-public-space-meeting-room`, `05-public-booking-request`,
  `06-admin-dashboard`, `07-admin-reservations`, `09-admin-calendar`,
  `11-admin-maintenance`, `14-admin-activity-log`.
- All eight were confirmed genuine captures of the running application (verified
  by opening one: the **Nagaro Operations Console → Maintenance** page with the
  `SLST · UTC+05:30` badge, `TRC-AUD-01 Grand Auditorium`, and no secrets
  visible).
- They were copied **byte-for-byte** (no re-encoding, no cropping, no edits) into
  **`presentation/assets/`** and the `slides.html` references were repointed from
  `../artifacts/presentation/screens/` to `assets/`.
- Total committed asset size: **≈ 3.5 MB** (8 JPEGs, 1120 px wide).
- The deck was opened from the tracked assets and all ten slides render with no
  broken images; navigation, deep links (`#6`) and the print stylesheet are
  unchanged.

## 11. How to run the demo

```powershell
# 1. Point the launchers at a Node.js >= 22.5 runtime
set NAGARO_NODE=C:\path\to\node-v24.x-win-x64\node.exe

# 2. Install and start
tools\npm.cmd install
tools\npm.cmd run migrate
tools\npm.cmd run seed -- --demo
tools\npm.cmd start          # http://127.0.0.1:4173
```

Demo administrator (development only, documented): `admin@nagaro.local` /
`NagaroDemo2026`.

To view the deck after cloning (no build step): serve the repository over HTTP and
open `/presentation/slides.html`, or open the file directly in a browser.

## 12. Honest bottom line

The Nagaro system is **locally demo-ready and its core booking guarantee is
verified by automated, multi-process tests**. Its requirements are now traceable,
its acceptance criteria are testable, and its implementation status is graded per
criterion against real evidence — including 36 criteria that are **not yet
verified**, one **partially implemented** workflow (inquiry → reservation), and
three **not implemented / blocked** capabilities (PostgreSQL runtime, production
deployment, live email). No accessibility score, deployment, or live-email claim
is made. The presentation is self-contained and works from a fresh clone.
