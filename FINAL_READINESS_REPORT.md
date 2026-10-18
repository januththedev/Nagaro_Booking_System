# Final Readiness Report — Nagaro Space Booking System

**Subject:** Nagaro space-booking and rental management system, TRACE Expert City, Maradana, Colombo, Sri Lanka
**Repository:** `https://github.com/januththedev/Nagaro_Booking_System`
**Baseline commit (start of this pass):** `4a0e562b5c9f49536c63e0e292e2c86a629ba472`
**This pass's changes:** contained in the commit that adds this file (`git log -1 --format=%H`)
**Report date:** 2026-10-18
**Verification runtime:** portable Node.js **v24.22.0** (`node:sqlite` requires ≥ 22.5; the system Node on the verification machine is v20.18.3 and cannot run the application)

---

## 1. Verdict

> **Locally demo-ready. Not production-deployed, and no deploy was attempted.**

The application starts from the documented command, serves every public and administrative
route, and provably refuses double bookings under real multi-process contention. Four
release-affecting defects were found and fixed in this pass (two presentation-blocking layout
bugs, one time-of-day-dependent test failure, and three launcher scripts that hardcoded a
different machine's paths). All three test suites pass from a clean checkout of this commit.

Two claims are deliberately **not** made anywhere in this report: that the system is deployed,
and that email delivery works. Neither was performed — see §7.

---

## 2. What was executed, and the result

### 2.1 Automated suites (re-run on this commit, not copied from an earlier report)

| Command | Result | Notes |
|---|---|---|
| `npm test` | **192 passed, 0 failed** (7 suites, ~17 s) | 190 pre-existing + **2 new** regression tests added in §3.1 |
| `npm run test:concurrency` | **37 passed, 0 failed** (~33 s) | Anti-overlap guarantee under contention |
| `npm run test:e2e` | **63 passed, 0 failed** | Boots the real `src/server/index.js` on port 4217 against a throwaway DB and drives real forms, CSRF tokens, cookies and a real PNG upload |
| **Total** | **292 passed, 0 failed** | |

The e2e suite was failing at the start of this pass (62/63) for a genuine reproducibility
reason; see §3.3.

### 2.2 Independent concurrent-write proof

`npm run demo:double-booking` spawns **six separate operating-system processes** that open the
same SQLite file and race for the identical window:

```
processes that confirmed : 1 (expected 1)
processes refused        : 5 (expected 5)
ACTIVE occupancy rows, raced window : 1 (expected 1)
GUARANTEE HOLDS: six simultaneous OS processes, exactly one confirmed booking,
no second reservation row, no second occupancy claim.
```

The five losers each received `DOUBLE_BOOKING_CONFLICT` naming the winning reference
(e.g. `blocked by NG-2026-00002`). This is the defining property of the system, demonstrated
rather than asserted.

### 2.3 Browser workflow verification (real browser, real forms)

Driven against a running instance with the demo database. Each step was observed in the page,
not inferred from a passing test:

| # | Workflow | Observed result |
|---|---|---|
| 1 | Invalid admin sign-in | Rejected with the generic message *"Email or password is incorrect."* (no user enumeration) |
| 2 | Valid admin sign-in | Dashboard loaded; session established |
| 3 | Public booking request with missing fields | Native required-field validation blocked submission |
| 4 | Valid public booking request | Stored; confirmation page showed reference `INQ-2026-00003` and the explicit statement that this is **not a confirmed booking yet** |
| 5 | Inquiry visible to staff | Appeared in the admin inquiry queue with status *New*, flagged *"reserves no inventory until staff create a reservation"* |
| 6 | Staff converts inquiry → confirmed reservation | Reservation `NG-2026-00008` created with status `CONFIRMED` |
| 7 | Overlapping booking attempt | **Refused:** *"This period is already booked … Nothing was created"*, naming `NG-2026-00008` |
| 8 | Cancellation with an empty reason | Blocked (reason is mandatory) |
| 9 | Cancellation with a reason | Status → `CANCELLED`, reason retained, *"1 inventory claim(s) released; the booking history is preserved"*; a `confirm()` dialog was shown first |
| 10 | Maintenance block creation | *"Blocked 1 unit(s) on TRC-MR-01 from 09:00–12:00 on 2026-11-21: HVAC service"* |
| 11 | Booking attempt inside the maintenance window | **Refused:** *"This period is blocked for maintenance. Nothing was created"* |
| 12 | Request at 00:30 | Rejected as outside 08:00–18:00 opening hours, with the time zone named explicitly *"(Sri Lanka Standard Time)"* and the correct SLST date |

Steps 4–9 were performed against the demo database as it stood at that moment; the local demo
database was subsequently reseeded (§3.6) so that the presentation shows fully Colombo-localised
data. Reseeding changes local data only and does not touch the code paths exercised above.

### 2.4 Time-zone correctness (storage layer)

`UTC epoch-milliseconds are the storage format`; `Asia/Colombo` (UTC+05:30, no DST) is used
only to interpret and display local wall-clock values.

- A reservation created for **20 Nov 10:00 SLST** was stored as `2026-11-20T04:30:00.000Z` —
  exactly 5 h 30 m earlier, as required.
- Every reservation row in the database carried `currency = LKR`.
- `src/server/domain/time.js` was executed directly under `TZ=UTC`, `TZ=America/New_York`,
  `TZ=Pacific/Kiritimati` (UTC+14) and `TZ=Asia/Colombo`. All four produced **identical**
  results: `00:30 SLST → 2026-11-20T19:00:00.000Z`. The maths therefore never consults the host
  machine's zone.

### 2.5 Responsive layout sweep

15 routes × 3 widths = **45 combinations**, measured on real layout in a pinned-width document
(the QA browser viewport is fixed at 912×670 and cannot be resized — see §7.1):

| Width | Routes | Horizontal page overflow | Collapsed/clipped detail lists |
|---|---|---|---|
| 1440 | 15 | 0 | 0 |
| 768 | 15 | 0 | 0 |
| 390 | 15 | 0 | 0 |

Routes covered: `/`, `/spaces`, `/spaces/TRC-MR-01`, `/spaces/TRC-AUD-01`, `/booking-request`,
`/admin`, `/admin/login`, `/admin/reservations`, `/admin/reservations/1`, `/admin/calendar`,
`/admin/spaces`, `/admin/spaces/1/edit`, `/admin/maintenance`, `/admin/inquiries`,
`/admin/customers`, `/admin/audit`.

### 2.6 Security spot-checks

- `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`
  (no `unsafe-inline`, no third-party origins) in both development and production mode.
- `X-Frame-Options: DENY`.
- `/admin`, `/admin/customers`, `/admin/reservations/1`, `/admin/spaces/1/edit`,
  `/admin/maintenance`, `/admin/audit` all returned **303 → login** when unauthenticated.
- Unknown paths return a friendly error page with **no stack trace and no framework detail**.
- Media is served inertly: its own response carries a sandbox CSP and `nosniff`.
- No `+251` numbers, Ethiopian names, or `ETB` currency remain anywhere in the runtime seed data
  or views; only the intentional historical comments in migration
  `0003_currency_sri_lanka.sql` reference the change.

### 2.7 Production-mode boot smoke test (local, not a deployment)

`NODE_ENV=production` booted against a temporary database on port 4321 and served: `/` → 200,
`/spaces` → 200, `/booking-request` → 200, `/admin` → 303, `/admin/login` → 200, with the
security headers above and the database integrity gate passing. This proves production mode is
runnable — it is **not** evidence of a deployment.

---

## 3. Defects found and fixed in this pass

Only release-affecting defects were changed. Every fix carries a regression test where a test
can express the invariant.

### 3.1 `.detail-list` collapsed to one character per line (presentation-blocking) — FIXED

**Symptom.** In `src/web/public/styles.css`, the responsive rule

```css
.detail-list { grid-template-columns: minmax(10rem, 14rem) 1fr; }
```

gave the label column a *fixed* maximum of `14rem`. A non-`fr` track grows to its maximum
**before** the `1fr` track is resolved, so whenever the list sat inside a narrow card the value
column collapsed to roughly one character and was then clipped by the list's `overflow: hidden`
box.

**Where it was visible.** The public venue sidebar, the booking-request preview cards, admin
detail/edit panels and customer cards — e.g. an address rendering one letter per line.

**Fix.** Cap the label column relative to its container and force a zero minimum on both tracks:

```css
.detail-list { grid-template-columns: minmax(0, min(10rem, 40%)) minmax(0, 1fr); }
```

**Verification.** After the fix, all `dd` value boxes measured 87–318 px wide, none overflowed
its list box, and no page gained horizontal overflow at any of the three widths (§2.5).

**Regression test.** `tests/unit/detailListLayout.test.js` (new, 2 tests) asserts that:
1. no `.detail-list` two-column rule uses an **absolute** (non-zero) minimum track such as
   `minmax(10rem, …)`, that the label track is container-relative (`%`), and that the value track
   is `minmax(0, 1fr)`;
2. `.detail-list dd` retains `overflow-wrap: anywhere` so long tokens wrap inside the track.

The test was proven meaningful by temporarily restoring the old rule: it failed with
`pass 1 / fail 1`, and passed again (`pass 2 / fail 0`) once the fix was restored.

### 3.2 Admin data tables shredded names mid-word (presentation quality) — FIXED

**Symptom.** `.data-table` cells used `overflow-wrap: anywhere`. In the space column (as narrow
as 71 px) this broke words at arbitrary characters: `Acaci / a Train / ing Roo / m`. Emails and
organisation names were similarly fragmented.

**Fix.** Switch data-table cells to `overflow-wrap: break-word`, which still breaks unbreakable
tokens that would overflow but keeps a column at least one word wide. Tables now scroll inside
the already-focusable `.table-wrap` (`role="region"`, `tabindex="0"`) — the behaviour that
container was designed for — instead of squeezing columns below legibility.

**Verification.** At the 912 px QA viewport the space column went from 71 px to 112 px and names
now wrap at word boundaries; at 1440 px the spaces, reservations and audit tables fit exactly
(1042 px) and customer/inquiry tables scroll slightly. Page overflow remained 0 at all three
widths.

### 3.3 e2e availability check depended on the wall clock (reproducible test failure) — FIXED

**Symptom.** `npm run test:e2e` failed 62/63 with
`GET /api/public/availability -> 2xx … got 422`. The harness probed `Date.now() + 30 days` for a
two-hour window. Because that preserves the *current time of day*, the window ran outside
opening hours whenever the suite was run late in the Colombo afternoon. Running at 16:22 SLST
produced exactly that: `"Requested time 18:00 falls outside opening hours on 2026-11-17"`.

**The endpoint was correct** — it rejected an out-of-hours window with a precise, correctly
localised message. The **test** was wrong: it could only pass before ~16:00 SLST.

**Fix.** `scripts/e2e-verify.js` now builds a deterministic **10:00–12:00 SLST** window on a
future date via a documented `slstWindow()` helper. The intent (a valid future window returns
2xx) is unchanged; the result no longer depends on the hour of execution. There was exactly one
wall-clock-derived probe in the harness.

**Verification.** `npm run test:e2e` → **63 passed, 0 failed**, and the same request built the
old way was captured returning `422` at the same moment, confirming the diagnosis.

### 3.4 Bundled launcher scripts pointed at another machine (startup blocker) — FIXED

`tools/node.cmd`, `tools/npm.cmd` and `tools/git.cmd` each hardcoded a path under
`C:\Users\janut\…` belonging to the original author's workstation, so the wrappers referenced by
the harness documentation could not run anywhere else.

**Fix.** They now resolve their tool at call time:
- `tools\node.cmd` prefers `%NAGARO_NODE%` (an explicitly pinned `node.exe`), then `node` on
  `PATH`, and fails with an actionable message if neither provides Node ≥ 22.5 — instead of a
  confusing `ERR_UNKNOWN_BUILTIN_MODULE`.
- `tools\npm.cmd` puts the directory of `%NAGARO_NODE%` at the front of `PATH` before delegating
  to the real `npm`.
- `tools\git.cmd` prefers `%NAGARO_GIT%`, then `git` on `PATH`.

**Verification.** With only the system Node 20 on `PATH`, `tools\node.cmd --version` printed
*"Node 20.18.3 is too old; this project needs Node 22.5+ (node:sqlite)."* and exited 1. With
`NAGARO_NODE` set to the portable Node 24, it printed `v24.22.0`; `tools\npm.cmd --version`
printed `11.19.1`; `tools\git.cmd --version` printed `git version 2.55.0.windows.3`.

### 3.5 Presentation package built — ADDED

`PRESENTATION.md` (10-slide outline, speaker script, live-demo run-sheet, Q&A crib sheet) and
`presentation/slides.html` (an editable, self-contained browser deck: 10 slides, arrow-key and
click navigation, deep links such as `#6`, and print-to-PDF via `Ctrl+P`). Both were verified
rendering with all 10 slides, all 10 screenshots loading, and working keyboard/deep-link
navigation.

### 3.6 Demo database reseeded (local data only)

The working copy of `data/nagaro.db` still held demo rows generated *before* the seed was
localised for Colombo — Ethiopian customer names and `+251` phone numbers — even though
`src/server/db/seed.js` itself had already been corrected. For a presentation set in Colombo
this was inconsistent, so the local database was regenerated from the current seed. The previous
file was backed up to `data/nagaro.db.bak-20261018-160605` (inside the gitignored `data/`).

Result: 5 published spaces, 5 customers, 7 reservations, 2 inquiries, 10 images; all customers
now Sri Lankan (`Hasini Perera`, `Dinesh Fernando`, …), all phones `+94`, all currency `LKR`, all
addresses `example.com` (fictional). No real customer data is present. Re-seeding is
**idempotent** — it skips an already-populated database and never deletes user rows.

---

## 4. What is verified vs. what is merely inspected

Being explicit, because the distinction matters:

| Claim | Status |
|---|---|
| Suites pass (292 tests) | **Executed** on this commit |
| Double-booking refusal under 6 real processes | **Executed** and observed |
| Twelve browser workflows (§2.3) | **Executed** in a real browser |
| Colombo timezone correctness incl. host-zone independence | **Executed** on the storage layer |
| 45 route × viewport combinations | **Measured** on real layout |
| Security headers, admin auth gates, error-page hygiene | **Observed** over HTTP |
| Production-mode boot | **Executed** locally |
| A11y score / Lighthouse run | **Not performed** — no Lighthouse in this environment; keyboard focus targets, `aria-label`s, skip link and focus-visible styling were inspected, not scored |
| Deployment | **Not performed** |
| Email delivery | **Not performed** (SMTP unconfigured) |

---

## 5. How to start the demo

```bat
cd C:\Users\USER\Downloads\T2t\Nagaro_Booking_System

:: A Node.js 22.5+ runtime is required. Either install Node 24, or point at one:
set NAGARO_NODE=C:\Users\USER\AppData\Local\Temp\opencode\node24\node-v24.22.0-win-x64\node.exe

tools\node.cmd --version          :: must print v22.5.0 or newer
tools\npm.cmd start               :: migrated + seeded demo database, then:
                                  ::   Ready at http://127.0.0.1:4173
```

Then open:

- Public site — <http://127.0.0.1:4173/>
- Staff console — <http://127.0.0.1:4173/admin> (`admin@nagaro.local` / `NagaroDemo2026`,
  documented demo credentials, development-only)

