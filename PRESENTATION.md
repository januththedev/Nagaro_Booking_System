# Nagaro Space Booking System — Presentation Pack

Two artefacts live here:

| Artefact | Purpose |
|---|---|
| `PRESENTATION.md` (this file) | The complete slide-by-slide outline, speaker script and live-demo run-sheet. Transfer straight into PowerPoint / Google Slides / Keynote. |
| `presentation/slides.html` | An editable, self-contained HTML deck covering the same 10 slides. Open it in a browser, use `←`/`→`, and print to PDF if you need a handout. |

Screenshots referenced below are real captures of the running application, taken during
this verification pass and stored locally in `artifacts/presentation/` (deliberately **not**
committed — see `.gitignore`).

---

## Pre-flight checklist (do this 10 minutes before presenting)

1. Open a terminal in the project root.
2. Make sure a **Node.js 22.5+** runtime is used. On the machine verified here, the system
   `node` is v20, so either install Node 24 or point the bundled wrapper at one:
   ```bat
   set NAGARO_NODE=C:\path\to\node24\node.exe
   tools\node.cmd --version      :: must print v22.5.0 or newer
   ```
3. Start the application and confirm it says **Ready at**:
   ```bat
   tools\npm.cmd start
   ```
4. Open <http://127.0.0.1:4173> and sign in to the console at
   <http://127.0.0.1:4173/admin> as `admin@nagaro.local` / `NagaroDemo2026`.
5. Keep these four browser tabs open:
   - Public home — `/`
   - Booking request — `/booking-request`
   - Admin dashboard — `/admin`
   - Admin calendar — `/admin/calendar`
6. Widen the window to at least 1280 px so the console tables fit without scrolling.
7. Optional but effective: run `tools\npm.cmd run demo:double-booking` in a spare terminal
   just before the talk. It prints a real six-process race proving double booking is refused.

If anything above fails, the fallback is the recorded screenshots in
`artifacts/presentation/screens/` — the talk still works without a live app.

---

## Slide 1 — Title

**On screen**

> **Nagaro Space Booking System**
> Space booking & rental management for TRACE Expert City, Colombo
> *Public discovery · Staff-verified confirmation · Zero double bookings*
> Presented by ‹your name› · ‹date›

**Visual:** `artifacts/presentation/screens/01-public-home.jpg` (top third only).

**Speaker notes**
> "Nagaro rents out rooms, an auditorium and co-working desks at TRACE Expert City in
> Maradana, Colombo. This is the system that replaces the spreadsheet they used before —
> it removes double bookings, stops inquiries falling through the cracks, and gives
> everybody one shared view of what is actually free."

---

## Slide 2 — The problem

**On screen**

- Bookings lived in a **shared spreadsheet** — no single source of truth
- Two staff could promise the **same room to two clients**; nobody could tell who was first
- Inquiries arrived by **phone, email and walk-in** and were tracked inconsistently
- **No reliable availability view** for the public, and no audit trail of what changed
- Buffers and turnaround time between sessions were **enforced by memory**

**Visual:** simple 3-icon row (spreadsheet → conflict → lost request). No invented statistics.

**Speaker notes**
> "The damage was structural, not personal. A spreadsheet can be edited by two people at
> once, it cannot enforce that a room is only booked once, and it cannot show a visitor
> what is free. Every one of those failures eventually turns into an angry client and a
> lost booking."

---

## Slide 3 — The proposed solution

**On screen**

- **Public site** — browse published spaces, check provisional availability, submit a
  booking *request*. No accounts, no payments.
- **Staff console** — the only place a booking becomes **confirmed**.
- **Defining property:** two overlapping confirmed reservations on the same single-capacity
  resource **can never both commit** — enforced by the database, not the UI.
- **One shared calendar** with maintenance blocks, buffers and an append-only audit log.

**Visual:** `03-public-space-meeting-room.jpg` beside `06-admin-dashboard.jpg`.

**Speaker notes**
> "The important design decision is the split: the public can *discover* and *request*;
> only a signed-in staff member can *confirm*. That keeps the human judgement the venue
> wants while moving every check that a human gets wrong — overlap, opening hours,
> buffers, maintenance — into the database where it cannot be forgotten."

---

## Slide 4 — User workflow (the visitor)

**On screen**

> Browse → Inspect availability → Submit request → Receive reference → Staff respond

- Category filters: meeting/training rooms · auditorium · co-working desks
- Each space shows capacity, amenities, LKR rate card and operating hours in **SLST**
- Availability check is explicitly **provisional**
- Submitting issues a reference such as `INQ-2026-00003` and **reserves nothing**

