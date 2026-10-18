# Booking Rules — Nagaro Space Booking System

**Audience:** Nagaro operations staff at Trace Expert City, and developers maintaining this system.
**Status:** authoritative for business behaviour. Where this document and the code disagree, one of them is
a defect — report it rather than picking a winner silently.
**Companion documents:** `DATA_MODEL.md` (schema and concurrency mechanism),
`REQUIREMENT_TEST_MATRIX.md` (requirement IDs and test coverage), `API_CONTRACTS.md` (module contracts).

All rule identifiers in this document (`A1`–`A21`) are the assumption identifiers the orchestrator cites.
Requirement identifiers (`R-*`) are defined in `API_CONTRACTS.md` §9 and traced in `REQUIREMENT_TEST_MATRIX.md`.

---

## 1. Time, and the one interval rule everything else follows from

Every instant in this system is stored as an integer: **milliseconds since the Unix epoch, in UTC**.
Nothing is stored as a string date or a wall-clock time.

Humans work in **Sri Lanka Standard Time (SLST)**. The business time zone is pinned to
`Asia/Colombo` (UTC+05:30, no daylight saving, ever) in `src/server/domain/time.js`.
The clock and time zone of the server machine are never consulted for a business calculation.
When staff type `09:00`, the stored value is `03:30 UTC`.

### 1.1 Half-open intervals

Every booking, maintenance block and availability check uses a **half-open interval** `[start, end)`.

The start instant belongs to the interval. The end instant does not. Two intervals conflict **exactly**
when both of the following hold:

```
existing.start_at < requested.end_at
existing.end_at   > requested.start_at
```

This single predicate is the authority. It appears verbatim in the two `occupancy` triggers in
`src/server/db/migrations/0001_init.sql`, in `findConflicts()` and in `inspectUnits()`
(`src/server/services/availabilityService.js`), and as `intervalsOverlap()` in
`src/server/domain/time.js`.

**Worked example — the 11:00 boundary.**

| Booking | Interval |
|---|---|
| A | 09:00–11:00 |
| B | 11:00–13:00 |

Apply the predicate to A as "existing" and B as "requested":

- `A.start (09:00) < B.end (13:00)` → true
- `A.end (11:00) > B.start (11:00)` → **false**

One condition fails, so the intervals do **not** conflict. B is accepted and A is untouched.
Back-to-back bookings are normal and expected: they are how a room is used all day.

Now replace B with 10:59–13:00:

- `09:00 < 13:00` → true
- `11:00 > 10:59` → true

Both hold, so this **does** conflict: B is rejected with `DOUBLE_BOOKING_CONFLICT`.
A single minute of overlap is a real overlap.

The same rule makes "ends at 13:00, next starts at 13:00" valid, "ends at 13:00, next starts at 12:59"
invalid, and "ends at 18:00 (closing time), next starts at 18:00" valid.

---

## 2. Which reservation statuses consume inventory, and why

Inventory is claimed by rows in the `occupancy` table, one row per
**(resource unit, interval)**. A row with `status = 'ACTIVE'` consumes its unit for its interval.
A row with `status = 'RELEASED'` consumes nothing but is kept forever, so the history of a space
shows what was held and when it was given back.

| Reservation status | Occupancy rows | Rationale |
|---|---|---|
| `CONFIRMED` | `ACTIVE` | The booking is a promise. The space cannot be given to anyone else. |
| `COMPLETED` | `ACTIVE` — **kept** | The booking already happened in the past. Keeping the rows makes the historical record truthful and makes "what did this room look like last month?" answerable. Since the interval is in the past it can never block a future booking. |
| `CANCELLED` | `RELEASED` | The promise was withdrawn. The unit is free again for anyone, and the released rows preserve the audit trail. |
| Public inquiry | **no rows at all** | An inquiry is a question, not a claim. See §8. |
| Maintenance block | `ACTIVE` (source `MAINTENANCE`) | Maintenance is not a reservation, but it does take the unit out of service. |