To start from an empty database instead:

```bat
tools\npm.cmd run migrate
tools\npm.cmd run seed -- --demo
```

To open the slide deck: open `presentation/slides.html` in any browser (no build step), or
present from `PRESENTATION.md`.

---

## 6. Deliverables produced in this pass

| Path | Contents | Committed? |
|---|---|---|
| `FINAL_READINESS_REPORT.md` | This report | yes |
| `PRESENTATION.md` | 10-slide outline, speaker notes, demo run-sheet, Q&A crib sheet | yes |
| `presentation/slides.html` | Editable, self-contained 10-slide browser deck | yes |
| `tests/unit/detailListLayout.test.js` | Regression tests for the `.detail-list` fix | yes |
| `src/web/public/styles.css` | Both layout fixes | yes |
| `scripts/e2e-verify.js` | Deterministic availability probe | yes |
| `tools/node.cmd`, `tools/npm.cmd`, `tools/git.cmd` | Portable launchers | yes |
| `.gitignore` | Excludes `artifacts/` | yes |
| `artifacts/presentation/screens/*.jpg` | **15 real** screenshots of the running app (native viewport) | **no — large binaries, kept local** |
| `artifacts/presentation/responsive/*.jpg` | **8 real** width-pinned renders: mobile 390, tablet 768, desktop 1440 | **no — large binaries, kept local** |
| `data/nagaro.db.bak-20261018-160605` | Backup of the pre-reseed demo database | **no — gitignored** |

