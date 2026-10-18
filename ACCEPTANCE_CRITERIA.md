# Acceptance Criteria — Nagaro Space Booking System

**System:** Nagaro Space Booking and Rental Management System for **TRACE Expert City**, Colombo, Sri Lanka.
**Repository:** `https://github.com/januththedev/Nagaro_Booking_System` (branch `main`, commit `a32f0f2444465efa42f2357a86077248fef8d50c`).
**Companion documents:** `USER_STORIES.md` (the stories these criteria defend),
`USER_STORY_TRACEABILITY.md` (implementation + test mapping),
`REQUIREMENT_TEST_MATRIX.md` (older `R-*` requirement IDs).

---

## How to use this document

Every criterion has a stable ID `AC-nn.m`, where `nn` is the story it belongs to.
Each is written to be **independently testable**: it names a precondition, an
action and an observable outcome. A criterion that cannot be judged passed or
failed by reading its own text and running the named test is written badly.

Status is recorded **once**, in `USER_STORY_TRACEABILITY.md`, not here — so this
file can stay a statement of *intended behaviour* while the traceability matrix
records *what actually exists and was verified*.

Conventions used below:

- **SLST** = Sri Lanka Standard Time = `Asia/Colombo` = UTC+05:30, no DST.
- **LKR** = Sri Lankan Rupee; money is stored as an integer number of cents.
- **Business day** = the calendar day in SLST.
- **Half-open** interval `[start, end)` = `start` included, `end` excluded; two
  intervals conflict exactly when `aStart < bEnd AND aEnd > bStart`.
- **Confirmed reservation** = a `reservation` row with status `CONFIRMED`
  (or `COMPLETED`) carrying `ACTIVE` occupancy on a resource unit.

---

## Epic 1 — Space discovery

### US-01 — Browse the published space directory

**AC-01.1 — Published spaces are listed**
Given the venue has at least one space with status `PUBLISHED`,
When a visitor requests `GET /spaces`,
Then the response is `200` and lists every published space.

**AC-01.2 — Each listing shows the deciding facts**
Given a published space appears in the directory,
When the listing is rendered,
Then it shows its name, category, capacity and a price summary in LKR.

**AC-01.3 — Directory is public**
Given no session cookie is present,
When a visitor requests `GET /spaces`,
Then the response is `200` and no sign-in is required.

### US-02 — Filter and sort the directory

**AC-02.1 — Filter by category**
Given the directory contains spaces of more than one category,
When the visitor requests `GET /spaces?category=AUDITORIUM`,
Then only auditorium spaces are listed.

**AC-02.2 — Filter by capacity, amenities and billing unit**
Given `min_capacity`, `amenity` and `pricing_unit` query parameters are supplied,
When the directory is rendered,
Then a space is listed only if it meets **every** supplied constraint.

**AC-02.3 — Sort deterministically**
Given `sort=name|capacity|price` is supplied,
When the directory is rendered,
Then the spaces are ordered by that key, with ties broken by name.

### US-03 — View a space's detail page

**AC-03.1 — Published space detail is reachable**
Given a space is `PUBLISHED`,
When the visitor requests `GET /spaces/:code`,
Then the response is `200` and shows that space.

**AC-03.2 — Detail exposes the operational facts**
Given the detail page is rendered,
Then it shows capacity, amenities, opening hours in SLST, the LKR rate card and
the space's photographs.

**AC-03.3 — Detail exposes no personal data**
Given the space has upcoming bookings,
When the detail page is rendered,
Then the HTML contains no customer name, no reservation reference and no
internal note.

### US-04 — Published-only visibility

**AC-04.1 — Non-published spaces are not listed**
Given a space has status `DRAFT` or `ARCHIVED`,
When any public listing is rendered,
Then that space does not appear.

**AC-04.2 — Unknown or unpublished code is a 404**
Given a space code is unknown, `DRAFT` or `ARCHIVED`,
When the visitor requests `GET /spaces/:code`,
Then the response is `404` and does not disclose whether the code exists.

---

## Epic 2 — Booking requests and inquiries

### US-05 — Submit a booking request

**AC-05.1 — Valid request is accepted**
Given all required fields are present and valid,
When the customer submits the booking-request form,
Then the system saves one `inquiry` row and responds with a successful
submission result.

**AC-05.2 — A request reserves nothing**
Given a request has just been saved,
When the space's occupancy is inspected,
Then no `occupancy` row exists for it and the space's availability is unchanged.