**Visual:** `02-public-spaces-directory.jpg` + `05-public-booking-request.jpg`.

**Speaker notes**
> "Notice the wording the visitor sees: *'this check does not hold the space'* and
> *'not a confirmed booking yet'*. The system never implies a reservation it has not
> made. If a request is made in error the visitor can withdraw it with a private link."

**Demonstrate:** open `/spaces`, filter to *Auditorium*, open the space, run a provisional
availability check, then submit a request and show the confirmation reference.

---

## Slide 5 — Administrator workflow (staff)

**On screen**

- **Spaces** — publish/archive, photographs, amenities, rate card, capacity
- **Inquiries** — review every request, see whether the notification email was delivered
- **Reservations** — create confirmed bookings, edit, cancel **with a mandatory reason**
- **Maintenance** — block a space or specific units; the block is real occupancy
- **Calendar** — hour-by-hour occupancy per space, per day
- **Customers** — one profile per client, visible only to staff
- **Activity log** — append-only, written inside the same transaction as the change

**Visual:** `06-admin-dashboard.jpg`, `11-admin-maintenance.jpg`, `14-admin-activity-log.jpg`.

**Speaker notes**
> "Everything a manager needs is in one console. Two things are worth pointing out: the
> maintenance block is stored as occupancy, so the *same* rule that stops double bookings
> also stops a booking landing on a maintenance window; and cancellations cannot be
> recorded without a reason, which is kept forever in the history."

**Demonstrate:** open an inquiry, create a confirmed reservation from it, then attempt to
create a second booking for an overlapping window and show the refusal.

---

## Slide 6 — Core rules

**On screen**

| Rule | How it is guaranteed |
|---|---|
| No double booking | `occupancy` triggers raise `DOUBLE_BOOKING_CONFLICT` inside a `BEGIN IMMEDIATE` transaction |
| Maintenance blocks availability | Blocks are written as occupancy rows, so they cannot collide with a booking |
| Turnaround buffer | Enforced server-side between adjacent bookings |
| Opening hours & same-day rule | Rejected before anything is written |
| Colombo time | All local maths pinned to `Asia/Colombo` (UTC+05:30, no DST); storage is UTC epoch-ms |
| Currency | LKR throughout |
| Cancellations | Reason required, recorded permanently, inventory released atomically |

**Visual:** `09-admin-calendar.jpg` (hourly occupancy with a booked block).

**Speaker notes**
> "This is the slide an engineer will probe, so here is the precise claim. Availability is
> re-checked while holding SQLite's write lock, and even if some future code path forgot to
> check, a database trigger still rejects the overlapping row. The multi-process test races
> six separate operating-system processes at the identical window — exactly one wins."

---

## Slide 7 — Interface demonstration

**On screen:** a 2×2 grid of real screenshots —
`01-public-home.jpg`, `03-public-space-meeting-room.jpg`,
`07-admin-reservations.jpg`, `09-admin-calendar.jpg`.

Optionally add the responsive column: `16-mobile-390-home.jpg`,
`20-tablet-768-home.jpg`, `22-desktop-1440-home.jpg`.

**Speaker notes**
> "These are not mock-ups; they are captures of the running system taken during this
> verification pass. The public pages are a small, fast, server-rendered site with no
> client framework; the console is a dense operations tool. Both are fully responsive —
> the same screens were measured at 1440, 768 and 390 pixels wide with no horizontal
> overflow on any page."

---

## Slide 8 — Technical architecture

**On screen**

- **Runtime:** Node.js 22.5+ (built-in `node:sqlite`), zero native modules, no build step
- **HTTP:** hand-rolled router on `node:http`; server-rendered HTML via a tagged-template
  primitive; one small vanilla-JS enhancement layer (no SPA, no bundler)
- **Data:** SQLite with `BEGIN IMMEDIATE`, foreign keys ON, partial unique indexes, and
  anti-overlap triggers as the concurrency guarantee
- **Security:** signed session cookies, CSRF tokens on every mutating form, parameterised
  SQL, strict CSP (`default-src 'self'`), rate limiting, inert media serving, hashed IPs
- **Email:** optional SMTP via nodemailer; when unconfigured it reports `NOT_CONFIGURED`
  honestly instead of pretending delivery happened

**Speaker notes**
> "The architecture is deliberately boring: one dependency tree you can read in a minute,
> no framework churn, and the one hard guarantee pushed down into the database where it
> cannot be bypassed. That is also why it runs anywhere in seconds."