Screenshot index (all real captures, none fabricated):

- `01–05` public: home, spaces directory, meeting-room detail, auditorium detail, booking request
- `06–15` admin: dashboard, reservations, reservation detail, calendar, spaces, maintenance,
  inquiries, customers, activity log, sign-in
- `16–19` mobile 390: home, space detail, booking request, admin dashboard
- `20–21` tablet 768: home, admin reservations
- `22–23` desktop 1440: home, admin calendar

---

## 7. Limitations and known issues (honest boundary)

### 7.1 Screenshot viewport constraint
The available browser tooling renders into a fixed 912×670 pane and exposes no device
emulation; `window.resizeTo` has no effect on it. Exact 1440/768/390 **native** screenshots are
therefore impossible in this environment. This was worked around by rendering each route inside a
width-pinned document at the true target width (real CSS layout, real measurements) and capturing
that, which is what §2.5 and the `responsive/` images use. The `screens/` images are native
captures at 912×670. No screenshot in this package was resized, retouched, or synthesised.

### 7.2 Deployment — not performed, and not attempted
There is **no `vercel.json`, no `api/` entry point and no serverless handler**: `src/server/index.js`
is a long-running `node:http` server that listens on a port, and it persists to a local SQLite
file plus a local uploads directory. Serverless hosts provide an ephemeral, mostly read-only
filesystem, so bookings written there would not survive. The repository already contains the
*intended* path — `db/migrations-postgres/0001_init.sql` (Supabase-targeted) and a
`@vercel/blob` adapter in `src/server/security/blobStorage.js` that activates only when
`BLOB_READ_WRITE_TOKEN` is set — but the runtime is **not** wired to either. `pg` is declared as a
dependency but is not imported by any runtime module.