**AC-05.3 — Invalid request is rejected**
Given required information is missing or invalid,
When the customer submits the form,
Then the system rejects the submission with field-level feedback and writes no
`inquiry` row.

**AC-05.4 — Persistence failure is not reported as success**
Given the `inquiry` row cannot be written,
When the customer submits the form,
Then the system does not display a successful submission result.

### US-06 — A request is not a confirmation

**AC-06.1 — A reference is issued**
Given a valid request is saved,
Then it is assigned a unique reference of the form `INQ-YYYY-NNNNN`.

**AC-06.2 — The visitor is told it is not confirmed**
Given a request has been saved,
When the confirmation page is shown,
Then it states that the request is a request, not a confirmed booking, and that
it does not hold the space.

**AC-06.3 — Only staff can confirm**
Given a request exists,
When no administrator acts on it,
Then no `CONFIRMED` reservation exists for it.

### US-07 — Per-field validation feedback

**AC-07.1 — Errors identify the field**
Given one or more submitted values are invalid,
When the form is re-rendered,
Then each offending field is named with a human-readable reason.

**AC-07.2 — No partial write**
Given a submission fails validation,
When the request completes,
Then the `inquiry` table row count is unchanged.

### US-08 — Inquiry is durable across email failure

**AC-08.1 — Commit before send**
Given a valid submission,
When the email step is attempted,
Then the `inquiry` row is already committed before any socket is opened.

**AC-08.2 — Email failure keeps the inquiry**
Given the mail transport throws,
When the submission completes,
Then the inquiry row still exists and its `email_status` is `FAILED`.

**AC-08.3 — Crash between commit and write-back leaves PENDING**
Given the process dies after the commit but before the delivery write-back,
Then the inquiry exists with `email_status = 'PENDING'`, never deleted.

### US-09 — Withdraw an inquiry

**AC-09.1 — Correct token withdraws**
Given the customer holds the withdraw token issued with the reference,
When the customer submits the withdraw form,
Then the inquiry status becomes `WITHDRAWN`.

**AC-09.2 — Wrong token is refused**
Given a token that does not match the inquiry,
When withdrawal is attempted,
Then the request is refused and the status is unchanged.

**AC-09.3 — Withdrawal is idempotent and final**
Given an inquiry is already `WITHDRAWN`,
When withdrawal is attempted again,
Then it is accepted without error and the inquiry cannot be reopened.

### US-10 — Review the inquiry queue

**AC-10.1 — Queue lists inquiries**
Given at least one inquiry exists,
When an administrator requests `GET /admin/inquiries`,
Then the queue lists it with its reference and status.

**AC-10.2 — Delivery state is visible**
Given an inquiry's email was not delivered,
When it is shown in the queue,
Then its delivery state is displayed as a distinct, human-readable value.

**AC-10.3 — Queue can be filtered**
Given `status`, `space` and `emailStatus` query parameters are supplied,
When the queue is rendered,
Then only matching inquiries are listed.

**AC-10.4 — Counts are not invented**
Given an inquiry count is displayed,
Then it is derived from the data actually scanned and the interface states any
bound on that scan.

### US-11 — Convert an inquiry into a reservation

**AC-11.1 — Pre-fill**
Given an inquiry exists,
When the administrator opens `GET /admin/reservations/new?inquiry=<id>`,
Then the form is pre-filled with that inquiry's space, requested window, desk
count and customer details.

**AC-11.2 — Conversion links the reservation**
Given an inquiry is converted,
When conversion completes,
Then the inquiry's `converted_reservation_id` references the new reservation and
its status becomes `CONVERTED`.

**AC-11.3 — `CONVERTED` requires a link**
Given an inquiry has no linked reservation,
When any caller attempts to set its status to `CONVERTED`,
Then the transition is refused with an explicit message.

---

## Epic 3 — Administrator authentication and dashboard

### US-12 — Sign in

**AC-12.1 — Correct credentials create a session**
Given an active administrator account with a known password,
When the correct email and password are submitted to `POST /admin/login`,
Then a session cookie is set and the response redirects into the console.

**AC-12.2 — Wrong credentials are refused generically**
Given an unknown email or a wrong password,
When sign-in is attempted,
Then the response is a generic "email or password is incorrect" and no session
is created.

**AC-12.3 — Disabled accounts cannot sign in**
Given an account with `is_active <> 1`,
When the correct password is submitted,
Then sign-in is refused and the reason is "account disabled".