Cancellation is the only status change that frees inventory. It is performed as a single
transactional statement, `UPDATE reservation SET status = 'CANCELLED' ... WHERE id = ? AND status = 'CONFIRMED'`,
followed by `UPDATE occupancy SET status = 'RELEASED'`. If the first `UPDATE` changes zero rows, the
operation is rejected — so a repeated cancel cannot release the same inventory twice
(`src/server/services/bookingService.js`, `cancelReservation`).

**Nobody can cancel a `COMPLETED` reservation.** See assumption A6.

---

## 3. Opening hours (Sri Lanka Standard Time)

Each space declares `open_time` and `close_time` as `HH:MM` **local SLST** clock values
(stored as text, never as epochs). The default is **08:00–18:00**.

A requested booking window must fall inside opening hours:

- The space must be open at the start instant.
- The space must still be open at the end instant.
- `close_time` must be strictly later than `open_time`.
- A booking that ends exactly at `close_time` is allowed (the half-open rule again: the space is in
  service up to, but not including, the close instant).

A window that falls outside these hours is rejected with a message naming the offending date and clock
time, for example:

> This space is available 08:00-18:00 (Sri Lanka Standard Time). Requested time 18:00 falls outside opening hours on 2026-11-10.

Because the message tells staff the space's own hours, an operations manager should read it as
"this request is outside what the space is configured for", not necessarily as a policy refusal —
if the space is genuinely staffed later, change the space's opening hours.

`checkBookingRules()` in `src/server/services/availabilityService.js` is the single implementation of
this rule; `assertBookingRules()` turns its findings into a validation error that routes surface.

**A single booking may not span a closing time.** A booking that starts on Tuesday and ends on Wednesday
is rejected today, even with generous opening hours. See defect **D-2** in §9 before promising a
weekly or monthly desk rental to a customer.

---

## 4. Buffers (turnaround time)

`space.buffer_minutes` is an integer number of minutes, default **0**, range 0–240.

A buffer is the changeover time the space needs between two *reservations* — cleaning, resetting chairs,
re-rigging a projector. It does **not** mean the space is closed, and it does not appear in the public
availability output as a separate blocked period.

How it works:

- `[start, end)` is the interval the customer actually occupies.
- The comparison window is **inflated symmetrically**: `[start − buffer, end + buffer)`.
- The inflated window is compared against **reservation-sourced** occupancy only.
- **Maintenance is compared exactly, with no inflation.** A buffer exists to separate two customers, so
  it must not enlarge a maintenance block, and it must not make a maintenance block look bigger than the
  period the technician actually needs.

Because the buffer is symmetric, two bookings behave identically: the *later* one is rejected because the
earlier one's inflated window reaches into it.

**Worked example with `buffer_minutes = 30`:**

| Booking | Interval |
|---|---|
| A (confirmed) | 09:00–11:00 |
| B (requested) | 11:15–12:00 |

B's comparison window is 10:45–12:30. A's comparison window is 08:30–11:30.
`A.start (08:30) < B.end (12:30)` → true; `A.end (11:30) > B.start (10:45)` → true. **B is rejected** —
fifteen minutes is not enough turnaround time. B must start at 11:30 or later.

**Where the buffer is actually enforced.** The buffer is applied by the *service layer* when it inspects
and allocates units. The database triggers enforce raw, unbuffered non-overlap. In other words, the
triggers guarantee "two ACTIVE occupancy rows never overlap"; the services additionally guarantee
"two reservations always keep `buffer_minutes` apart". This is deliberate: a buffer is a policy, and a
policy belongs in the service that knows the space. See `DATA_MODEL.md` §5.4 for the consequence.

---

## 5. Minimum and maximum duration

| Field | Default | Allowed range |
|---|---|---|
| `min_duration_minutes` | 60 | 15 – 43,200 (30 days), must be > 0 |
| `max_duration_minutes` | unset (no maximum) | 15 – 129,600 (90 days), must be > 0 |

Rules:

1. The end instant must be strictly after the start instant. A zero-length booking is impossible; the
   database refuses it with `CHECK (end_at > start_at)`.