---

## Slide 9 — Testing and verification

**On screen** — distinguish measured from inspected:

| Check | Result |
|---|---|
| `npm test` (unit + integration) | **192 passed, 0 failed** |
| `npm run test:concurrency` | **37 passed, 0 failed** |
| `npm run test:e2e` (real forms, CSRF, upload) | **63 passed, 0 failed** |
| Browser workflow pass (public request → confirm → overlap → cancel → maintenance) | **Passed** — see report §Workflows |
| Responsive sweep: 15 routes × 1440/768/390 | **0 overflow, 0 layout defects** |
| Time-zone independence (4 host time zones incl. UTC+14) | **Passed** |

**Speaker notes**
> "Everything on this slide was executed in this environment, not copied from an earlier
> report. Two claims are deliberately *not* here: there is no deploy claim and no live-email
> claim, because neither was performed. Where a workflow was verified by driving the real
> browser I say so; where it was verified by the HTTP acceptance harness I say that instead."

---

## Slide 10 — Limitations and next steps

**On screen**

- **Deployment: locally demo-ready only.** The runtime writes to a local SQLite file and a
  local uploads folder. There is no serverless entry point and no `vercel.json`, so it was
  **not** deployed anywhere.
- **Persistence for a real deployment** needs a network database. A PostgreSQL schema
  (`db/migrations-postgres/`) and a Vercel Blob adapter already exist, but the runtime is
  **not** wired to them yet.
- **Email** is optional; the demo runs with SMTP unconfigured (requests are still saved and
  clearly flagged as not notified).
- **Future:** swap SQLite for PostgreSQL behind the same service layer, add a scheduled
  retention job, and add staff notification digests.

**Speaker notes**
> "I want to be exact about the boundary. This is a reliable, fully working system you can
> demonstrate end to end on a laptop today. It is not production-deployed, and the reason
> is persistence: serverless hosts have ephemeral disks, so bookings would vanish. The
> migration path is already sketched in the repository; the remaining work is the async
> database adapter, not a redesign."

---

## Live demo run-sheet (5–6 minutes)

| # | Where | Do this | Say this |
|---|---|---|---|
| 1 | `/` | Scroll the home page | "Public discovery: five published spaces, three categories, real-time availability." |
| 2 | `/spaces` | Filter to *Meeting & training room* | "Filtering and the rate cards are driven by the same data the console uses." |
| 3 | Space detail | Enter a date/time, **Check availability** | "Provisional — it tells you it does not hold the space." |
| 4 | `/booking-request` | Submit a request; show `INQ-…` | "This is a request, not a booking. Nothing is reserved." |
| 5 | `/admin` | Sign in, show the dashboard | "Staff console: what needs attention right now." |
| 6 | `/admin/inquiries` | Open the new request → **Create reservation** | "A human converts it into a confirmed booking." |
| 7 | `/admin/reservations/new` | Try the **same window** again | **Refused:** "This period is already booked … Nothing was created." |
| 8 | Reservation detail | Cancel with a reason | "The reason is required and kept forever; the slot frees instantly." |
| 9 | `/admin/maintenance` | Block a space, then try to book it | "Maintenance is occupancy, so the booking rule already covers it." |
| 10 | `/admin/calendar` | Show hourly occupancy | "One shared, hour-by-hour view for the whole venue." |
| 11 | Terminal | `npm run demo:double-booking` | "Six real processes race the same slot. Exactly one wins." |

**Contingency:** if the app will not start, open
`artifacts/presentation/screens/` and walk the same eleven steps over the screenshots.

---

## Q&A crib sheet

- **"What if two admins confirm simultaneously?"** — The second one is rejected by the
  database trigger; the losing request gets a `DOUBLE_BOOKING_CONFLICT` error, not a silent
  overwrite. Demonstrated by `tests/concurrency/` and `npm run demo:double-booking`.
- **"Where is data stored?"** — A local SQLite file in the demo; UTC epoch-milliseconds for
  every timestamp, converted to `Asia/Colombo` only for display.
- **"Can visitors book themselves?"** — No, by design. The public flow only creates inquiries.
- **"Is it secure?"** — Sessions, CSRF on all mutations, parameterised SQL, strict CSP,
  rate limiting, upload validation, inert media with `default-src 'none'`, hashed IPs.
- **"Why not Postgres?"** — The schema and migration exist; the runtime adapter is the
  remaining work and is deliberately out of scope for a local demonstration.