### US-13 — Block anonymous admin access

**AC-13.1 — HTML pages redirect**
Given no valid session,
When any `/admin/*` HTML page is requested,
Then the response is `303` to the sign-in page.

**AC-13.2 — API endpoints return 401**
Given no valid session,
When any `/api/admin/*` endpoint is requested,
Then the response is `401` with error code `UNAUTHORIZED` and no data.

### US-14 — Throttle and lock failed sign-ins

**AC-14.1 — Failed attempts are counted**
Given repeated wrong passwords for one account,
Then the account's `failed_logins` counter increases.

**AC-14.2 — Account lockout**
Given `failed_logins` reaches the configured maximum,
When another sign-in is attempted within the lockout window,
Then it is refused with a "too many failed attempts" message.

**AC-14.3 — Login rate limit**
Given repeated sign-in attempts from one IP or for one email within the window,
When the configured limit is exceeded,
Then the response is `429` (rate-limited), not another password check.

### US-15 — Sign out and manage own account

**AC-15.1 — Sign out revokes the session**
Given a signed-in administrator,
When `POST /admin/logout` is submitted with a valid CSRF token,
Then the session is revoked and subsequent admin requests require sign-in again.

**AC-15.2 — Password change requires the current password**
Given a signed-in administrator,
When a new password is submitted without the correct current password,
Then the change is refused and the password is unchanged.

**AC-15.3 — Other sessions are revoked**
Given an administrator successfully changes their own password,
Then the session performing the change stays valid and every other session for
that account is revoked.

### US-16 — Role-based authorization

**AC-16.1 — ADMIN-only actions**
Given a signed-in user whose role is `STAFF`,
When that user attempts an administrator-only action,
Then the response is `403 Forbidden` and nothing is written.

**AC-16.2 — Last administrator protection**
Given exactly one active `ADMIN` account,
When it is demoted or deactivated,
Then the action is refused.

**AC-16.3 — Guests cannot manage accounts**
Given no session,
When a user-management endpoint is called,
Then the response is `401` and no row is written.

### US-17 — Operational dashboard

**AC-17.1 — Live figures**
Given the console is loaded,
When the dashboard renders,
Then its counts match independently computed SQL counts for the same data.

**AC-17.2 — Honest zeroes**
Given an empty database,
When the dashboard renders,
Then it reports real zeroes rather than placeholder numbers.

**AC-17.3 — Summary endpoint agrees with the page**
Given `GET /api/admin/dashboard/summary`,
Then it returns the same read model used by the dashboard page, including an
`activeSpaces` figure.

---

## Epic 4 — Space and pricing management

### US-18 — Create a space

**AC-18.1 — Valid create writes one row**
Given a complete valid payload,
When `POST /admin/spaces` is submitted with a valid CSRF token,
Then exactly one `space` row is created and the response redirects to it.

**AC-18.2 — Invalid create writes nothing**
Given an invalid payload,
When the form is submitted,
Then the response is `422`, the form is re-rendered with field errors, and no
row is created.

**AC-18.3 — Duplicate code is refused**
Given another space already uses the requested code (case-insensitive),
When the form is submitted,
Then the request is refused with a conflict and no second row is created.

### US-19 — Edit a space

**AC-19.1 — Valid edit updates the row**
Given an existing space,
When a valid change is submitted to `POST /admin/spaces/:id`,
Then the row is updated and the change is visible on the detail page.

**AC-19.2 — Invalid edit is refused**
Given an invalid change,
When it is submitted,
Then the response is `422`, the form is re-rendered, and the stored row is
unchanged.

**AC-19.3 — Category cannot change under live occupancy**
Given the space has `ACTIVE` occupancy,
When its category is changed,
Then the change is refused.

### US-20 — Publication gate

**AC-20.1 — A photograph is required**
Given a space has no photograph,
When `POST /admin/spaces/:id/publish` is submitted,
Then publishing is refused, the reason names the missing photograph, and the
status remains `DRAFT`.

**AC-20.2 — Completeness is required**
Given the space lacks a description of at least 20 characters, a short summary,
a location, at least one rate, or at least one active unit,
When publishing is attempted,
Then it is refused and every unmet requirement is listed.

**AC-20.3 — Complete space publishes**
Given every publish requirement is met,
When publishing is attempted,
Then the status becomes `PUBLISHED` and `published_at` is stamped.