2. Duration must be at least `min_duration_minutes`.
3. When a maximum is set, duration must not exceed it.
4. When both are set, the maximum must be greater than or equal to the minimum.
5. No booking window may exceed **400 days**; that cap is a safety limit, not a product rule.

Durations are measured in absolute elapsed minutes, so a booking across a clock change would be measured
correctly — though SLST has no clock changes.

---

## 6. Capacity, and how it interacts with attendee count

Capacity has two independent meanings in this system. Do not confuse them.

**(a) `space.capacity` is a headcount.** It is the number of people the space can hold. It does not
allocate anything. It is validated in two places: the space form requires a value of at least 1, and a
reservation's `attendees` must not exceed it when an attendee count is supplied.

- `attendees` may be left empty. When it is empty, no capacity check happens — a staff member may
  legitimately not know the headcount yet.
- When `attendees` is supplied, `attendees > space.capacity` is rejected:
  "Attendee count 25 exceeds this space's capacity of 10."

**(b) Inventory is the number of bookable resource units.** This is what actually prevents double
booking, and it is a completely different number:

| Category | Resource units | Booking granularity |
|---|---|---|
| `MEETING_ROOM` | exactly 1 `EXCLUSIVE` unit | one reservation at a time |
| `AUDITORIUM` | exactly 1 `EXCLUSIVE` unit | one reservation at a time |
| `COWORKING` | N `DESK` units, N = desk inventory | 1..N desks per reservation |

An auditorium that seats 300 still has exactly **one** bookable unit: it can host one event at a time.
Twenty co-working desks are twenty separate, independently bookable units, and a reservation may claim
between 1 and 20 of them.

A co-working space therefore has two numbers that must not be conflated: `capacity` (how many people the
floor is designed for) and the desk count (how many desks can be sold). They are usually close but are not
required to be equal.

---

## 7. Pooled desk allocation

When a co-working reservation asks for `unit_count` desks, specific desk rows are allocated — not an
anonymous counter. The rule is deterministic, so the same request today and tomorrow produces the same
answer, which is what makes the system auditable.

Ordering preference, applied in sequence:

1. **Desks this reservation already holds.** On an edit, the desks the booking already occupies are kept
   whenever they are still free. Moving a three-desk booking by one hour should not shuffle the booking
   onto different desks for no reason.
2. **Lowest current load.** A desk's load is the number of `ACTIVE` occupancy rows it has ever accumulated.
   The free desk with the fewest active rows wins. This spreads wear and usage evenly across the pool
   instead of hammering desk 01 forever.
3. **Desk code, ascending.** `DESK-01` before `DESK-02`. Ties are broken by a plain string comparison, so
   the result is reproducible and not dependent on row order returned by the database.

If fewer than `unit_count` desks are free, nothing is allocated at all: the whole reservation is rejected
with `DOUBLE_BOOKING_CONFLICT` and a message that distinguishes the two causes:

- *"This period is blocked for maintenance."* — when maintenance is the only blocker.
- *"This space is already booked for the requested period (NG-2026-00042)."* — naming the blocking
  reservation when there is exactly one bookable unit.
- *"Only 4 of 6 required desks are free for the requested period."* — a partial pool.

There is no partial fulfilment. A request for six desks either gets six desks or gets an error.

**Desk inventory changes never silently break a booking.** Reducing the desk count deactivates desks from
the *end* of the code ordering, and refuses if any desk it would deactivate still holds `ACTIVE` occupancy:

> Cannot remove 10 desks (DESK-11, …, DESK-20): they hold confirmed or upcoming occupancy.
> Cancel or move those reservations first.

Desks are deactivated, not deleted, so historical occupancy keeps pointing at a real desk row.

---

## 8. Pricing

A space declares one rate per pricing unit it supports. **Only units the category actually uses may be
configured** — `ALLOWED_PRICING_UNITS` in `src/server/domain/constants.js`:

| Category | Permitted pricing units |
|---|---|
| `MEETING_ROOM` | `HOUR`, `HALF_DAY`, `DAY` |
| `AUDITORIUM` | `HOUR`, `HALF_DAY`, `DAY` |
| `COWORKING` | `DAY`, `WEEK`, `MONTH` |