Classification: **locally demo-ready only**. No deployment was performed, so no
production-readiness claim is made.

### 7.3 Email
SMTP is unconfigured in this environment and the boot log says so honestly:
`email status: NOT configured`. Booking requests are still saved, and the admin queue flags them
as *"notifications not delivered"* rather than pretending delivery succeeded. **No email was sent
during verification**, and no live SMTP behaviour is claimed.

### 7.4 Accessibility
Keyboard focusability of scrollable regions, the skip link, `aria-label`s, `aria-current`, focus
visible styling and label/input association were **inspected in the markup** and behave as
expected in the browser pass. No automated accessibility audit (axe/Lighthouse) was run, and no
score is claimed.

### 7.5 Minor, non-blocking observations (left as-is)
- The boot log prints
  `[admin-ops] another route module already registers POST /admin/maintenance … adminOpsRoutes will not duplicate them`.
  The duplicate registration is intentionally tolerated and the maintenance workflow behaves
  correctly (verified in §2.3 steps 10–11), but the warning is noisy.
- Admin tables scroll horizontally at narrow-to-medium widths. This is intended (the wrappers are
  focusable regions for exactly this case) and the demo should be presented at ≥ 1280 px.
- The console em-dash in one boot-log line renders as mojibake under the Windows legacy code
  page. It is a console encoding artefact only; nothing user-facing is affected.