**AC-20.4 — Publishing is idempotent**
Given a space is already `PUBLISHED`,
When publishing is attempted again,
Then the operation succeeds without error and without changing `published_at`.

### US-21 — Photograph management

**AC-21.1 — Valid upload is stored and recorded**
Given an image of one of the permitted types (`image/jpeg`, `image/png`,
`image/webp`) no larger than the configured maximum,
When it is uploaded to `POST /admin/spaces/:id/images`,
Then the bytes are stored under a random 32-hex name and one `space_image` row
is recorded.

**AC-21.2 — Content is verified, not trusted**
Given a file whose declared type does not match its magic bytes (for example a
PHP payload named `.png`),
When it is uploaded,
Then it is rejected and nothing is stored.

**AC-21.3 — Cover, reorder and delete**
Given a space with photographs,
When a photograph is set as cover, the set is reordered, or one is deleted,
Then the corresponding `space_image` rows change and, if the cover is deleted,
another photograph becomes the cover.

**AC-21.4 — Caps are enforced**
Given the space already holds the maximum number of photographs,
When another is uploaded,
Then it is rejected as overflow and no row is added.

### US-22 — Category-correct LKR pricing

**AC-22.1 — Only allowed units are accepted**
Given the space's category allows a set of billing units,
When a rate is supplied in a unit that category does not allow,
Then `422` is returned, naming the rate field.

**AC-22.2 — Amounts are integer cents**
Given a rate is supplied,
Then it is stored as a non-negative integer number of cents in `space_rate`.

**AC-22.3 — Money is formatted in LKR**
Given a stored amount and currency `LKR`,
When it is displayed,
Then it is rendered with the LKR currency indicator and correct minor-unit
precision.

### US-23 — Co-working desk inventory

**AC-23.1 — Desk count creates units**
Given a co-working space,
When its desk count is set to N,
Then N active `DESK` resource units exist for that space.

**AC-23.2 — Desks with occupation cannot be removed**
Given a desk holds `ACTIVE` occupancy,
When the desk count is reduced below that desk's position,
Then the change is refused and the offending desks are named.

**AC-23.3 — Non-co-working spaces are refused**
Given a space whose category is not `COWORKING`,
When a desk count is supplied,
Then the change is refused with a field error.

### US-24 — Archive and restore

**AC-24.1 — Archive hides the space**
Given a space,
When `POST /admin/spaces/:id/archive` is submitted,
Then its status is `ARCHIVED`, `archived_at` is stamped, and it disappears from
the public directory.

**AC-24.2 — Upcoming occupancy is reported**
Given the space carries future `ACTIVE` occupancy,
When it is archived,
Then the operation completes and the number of upcoming occupancy rows is
reported to the operator.

**AC-24.3 — Restore returns to draft**
Given an archived space,
When `POST /admin/spaces/:id/restore` is submitted,
Then its status is `DRAFT` and `archived_at` is cleared.

---

## Epic 5 — Reservation management

### US-25 — Create a confirmed reservation

**AC-25.1 — Valid reservation is created**
Given a published space, a customer and a valid window,
When `POST /admin/reservations` is submitted with a valid CSRF token,
Then one `CONFIRMED` reservation is created and the response redirects to it.

**AC-25.2 — Inventory is allocated**
Given the reservation is created,
Then `ACTIVE` occupancy exists for exactly the resource units it needs.

**AC-25.3 — Missing prerequisites are refused**
Given no space or no customer is selected,
When the reservation is submitted,
Then the response is `422` naming the missing field and nothing is written.

**AC-25.4 — Overlap is refused**
Given the requested window overlaps existing active occupancy,
When the reservation is submitted,
Then it is refused with `DOUBLE_BOOKING_CONFLICT` and nothing is written.

### US-26 — Edit a reservation

**AC-26.1 — Valid edit moves the booking**
Given an existing confirmed reservation,
When a valid new window is submitted,
Then the reservation's window is updated and its occupancy is moved.

**AC-26.2 — Conflicting edit is refused atomically**
Given the new window overlaps other active occupancy,
When the edit is submitted,
Then the edit is refused and the original window and occupancy are unchanged.

**AC-26.3 — Cancelled reservations cannot be edited**
Given a reservation whose status is `CANCELLED`,
When an edit is attempted,
Then it is refused with an instruction to create a new reservation.

### US-27 — Cancel with a mandatory reason

**AC-27.1 — Reason required**
Given an empty or whitespace-only cancellation reason,
When cancellation is submitted,
Then the response is `422` and the reservation remains `CONFIRMED`.