Rates are stored in **cents** (`space_rate.amount_cents`, integer, ≥ 0) with the currency on the space
(default `LKR`). Nothing in this system is stored as a floating-point amount of money.

### 8.1 Quantity derivation

The billing quantity is derived from the requested interval, never guessed:

| Unit | Quantity | Notes |
|---|---|---|
| `HOUR` | `max(1, ceil(duration_minutes / 60))` | Any part of an hour is a whole hour. |
| `HALF_DAY` | `max(1, ceil(duration_minutes / 240))` | A half day is **4 hours** (assumption A8). |
| `DAY` | number of distinct business-local calendar dates the interval touches | Counting the start date and the date containing (end − 1 ms). |
| `WEEK` | `max(1, ceil(day_span / 7))` | Seven *dates*, not 168 hours. |
| `MONTH` | `max(1, ceil(day_span / 30))` | Thirty *dates*, not a calendar month. |

The total is:

```
total_cents = rate_cents × billing_quantity × unit_count
```

where `unit_count` is the number of desks (always 1 for an exclusive room or auditorium).

The reservation **stores** `billing_unit`, `billing_quantity`, `rate_cents`, `total_cents` and `currency`.
Changing a space's rates later therefore **never** changes a historical booking's price. This is the
single most important pricing property in the system.

### 8.2 Worked example — `HOUR`

Rate: **LKR 1,500.00 per hour** (`rate_cents = 150000`).

| Request | Duration | Quantity | Arithmetic | Total |
|---|---|---|---|---|
| 09:00–10:00 | 60 min | 1 | `ceil(60/60)` = 1 | 1 × 150,000 = **LKR 1,500.00** |
| 09:00–10:01 | 61 min | 2 | `ceil(61/60)` = 2 | 2 × 150,000 = **LKR 3,000.00** |
| 09:00–11:30 | 150 min | 3 | `ceil(150/60)` = 3 | 3 × 150,000 = **LKR 4,500.00** |
| 09:00–13:00 | 240 min | 4 | `ceil(240/60)` = 4 | 4 × 150,000 = **LKR 6,000.00** |

One minute past the hour is a full extra hour. Staff who want a rounded total should agree the end time
up front rather than expecting the system to round down.

### 8.3 Worked example — `HALF_DAY`

Rate: **LKR 4,000.00 per half day** (`rate_cents = 400000`). A half day is 240 minutes.

| Request | Duration | Quantity | Arithmetic | Total |
|---|---|---|---|---|
| 09:00–13:00 | 240 min | 1 | `ceil(240/240)` = 1 | 1 × 400,000 = **LKR 4,000.00** |
| 09:00–13:01 | 241 min | 2 | `ceil(241/240)` = 2 | 2 × 400,000 = **LKR 8,000.00** |
| 09:00–17:00 | 480 min | 2 | `ceil(480/240)` = 2 | 2 × 400,000 = **LKR 8,000.00** |

Note the 241-minute case: a booking that runs one minute into the second half day is charged for
two half days. This is deliberate and predictable; the alternative (pro-rating) would make the same room
cost an arbitrary amount.

### 8.4 Worked example — `DAY`

Rate: **LKR 4,500.00 per day** (`rate_cents = 450000`).

| Request | Dates touched | Quantity | Arithmetic | Total |
|---|---|---|---|---|
| 09:00–17:00, one date | 1 | 1 | `span` = 1 | 1 × 450,000 = **LKR 4,500.00** |
| 09:00 Tue → 17:00 Wed | 2 | 2 | `span` = 2 | 2 × 450,000 = **LKR 9,000.00** |
| Three desks, 09:00–17:00 | 1 | 1 | 1 × 3 desks | 450,000 × 1 × 3 = **LKR 13,500.00** |

A day is a **calendar date in SLST**, not 24 hours. A booking from 09:00 to 17:00 on one date is one day,
which is the intended behaviour for a desk rented for the working day.