---

## 8. Push status

- Remote: `https://github.com/januththedev/Nagaro_Booking_System`
- `refs/heads/main` on the remote was confirmed to equal the local baseline
  `4a0e562b5c9f49536c63e0e292e2c86a629ba472` via `git ls-remote` before this pass, i.e. the
  earlier push failure was already resolved and no history needed rewriting.
- History was **not** rewritten: no reset, no force-push, no amended baseline commit. The
  baseline commit is preserved unchanged.
- This pass's changes are committed on top of the baseline and pushed to `main`. The exact hash
  is reported in the handover message and is the output of
  `git log -1 --format=%H` (the commit that adds this file).

---

## 9. Reproduce this report from a clean checkout

```bat
git checkout <final-commit>
set NAGARO_NODE=<path to node.exe ≥ 22.5>
tools\npm.cmd install
tools\npm.cmd run migrate
tools\npm.cmd run seed -- --demo
tools\npm.cmd test                  :: expect 192 passed, 0 failed
tools\npm.cmd run test:concurrency  :: expect  37 passed, 0 failed
tools\npm.cmd run test:e2e          :: expect  63 passed, 0 failed
tools\npm.cmd run demo:double-booking :: expect 1 confirmed / 5 refused
tools\npm.cmd start                 :: then open http://127.0.0.1:4173
```