**AC-27.2 — Cancellation releases inventory**
Given a valid reason,
When cancellation is submitted,
Then the reservation becomes `CANCELLED` and its `ACTIVE` occupancy is
released in the same transaction.

**AC-27.3 — The reason is retained**
Given a completed cancellation,
Then the reason is stored with the reservation and shown on its detail page.

**AC-27.4 — Double cancellation is refused**
Given a reservation already `CANCELLED`,
When cancellation is attempted again,
Then it is refused with a conflict.

### US-28 — Browse and filter reservations

**AC-28.1 — Reservations are listed**
Given reservations exist,
When an administrator requests `GET /admin/reservations`,
Then they are listed with reference, status, space and time window.

**AC-28.2 — Filters narrow the list**
Given status and/or space filters are supplied,
When the list is rendered,
Then only matching reservations are listed.

### US-29 — Customer records and duplicate detection

**AC-29.1 — Valid customer is created**
Given a valid unique email,
When `POST /admin/customers` is submitted,
Then one `customer` row is created.

**AC-29.2 — Duplicate email is surfaced, not merged**
Given the email already belongs to a customer,
When the form is submitted without an explicit override,
Then the response is `422` identifying the existing customer and no second row
is created.

**AC-29.3 — Override is explicit**
Given the same submission includes the explicit confirmation flag,
Then the second customer row is created.

**AC-29.4 — Duplicate detection never writes**
Given a search for potential duplicates,
Then the operation returns matches and modifies no rows.

### US-30 — Automatic completion of past reservations

**AC-30.1 — Past confirmed reservations become completed**
Given a `CONFIRMED` reservation whose end time has passed,
When reconciliation runs,
Then its status becomes `COMPLETED`.

**AC-30.2 — Future reservations are untouched**
Given a reservation whose end time has not yet passed,
When reconciliation runs,
Then its status is unchanged.

### US-31 — Calendar / day grid

**AC-31.1 — Calendar page loads**
Given a valid session,
When `GET /admin/calendar` is requested,
Then the response is `200` and renders the calendar.

**AC-31.2 — Events endpoint returns occupancy**
Given `GET /api/admin/calendar/events` for a date range,
Then it returns events for active occupancy within that range.

**AC-31.3 — The day grid is a documented shape**
Given a space and a business-local date,
When the day grid is produced,
Then it returns exactly the documented projection, including no occupancy
details on the public path.

---

## Epic 6 — Availability, maintenance and double-booking prevention

### US-32 — No double booking

**AC-32.1 — Concurrent identical requests yield one winner**
Given N concurrent processes request the same single-capacity space for the
same window,
When they run,
Then exactly one reservation is created and the others are refused.

**AC-32.2 — The database itself refuses the overlap**
Given the service-layer check is bypassed and an overlapping `ACTIVE` occupancy
row is inserted directly,
Then the `occupancy` trigger aborts the write.

**AC-32.3 — Mutations are serialised**
Given two booking mutations run concurrently,
Then each runs inside `BEGIN IMMEDIATE` and the loser receives a conflict error
rather than corrupting state.

**AC-32.4 — Failure leaves nothing behind**
Given a booking transaction fails after any statement,
When it rolls back,
Then no reservation, occupancy or partial allocation remains.

### US-33 — Half-open boundaries and buffers

**AC-33.1 — Adjacency is allowed**
Given one booking ends at 11:00,
When another starts at 11:00 on the same resource,
Then both succeed.

**AC-33.2 — One-minute overlap is refused**
Given one booking ends at 11:00,
When another starts at 10:59,
Then the second is refused.

**AC-33.3 — Buffer widens the request**
Given the space's `buffer_minutes` is 30,
When a booking starts 30 minutes after a previous end,
Then it is accepted, and a booking starting earlier is refused.

**AC-33.4 — Maintenance ignores the buffer**
Given maintenance occupancy and a booking, compared directly,
When they are adjacent,
Then no buffer is applied to the maintenance comparison.

### US-34 — Opening hours, duration and capacity

**AC-34.1 — Opening hours enforced in SLST**
Given a space open 08:00–18:00 SLST,
When a window outside those hours is requested,
Then it is refused with a message naming the SLST opening hours.

**AC-34.2 — Minimum duration enforced**
Given the space's minimum duration,
When a shorter window is requested,
Then it is refused.