> **Careful:** a rental that starts at 09:00 on Monday and ends at 09:00 on the following Monday touches
> **eight** dates (the eight date headers Monday…Monday), so `DAY` would be 8 and `WEEK` would be 2.
> This is a genuine consequence of counting dates rather than hours. It is why WEEK and MONTH rentals
> should be quoted in whole dates by staff, not in exact 168-hour or 720-hour blocks.

### 8.5 Worked example — `WEEK`

Rate: **LKR 8,000.00 per week** (`rate_cents = 800000`).

| Request | Dates touched | Quantity | Arithmetic | Total |
|---|---|---|---|---|
| 09:00 Tue → 17:00 the following Monday | 7 | 1 | `ceil(7/7)` = 1 | 1 × 800,000 = **LKR 8,000.00** |
| 09:00 Tue → 09:00 eight days later | 8 | 2 | `ceil(8/7)` = 2 | 2 × 800,000 = **LKR 16,000.00** |
| 09:00 on the 1st → 17:00 on the 29th | 29 | 5 | `ceil(29/7)` = 5 | 5 × 800,000 = **LKR 40,000.00** |

### 8.6 Worked example — `MONTH`

Rate: **LKR 25,000.00 per month** (`rate_cents = 2500000`). A "month" here is **30 dates**.

| Request | Dates touched | Quantity | Arithmetic | Total |
|---|---|---|---|---|
| 1 Nov 00:00 → 30 Nov 00:00 | 30 | 1 | `ceil(30/30)` = 1 | 1 × 2,500,000 = **LKR 25,000.00** |
| 1 Nov 00:00 → 1 Dec 00:00 | 30 | 1 | `ceil(30/30)` = 1 | 1 × 2,500,000 = **LKR 25,000.00** |
| 1 Nov 00:00 → 2 Dec 00:00 | 31 | 2 | `ceil(31/30)` = 2 | 2 × 2,500,000 = **LKR 50,000.00** |
| 1 Nov 00:00 → 31 Dec 00:00 | 60 | 2 | `ceil(60/30)` = 2 | 2 × 2,500,000 = **LKR 50,000.00** |

A real calendar month (November, 30 dates) is exactly one month-unit. December (31 dates) from the 1st to
the 31st is 31 dates and therefore **two** month-units. If Nagaro wants "one calendar month = one month
charge, always", that is a policy change and must be recorded here and in the pricing tests together.

### 8.7 Manual override

Staff may override `billing_quantity` on a reservation (a negotiated price, a goodwill discount, a
rounded total). The override is stored on the reservation, appears in the reservation's history, and is
attributed to the admin user who made it. No override is computed silently: the derived quantity is what
applies unless someone explicitly supplies a different one.

Changing a space's rate later does not touch existing reservations. To reprice an existing booking, edit
that reservation explicitly; the audit log records the before/after totals.

---

## 9. Inquiries — what an inquiry does *not* do

The public `/booking-request` form writes a row to the `inquiry` table. An inquiry is a **message from a
visitor asking Nagaro to book a space**. It is not a booking and it is not a hold.

An inquiry **does not**:

1. **Consume inventory.** No `occupancy` row is created, ever. Ten visitors may ask for the same room at
   the same hour, and all ten inquiries will be stored. Nothing is reserved.
2. **Confirm anything.** The visitor is told the request has been received and that availability is
   provisional. No wording anywhere may imply that a space is booked.
3. **Reserve a price.** The price is quoted when staff create the reservation, from the rates in force at
   that moment.
4. **Provisionally block other inquiries.** Two visitors asking for the same slot will both be told the
   slot appears free, if it appears free.
5. **Guarantee that email was delivered.** When `SMTP_*` variables are absent, `email_status` is recorded
   honestly as `NOT_CONFIGURED` and the visitor is told the request was received but that notification is
   still pending configuration. The system never reports a saved database row as a delivered email.
6. **Imply that a competing booking will be refused.** The slot is genuinely open for anyone.

What an inquiry **does** do:

- Generates a unique reference of the form `INQ-2026-00001`, allocated from `app_sequence` inside a write
  transaction.
- Records the requested window, attendee count or desk quantity, contact details, and the message.
- Normalises the email address for duplicate detection and rate limiting.
- Issues a **withdrawal token**: the visitor can withdraw their own inquiry from a link containing the
  reference and the token. Only the SHA-256 hash of the token is stored, so the database cannot be used to
  forge a withdrawal link.
- Moves through `NEW → CONTACTED → CONVERTED | CLOSED | WITHDRAWN`.
- Records who received it, who contacted whom, and, on conversion, the id of the reservation that was
  created from it (`converted_reservation_id`).

An inquiry never becomes a reservation automatically. Staff read the inquiry queue, contact the visitor,
and create the reservation by hand — at which point the ordinary booking rules in §1–§8 apply, including
the double-booking check.

---

## 10. Audit and retention

- Every state change writes an `audit_log` row **inside the same transaction** as the change it
  describes. A rolled-back change leaves no audit entry; a committed change always has one.
- A cancellation records the acting admin user, the timestamp, and the reason text. The reason is
  mandatory and must contain visible characters. `"   "` is rejected.
- Cancelled reservations are **never deleted**. The row keeps its reference, its window, its price and its
  cancellation reason.
- Released occupancy rows are **never deleted** either. They are the evidence of what was held and when it
  was released.
- No deletion operation for a customer, a space or a reservation exists in the application.

---

## 11. Documented assumptions

**These are the assumptions this implementation makes because the business brief did not settle the
question.** They are numbered so they can be cited, challenged and changed. Each one is a decision that
*can* be reversed — but reversing it means changing the code, this document and the traceability matrix
together.

**A1 — Default opening hours are 08:00–18:00 SLST.** Every space is created with `open_time = '08:00'`
and `close_time = '18:00'`, and `close_time` must be strictly later than `open_time`. A space that is
genuinely staffed at other times must have its hours changed; the default is not a claim about Nagaro's
actual opening hours.

**A2 — Default buffer is 0 minutes.** Spaces are created with no turnaround time. The buffer is capped at
240 minutes by the form validator. A buffer applies only to reservations, never to maintenance.

**A3 — Default minimum duration is 60 minutes.** A space may be configured anywhere from 15 minutes to
30 days; there is no maximum duration unless one is set (up to 90 days).

**A4 — Bookings may start in the past.** The system does not reject a past-dated reservation and has no
lead-time rule. Staff are trusted not to create one. A booking whose end has already passed becomes
`COMPLETED` the next time reconciliation runs, which may make a mistake look like a successful historical
booking — so a mistyped date must be cancelled rather than left to age.

**A5 — Inquiries have no lead time and no expiry.** An inquiry is never "too old" to act on and never
"too soon" to submit. It is a message, not a hold, so neither rule is needed.

**A6 — An administrator may cancel a `CONFIRMED` reservation only.** `COMPLETED` and `CANCELLED`
reservations cannot be cancelled; the attempt is rejected with a conflict error naming why.
An erroneous completed booking is corrected by creating a new reservation, never by rewriting history.
No role in the system can cancel a `COMPLETED` reservation.

**A7 — A maintenance block on a co-working space blocks the whole active desk pool by default.** Staff who
need to take out a single desk may name specific desks instead, in which case only those desks are
blocked. The default is deliberately conservative: a technician on the floor is treated as an obstruction
to the whole floor until someone says otherwise.

**A8 — `HALF_DAY` means 4 hours (240 minutes).** Quantities are `ceil(duration ÷ 4h)`, minimum 1. There is
no separate configuration for half-day length.

**A9 — Prices are binding records of the agreed price, and are advisory at the point of quote.** Once
saved on a reservation, `rate_cents`, `billing_quantity` and `total_cents` are historical facts that later
rate changes never alter. Before a reservation exists, a price is a quotation staff may override
(§8.7). There is no payment processing, invoicing, deposit or tax handling anywhere in this system.

**A10 — Public holidays are not modelled.** No holiday calendar is stored and no date is treated
specially. If a space is unavailable on a public holiday, staff create a maintenance block for it. This
keeps pricing arithmetic independent of a Sri Lankan public-holiday calendar that changes from year to year.