**AC-34.3 — Maximum duration enforced when configured**
Given a configured maximum duration,
When a longer window is requested,
Then it is refused; when no maximum is configured, no maximum is applied.

**AC-34.4 — Capacity enforced**
Given an attendee count greater than the space's capacity,
When the booking is validated,
Then it is refused.

### US-35 — Create a maintenance block

**AC-35.1 — A reason is required**
Given an empty reason,
When a maintenance block is submitted,
Then it is refused with a field error.

**AC-35.2 — A block is written as occupancy**
Given a valid space, window and reason,
When the block is created,
Then `ACTIVE` occupancy with source `MAINTENANCE` is written for the target
units.

**AC-35.3 — A booking inside the block is refused**
Given an active maintenance block,
When a reservation overlapping it is attempted,
Then the reservation is refused with a conflict that names the block.

### US-36 — Cancel a maintenance block

**AC-36.1 — Cancelling releases occupancy**
Given an active maintenance block,
When it is cancelled,
Then its occupancy is released and the window becomes bookable.

**AC-36.2 — Double cancellation is refused**
Given an already-cancelled maintenance block,
When it is cancelled again,
Then the request is refused with a conflict.

**AC-36.3 — Unknown block is not found**
Given an id that does not exist,
When cancellation is attempted,
Then the response is not found and no row changes.

### US-37 — Maintenance occupies inventory

**AC-37.1 — Maintenance and bookings cannot overlap**
Given maintenance occupancy on a unit,
When a booking overlapping it is attempted,
Then the booking is refused.

**AC-37.2 — Maintenance competes at the database level**
Given a race between a booking and maintenance blocks for the same window,
When they run,
Then exactly one wins.

**AC-37.3 — Releasing maintenance frees the slot**
Given a maintenance block is cancelled,
When the same window is booked,
Then the booking succeeds.

### US-38 — Availability preview

**AC-38.1 — Public preview reports counts, not identities**
Given a public availability query,
Then the response contains counts and anonymous blocked periods, and never a
customer name or reservation reference.

**AC-38.2 — Availability label is honest**
Given a partially booked period,
Then the availability label reflects the real remaining capacity rather than
claiming full availability.

**AC-38.3 — Preview does not reserve**
Given an availability preview has been served,
When occupancy is inspected,
Then no occupancy row was created.

---

## Epic 7 — Timezone and currency handling

### US-39 — UTC storage, SLST display

**AC-39.1 — Instants are epoch milliseconds**
Given any stored instant,
Then it is an integer number of milliseconds since the Unix epoch in UTC, never
a local-time string.

**AC-39.2 — Business zone is Asia/Colombo**
Given the business time zone constant,
Then it is `Asia/Colombo` with a fixed UTC+05:30 offset and no DST.

**AC-39.3 — Local conversion round-trips**
Given a Colombo-local date and clock time,
When it is converted to an instant and back,
Then the original local date and time are recovered.

### US-40 — Host-zone independence

**AC-40.1 — Local maths does not use the host zone**
Given the host `TZ` is changed,
When business date and time values are computed,
Then they are identical across host zones.

**AC-40.2 — Business day boundaries are SLST**
Given a booking at 23:00 SLST,
Then it falls on that business day, not the following one.

**AC-40.3 — Dashboard refuses other zones**
Given dashboard calculations are asked to run under a zone other than
`Asia/Colombo`,
Then they refuse rather than silently producing different numbers.

### US-41 — LKR pricing

**AC-41.1 — Default currency is LKR**
Given a new space or reservation is created without an explicit currency,
Then its currency is `LKR`.

**AC-41.2 — Legacy currency is corrected**
Given a row stored as `ETB` before the locale correction,
When migrations run,
Then its currency becomes `LKR`.

**AC-41.3 — Amounts are integer minor units**
Given any monetary amount,
Then it is stored as an integer number of cents and no floating-point value is
persisted.

---

## Epic 8 — Notifications, auditing and security

### US-42 — Honest email delivery state

**AC-42.1 — Unconfigured SMTP is reported, not faked**
Given `SMTP_HOST` is not set,
When a notification is attempted,
Then no connection is opened and the status is `NOT_CONFIGURED`.

**AC-42.2 — Sent is recorded as sent**
Given a transport that accepts the message,
Then the status is `SENT` and the provider message id is recorded where
available.

**AC-42.3 — Failure never throws and never rolls back the inquiry**
Given a transport that throws,
When the notification is attempted,
Then the failure is recorded as `FAILED` with a secret-free message and the
inquiry remains stored.

**AC-42.4 — No secret leaks into a reported error**
Given a delivery error,
Then no SMTP password or URL credential appears in the recorded message.

### US-43 — Append-only audit

**AC-43.1 — Every mutation is audited**
Given any mutating service operation,
Then an `audit_log` row is written describing the actor, action, entity and a
human-readable summary.

**AC-43.2 — Audit is written in the same transaction**
Given a mutation rolls back,
Then its audit row is not present either.

**AC-43.3 — The log is viewable**
Given an administrator,
When `GET /admin/audit` is requested,
Then the log is rendered with newest entries first.

### US-44 — Public privacy

**AC-44.1 — No customer data on public endpoints**
Given any public endpoint,
Then no response contains a customer name, contact detail, reservation
reference or internal note.

**AC-44.2 — Public projections are allow-listed**
Given a public space projection,
Then it contains exactly the documented keys and no others, and forbidden
attribute keys are scrubbed.

**AC-44.3 — References are not leaked**
Given a public response body,
Then it matches no reservation reference pattern.

### US-45 — CSRF

**AC-45.1 — Mutations require a token**
Given a state-changing administrative request without a valid CSRF token,
Then the response is `403` (CSRF invalid) and nothing is written.

**AC-45.2 — A valid token is accepted**
Given the token bound to the current session,
When a mutation is submitted,
Then it is processed normally.

### US-46 — Session security

**AC-46.1 — Only hashes are stored**
Given a live session,
Then the database stores only the SHA-256 hash of the session token, never the
token itself.

**AC-46.2 — Sessions expire**
Given a session older than its absolute lifetime,
Then it no longer authenticates.

**AC-46.3 — Idle timeout**
Given a session idle beyond the idle timeout,
Then it is revoked and no longer authenticates.

**AC-46.4 — Revocation**
Given an account is disabled or its password changed,
Then its other sessions are revoked.

### US-47 — Headers, CSP, inert media, error safety

**AC-47.1 — Security headers present**
Given any response,
Then it carries the configured security headers, including a content-security
policy without `unsafe-inline` and `X-Frame-Options: DENY` for HTML.

**AC-47.2 — Media is inert**
Given an uploaded media response,
Then it is served with an inert policy (including `sandbox`),
`X-Content-Type-Options: nosniff`, and the content type derived from the stored
extension.

**AC-47.3 — No stack traces**
Given an unexpected internal error,
Then the response contains no stack trace and no SQL text.

**AC-47.4 — Unknown paths are a friendly 404**
Given a request for an unknown path,
When the response is rendered,
Then it is `404` with a human-readable page and no internal detail.

### US-48 — Server-side validation and upload safety

**AC-48.1 — Validation is server-side**
Given any client-side check is bypassed,
When invalid input is submitted,
Then the server still rejects it.

**AC-48.2 — Uploads are type-checked**
Given an uploaded file,
When its magic bytes do not match a permitted image type,
Then it is rejected regardless of its name or declared MIME type.

**AC-48.3 — Upload size is capped**
Given a file larger than the configured maximum,
When it is uploaded,
Then it is rejected.

**AC-48.4 — Body handling is bounded**
Given an oversized request body or malformed JSON,
When it is submitted,
Then it is refused with `413`/`422` and never a `500`.

---

## Epic 9 — Responsive usability and reliability

### US-49 — Responsive at 390 / 768 / 1440

**AC-49.1 — No horizontal overflow**
Given any primary route,
When it is rendered at 390, 768 and 1440 pixels wide,
Then the page does not scroll horizontally.

**AC-49.2 — Controls remain reachable**
Given any primary route at 390 pixels,
When it is rendered,
Then navigation and primary form controls remain visible and operable.

**AC-49.3 — Content is not clipped**
Given any table or detail list at a narrow width,
Then values wrap or the table scrolls within its own container rather than
being clipped.

### US-50 — Readable tables and detail lists

**AC-50.1 — Detail-list label track is bounded**
Given a two-column detail list,
Then the label track cannot consume the whole container and the value track
retains usable width.

**AC-50.2 — Long tokens wrap**
Given a value containing a long unbroken token,
Then it wraps inside its track and does not overflow the container.

### US-51 — Errors and empty states

**AC-51.1 — Errors are mapped consistently**
Given an application error on an API path,
Then it is returned as structured JSON with an error code.

**AC-51.2 — Validation errors carry field details**
Given a validation failure,
Then the client receives the field-level details.