**A11 — `attendees` is optional, and the capacity check only runs when it is supplied.** An empty
attendee count is not an error. A supplied count greater than `space.capacity` is an error.

**A12 — A booking's end must be strictly after its start, satisfies the space's minimum duration, and
respects the maximum when one is configured.** A zero-length or inverted booking is a validation error,
not a database error.

**A13 — A booking must lie entirely within one business day's opening hours.** *This is what the code
does today, and it is flagged as defect D-2 because it contradicts the documented intent and the
availability of weekly/monthly pricing units.* Until D-2 is fixed, no overnight booking and no multi-day
booking can be created, so `DAY`-quantity-greater-than-1, `WEEK` and `MONTH` rentals are not reachable
through the booking service even though the pricing arithmetic for them is complete and tested.

**A14 — Desk allocation is deterministic:** desks already held by the reservation first, then fewest
accumulated `ACTIVE` occupancy rows, then desk code ascending. Two identical requests produce identical
allocations.

**A15 — Cancelled reservations and released occupancy rows are retained permanently.** There is no purge
job, no archive table and no deletion endpoint for them.

**A16 — Reconciliation is the only thing that marks a reservation `COMPLETED`**, and nothing in the
repository currently schedules it. It must be invoked (by a cron entry, an operations script, or a call at
process start) before "completed" means anything in a report. Until then, past `CONFIRMED` bookings remain
`CONFIRMED` and still count as consuming inventory — harmless for future availability, but visible on the
dashboard.

**A17 — Space deletion is not a supported operation.** No route or service function deletes a space, and
the schema's `ON DELETE RESTRICT` on `reservation.space_id` makes a space with bookings undeletable even
if such a route existed. Spaces are archived.

**A18 — Inventory is consumed by exactly the `CONFIRMED` and `COMPLETED` statuses.** `CONSUMING_RESERVATION_STATUSES`
in `src/server/domain/constants.js` is the single declaration of this list.

**A19 — The business time zone is `Asia/Colombo`, fixed at UTC+05:30 with no daylight saving**, and
the server's own clock and time zone are never used for a business calculation. All display formatting,
date arithmetic, opening-hours checks and pricing span calculations go through
`src/server/domain/time.js`.

**A20 — The buffer is a service-layer policy, not a database invariant.** The `occupancy` triggers enforce
raw non-overlap only. Two reservations may legally keep less than `buffer_minutes` between them if a future
write path bypasses `allocateUnits()`. Any new write path must call the availability service.

**A21 — Email delivery status is reported honestly and never inferred.** A successful database write is
never described as a delivered email. When SMTP is unconfigured, `email_status` is `NOT_CONFIGURED` and the
visitor is told notification is pending configuration.

---

## 12. Open defects found while writing this document

These are recorded here because an operations manager reading §3, §5 or §8 would otherwise be misled.
Full evidence is in the hand-off report.

| ID | Where | Symptom | Impact |
|---|---|---|---|
| **D-2** | `checkBookingRules()` — `src/server/services/availabilityService.js:433-454` | Any interval crossing a `close_time` is rejected, including overnight and multi-day windows, even with 24-hour opening hours. The loop advances `cursor` to the same day's `dayClose`, then re-examines that day and fails. The code comment directly above claims it handles multi-day rentals. | Co-working `WEEK`/`MONTH` rentals and any overnight booking cannot be created. `DAY` quantity is always 1 in practice. |
| **D-1** | `createMaintenanceBlock()` — `src/server/services/bookingService.js:630-641` | The `INSERT INTO occupancy` statement lists 9 columns but supplies only 7 placeholders, binding `source` to `NULL` (which the `NOT NULL` constraint forbids) while `run()` passes 8 arguments. Every call fails with `ERR_SQLITE_ERROR: column index out of range`. | Maintenance blocks cannot be created at all, so planned unavailability cannot be recorded through the service. |

Neither defect affects the double-booking guarantee: in both cases the operation fails outright rather
than committing something wrong.