**AC-51.3 — Empty data is honest**
Given an empty database,
Then dashboards and lists show zero or an empty-state message, never invented
numbers.

### US-52 — Reproducible startup

**AC-52.1 — Migrations are idempotent**
Given a database at any migration level,
When migrations run,
Then they apply only what is missing and running them twice is safe.

**AC-52.2 — Seeding is idempotent**
Given an already-seeded database,
When the seed runs,
Then it reports it skipped and duplicates nothing.

**AC-52.3 — Documented start command works**
Given a fresh clone and a Node.js ≥ 22.5 runtime,
When the documented start command is run,
Then the server reports it is ready and the primary routes respond as
documented.

### US-53 — Reproducible tests

**AC-53.1 — Suites are runnable by script**
Given the repository,
When `npm test`, `npm run test:concurrency` and `npm run test:e2e` are run,
Then each completes with the reported pass/fail counts.

**AC-53.2 — No clock-dependent flakiness**
Given the e2e availability probe,
Then it uses a fixed SLST window and does not depend on the wall-clock time of
day at which the suite runs.

**AC-53.3 — Regression tests accompany fixes**
Given a defect was fixed,
Then a test exists that fails against the pre-fix behaviour and passes after.

---

## Epic 10 — Production readiness and accessibility

### US-54 — PostgreSQL persistence

**AC-54.1 — Runtime uses PostgreSQL** *(intended)*
Given a production configuration,
When the application stores data,
Then it writes to PostgreSQL rather than a local SQLite file.

**AC-54.2 — Equivalent schema** *(intended)*
Given the PostgreSQL migration,
Then it defines the same tables, checks and constraints as the SQLite schema.

### US-55 — Durable object storage

**AC-55.1 — Uploads go to object storage when configured** *(intended)*
Given `BLOB_READ_WRITE_TOKEN` is set,
When a photograph is uploaded,
Then the bytes are stored in the object store and the record points at the
returned URL.

**AC-55.2 — Local fallback** *(intended)*
Given the token is absent,
When a photograph is uploaded,
Then the bytes are stored locally and no remote call is attempted.

### US-56 — Production deployment

**AC-56.1 — A production deployment exists** *(intended)*
Given the repository,
Then a production URL served by a supported host answers the public routes.

**AC-56.2 — Post-deployment smoke test** *(intended)*
Given the production URL,
When the public and admin routes are exercised,
Then they respond as they do locally.

### US-57 — Real SMTP delivery

**AC-57.1 — Configured SMTP delivers** *(intended)*
Given valid SMTP credentials,
When a request is submitted,
Then an email is actually delivered and the status is `SENT`.

**AC-57.2 — Honest status under real failure** *(intended)*
Given a real SMTP failure,
Then the status is `FAILED` and the inquiry is still stored.

### US-58 — Accessibility conformance

**AC-58.1 — Automated accessibility audit** *(intended)*
Given each primary page,
When an accessibility audit is run,
Then it reports no serious or critical violations.

**AC-58.2 — Keyboard operability** *(intended)*
Given keyboard-only navigation,
Then every interactive control is reachable and operable with a visible focus
indicator.

---

## Criteria inventory

| Epic | Story IDs | Criteria | AC IDs |
|---|---|---|---|
| 1 Space discovery | US-01 – US-04 | 11 | AC-01.1 – AC-04.2 |
| 2 Booking requests and inquiries | US-05 – US-11 | 22 | AC-05.1 – AC-11.3 |
| 3 Administrator authentication and dashboard | US-12 – US-17 | 17 | AC-12.1 – AC-17.3 |
| 4 Space and pricing management | US-18 – US-24 | 23 | AC-18.1 – AC-24.3 |
| 5 Reservation management | US-25 – US-31 | 22 | AC-25.1 – AC-31.3 |
| 6 Availability, maintenance and double-booking prevention | US-32 – US-38 | 24 | AC-32.1 – AC-38.3 |
| 7 Timezone and currency handling | US-39 – US-41 | 9 | AC-39.1 – AC-41.3 |
| 8 Notifications, auditing and security | US-42 – US-48 | 24 | AC-42.1 – AC-48.4 |
| 9 Responsive usability and reliability | US-49 – US-53 | 14 | AC-49.1 – AC-53.3 |
| 10 Production readiness and accessibility | US-54 – US-58 | 10 | AC-54.1 – AC-58.2 |
| **Total** | **58 stories** | **176** | |
