# Data Model — Nagaro Space Booking System

**Engine:** SQLite 3.53.4 via `node:sqlite` (`DatabaseSync`).
**Schema source of truth:** `src/server/db/migrations/0001_init.sql` (applied by `src/server/db/migrate.js`).
**Time convention:** every `*_at` column is `INTEGER` **Unix epoch milliseconds, UTC**.
**Business time zone:** `Asia/Colombo` (SLST, fixed UTC+05:30, no DST).
**Interval convention:** half-open `[start_at, end_at)`; two intervals conflict exactly when
`a.start_at < b.end_at AND a.end_at > b.start_at`.

Every statement in this document was verified against the SQL in the repository and against a live
in-memory database created by `applyMigrations()`; see §9 for the exact verification commands and their
real output. Where the schema and a service disagree, the disagreement is called out explicitly rather
than smoothed over.

---

## 1. Entity-relationship narrative

### 1.1 Identity, sessions, history

| Table | Purpose | Natural key | Who reads / writes |
|---|---|---|---|
| `admin_user` | One row per member of Nagaro staff who may sign in, plus an inactive system principal for public checkout attribution. Holds the scrypt password hash, the database-resolved role, the failed-login counter and the lockout deadline. | `email` (`UNIQUE COLLATE NOCASE` — `HQ@Nagaro.et` and `hq@nagaro.et` cannot coexist) | **Service only.** Written by the admin-user service, bootstrap path, and lazy public-booking system-principal initializer. Read by `sessions.authenticate()` on every sign-in. System principals are excluded from staff lists and cannot authenticate. Never exposed by any route; the `password_hash` column must never leave the server. |
| `admin_session` | One row per signed-in browser session. Stores **only the SHA-256 hash** of the cookie token plus the per-session CSRF secret, so a database copy cannot be replayed as a live session. | `token_hash` (`UNIQUE`) | **Service only.** Written by `createSession()`, updated by `resolveSession()` (last-seen), revoked by `revokeSession()` / `revokeAllSessionsForUser()`. No route reads the table directly. |
| `audit_log` | Append-only history of every state change. One row per action, written **inside the same transaction** as the change it describes. | none (surrogate `id`); the meaningful key is `(entity_type, entity_id, at)` | **Admin read, service write.** Read via the admin activity log (`/admin/audit`) and `listAudit()`. Written only by `recordAudit()`. There is no update or delete path. |

### 1.2 Catalogue and bookable inventory

| Table | Purpose | Natural key | Who reads / writes |
|---|---|---|---|
| `space` | The catalogue entry: code, name, category, capacity, status, currency, pricing unit, duration rules, buffer, opening hours, amenities, category-specific attributes. | `code` (`UNIQUE COLLATE NOCASE`) — the same string that appears in public URLs such as `/spaces/TRC-MR-01` | **Public read for `PUBLISHED` rows only** (name, description, amenities, rates, capacity, hours). **Admin read** for all statuses. Written only by `spaceService`. |
| `space_rate` | One row per `(space, pricing unit)` the space charges for. Amounts in integer cents. Exactly one row per space is flagged `is_default`. | `(space_id, unit)` (`UNIQUE`) | **Public read** as part of a published space's rate card. Written only by `spaceService.persistRates()`. |
| `space_image` | Photographs. Stores a random 32-hex-character `stored_name` and the **sniffed** MIME type, never the client-supplied filename or content type. | `stored_name` (`UNIQUE`) | **Public read** for published spaces (served by `/media/:storedName`). **Admin read/write** for upload, cover, reorder, delete. |
| `resource_unit` | The physical things that can be booked: exactly one `EXCLUSIVE` unit for a meeting room or auditorium, N `DESK` units for co-working. This table, not `space.capacity`, is what makes double booking impossible. | `(space_id, code)` (`UNIQUE`) — e.g. `UNIT-01`, `DESK-07` | **Admin read** (inventory display). Written only by `spaceService.syncUnits()` / `setDeskCount()`. Public responses expose counts, not unit rows. |

### 1.3 Customers and bookings

| Table | Purpose | Natural key | Who reads / writes |
|---|---|---|---|
| `customer` | One authoritative profile per customer. `email_normalized` supports duplicate detection; duplicates are **allowed** so that staff can see two records and merge them by hand. | none enforced — `email_normalized` is indexed but **not** unique, deliberately | **Admin read/write. Public checkout may resolve or create only its own profile inside the booking transaction.** Never joined by a public availability query. |
| `reservation` | The authoritative booking record: window, unit count, attendees, purpose, billing fields, booking channel, private management-token hash, and the full cancellation trail. | `reference` (`UNIQUE`, format `NG-<year>-<5 digits>`); `idempotency_key` (`UNIQUE`, nullable); `manage_token_hash` (`UNIQUE`, nullable) | **Admin read/write. Public checkout creates through the canonical booking service and may read/cancel only with reference + capability token.** `getPublicAvailability()` never joins this table. |
| `occupancy` | **The join between a reservation and the physical units it consumes.** One row per `(resource unit, interval)`. This is the table with the anti-overlap triggers, and the only table that decides whether a space is free. | none enforced by a key — the invariant is the trigger predicate over `(resource_unit_id, start_at, end_at)` among `ACTIVE` rows | **Admin read** (conflict detail, calendar). **Public read of counts only**, never rows. Written only by the booking service. |
| `maintenance_block` | The human-facing record of planned unavailability: who blocked it, why, over what window. | none (surrogate `id`); looked up by `(space_id, start_at)` | **Admin read/write.** Never exposed publicly except as an anonymous blocked period. |

### 1.4 Public input and machine state

| Table | Purpose | Natural key | Who reads / writes |
|---|---|---|---|
| `inquiry` | A public request-to-book submission: contact details, requested window, message, status, honest email-delivery status, withdrawal token hash and conversion link. | `reference` (`UNIQUE`, format `INQ-<year>-<5 digits>`) | **Public write** (create, and withdraw with reference + token). **Admin read/write** for the queue, status changes and conversion. Never readable by reference alone — a withdrawal requires the token too. |
| `rate_limit_counter` | Fixed-window counters, one row per `(bucket key, window start)`. Database-backed so the limit holds across processes and survives restarts. | `(bucket_key, window_start)` (primary key) | **Service only.** Written by `rateLimit.hit()`, read by `enforce()`. Bucket keys embed a salted IP hash or a normalised email, never a raw IP. |
| `app_sequence` | Monotonic document numbering for human-facing references. Two seeded rows: `reservation`, `inquiry`. | `name` (primary key) | **Service only.** Incremented by `nextReference()` inside the caller's write transaction, which is what makes reference allocation race-free. |
| `schema_migrations` | Records which migration files have been applied. Created by the runner, not by `0001_init.sql`. | `name` (primary key, e.g. `0001_init.sql`) | **Service only.** Written by `applyMigrations()`. |

---

## 2. Text ERD

```
                         admin_user ─1───N── admin_session
                              │
                              │ 1
                              ├───────────N── audit_log            (actor_admin_user_id; ON DELETE SET NULL)
                              │
                              │ 1
                              ├───────────N── reservation.created_by   (ON DELETE RESTRICT)
                              │ 1
                              ├───────────N── reservation.updated_by   (ON DELETE SET NULL)
                              │ 1
                              ├───────────N── reservation.cancelled_by (ON DELETE SET NULL)
                              │ 1
                              ├───────────N── maintenance_block.created_by   (ON DELETE RESTRICT)
                              └───────────N── maintenance_block.cancelled_by (ON DELETE SET NULL)

                         space ─1───N── space_rate        (ON DELETE CASCADE)
                         space ─1───N── space_image       (ON DELETE CASCADE)   [ ≤1 is_cover = 1, partial unique ]
                         space ─1───N── resource_unit     (ON DELETE CASCADE)
                         space ─1───N── reservation       (ON DELETE RESTRICT)  ← spaces cannot be deleted
                         space ─1───N── maintenance_block (ON DELETE CASCADE)
                         space ─1───N── occupancy         (ON DELETE CASCADE)
                         space ─1───N── inquiry           (ON DELETE SET NULL)  ← inquiry survives space removal

                         customer ─1───N── reservation    (ON DELETE RESTRICT)  ← customers cannot be deleted

                         reservation ─1───N── occupancy   (ON DELETE CASCADE)   ← occupancy is the join table
                         resource_unit ─1──N── occupancy  (ON DELETE CASCADE)

                         occupancy ─N───1── reservation        (nullable: MAINTENANCE rows have none)
                         occupancy ─N───1── maintenance_block  (soft reference, NOT a foreign key — see §4.5)
                         maintenance_block ─1──N── occupancy    (materialised as source = 'MAINTENANCE')

                         inquiry ─N───1── space                 (nullable, ON DELETE SET NULL)
                         inquiry ─N───1── reservation           (nullable converted_reservation_id, ON DELETE SET NULL)

  ┌─────────────────────────── THE INVENTORY CLAIM ────────────────────────────┐
  │  occupancy = (reservation | maintenance_block) × resource_unit × interval   │
  │  One row per unit per interval. The anti-overlap triggers act on this table.│
  └────────────────────────────────────────────────────────────────────────────┘

  app_sequence      (standalone)
  rate_limit_counter(standalone)
  schema_migrations (standalone)
```

**Reading the ERD.** A reservation does not contain a "space is booked" flag. It *owns* one `occupancy`
row per unit it consumes. Co-working is the case that makes this visible: a six-desk booking is one
`reservation` row and six `occupancy` rows, and the twenty-desk limit is a consequence of twenty unit
rows existing rather than of any counter that could drift.

---

## 3. Column reference

Nullable columns are marked. "Unit / time zone" states what the value means physically.

### 3.0 `admin_user` additions

| Column | Type | Null? | Unit / TZ | Meaning and enumerated values |
|---|---|---|---|---|
| `is_system` | INTEGER | no | 0/1 | Default 0. `1` marks the inactive, non-login principal used to attribute public checkout writes without impersonating a human staff user. System rows are excluded from staff lists and first-admin counting. |

### 3.1 `space`

| Column | Type | Null? | Unit / TZ | Meaning and enumerated values |
|---|---|---|---|---|
| `id` | INTEGER | no | surrogate | Primary key. |
| `code` | TEXT | no | — | Public identifier; `UNIQUE COLLATE NOCASE`. Uppercased by the form validator. Used in URLs. |
| `name` | TEXT | no | — | Display name. |
| `category` | TEXT | no | — | `MEETING_ROOM` · `AUDITORIUM` · `COWORKING`. Fixes the resource-unit kind and the permitted pricing units. |
| `short_description` | TEXT | **yes** | — | One-line summary for cards. Required by the form, not by the schema. |
| `description` | TEXT | **yes** | — | Full description. Required by the publish gate at ≥ 20 characters. |
| `location` | TEXT | **yes** | — | Free text, e.g. `Trace Expert City, Block A`. |
| `floor` | TEXT | **yes** | — | Free text. |
| `capacity` | INTEGER | no | headcount | `CHECK (capacity >= 1)`. Maximum number of **people**. Not bookable inventory. |
| `status` | TEXT | no | — | `DRAFT` (default) · `PUBLISHED` · `ARCHIVED`. Only `PUBLISHED` is visible publicly. |
| `currency` | TEXT | no | ISO code | Default `LKR`. |
| `pricing_unit` | TEXT | no | — | Default billing unit: `HOUR` · `HALF_DAY` · `DAY` · `WEEK` · `MONTH`. Constrained per category in the service layer. |
| `min_duration_minutes` | INTEGER | no | minutes | Default 60. `CHECK (min_duration_minutes > 0)`. |
| `max_duration_minutes` | INTEGER | **yes** | minutes | Null means "no maximum". When set, `CHECK (> 0)`. |
| `buffer_minutes` | INTEGER | no | minutes | Default 0. `CHECK (buffer_minutes >= 0)`. Turnaround gap between reservations. |
| `open_time` | TEXT | no | `HH:MM` **SLST** | Default `08:00`. Local clock time, not an epoch. |
| `close_time` | TEXT | no | `HH:MM` **SLST** | Default `18:00`. Must be strictly later than `open_time` (service-enforced). |
| `amenities` | TEXT | no | JSON array | Default `[]`. Subset of `AMENITY_CATALOG`. Used by public amenity filtering. |
| `attributes` | TEXT | no | JSON object | Default `{}`. Category-specific extras (key `[a-z0-9_]{1,40}`); only relevant keys are demanded per category. |
| `contact_note` | TEXT | **yes** | — | Shown on the public detail page. |
| `created_at`, `updated_at` | INTEGER | no | epoch ms UTC | — |
| `published_at` | INTEGER | **yes** | epoch ms UTC | Set on first publish (`COALESCE`), preserved across unpublish/republish. |
| `archived_at` | INTEGER | **yes** | epoch ms UTC | Set on archive, cleared on restore. |

### 3.2 `reservation`

| Column | Type | Null? | Unit / TZ | Meaning and enumerated values |
|---|---|---|---|---|
| `id` | INTEGER | no | surrogate | Primary key. |
| `reference` | TEXT | no | — | `UNIQUE`. `NG-<year>-<5 digits>`, e.g. `NG-2026-00042`. Immutable. |
| `space_id` | INTEGER | no | FK → `space.id` | `ON DELETE RESTRICT`. |
| `customer_id` | INTEGER | no | FK → `customer.id` | `ON DELETE RESTRICT`. |
| `status` | TEXT | no | — | `CONFIRMED` · `CANCELLED` · `COMPLETED`. No default: the service always states it. |
| `start_at` | INTEGER | no | epoch ms UTC | Interval start (inclusive). |
| `end_at` | INTEGER | no | epoch ms UTC | Interval end (exclusive). `CHECK (end_at > start_at)`. |
| `unit_count` | INTEGER | no | units | Default 1. `CHECK (unit_count >= 1)`. Desks for co-working, always 1 otherwise. |
| `attendees` | INTEGER | **yes** | headcount | `CHECK (attendees IS NULL OR attendees >= 0)`. Null skips the capacity check. |
| `purpose` | TEXT | **yes** | — | Customer-facing reason for the booking. |
| `internal_notes` | TEXT | **yes** | — | Admin-only. Never exposed publicly. |
| `billing_unit` | TEXT | no | — | `HOUR` · `HALF_DAY` · `DAY` · `WEEK` · `MONTH`. The unit actually billed. |
| `billing_quantity` | INTEGER | no | units | `CHECK (>= 1)`. Derived (see `BOOKING_RULES.md` §8) or overridden by staff. |
| `rate_cents` | INTEGER | no | cents | `CHECK (>= 0)`. Rate **at the time of booking**; immune to later rate changes. |
| `total_cents` | INTEGER | no | cents | `CHECK (>= 0)`. `rate_cents × billing_quantity × unit_count`. |
| `currency` | TEXT | no | ISO code | Default `LKR`. |
| `idempotency_key` | TEXT | **yes** | — | `UNIQUE`. Nulls do not collide, so ordinary bookings may omit it. Retry safety for one-shot callers. |
| `booking_channel` | TEXT | no | — | `STAFF` (default) · `PUBLIC`. Records whether the reservation came from the operations console or public self-service checkout. |
| `manage_token_hash` | TEXT | **yes** | — | `UNIQUE` when present. SHA-256 hash of the one-time-issued public management capability; the raw token is never stored. Null for staff-created reservations. |
| `created_by` | INTEGER | no | FK → `admin_user.id` | `ON DELETE RESTRICT`. |
| `created_at` | INTEGER | no | epoch ms UTC | — |
| `updated_by` | INTEGER | **yes** | FK → `admin_user.id` | `ON DELETE SET NULL`. |
| `updated_at` | INTEGER | no | epoch ms UTC | — |
| `cancelled_by` | INTEGER | **yes** | FK → `admin_user.id` | `ON DELETE SET NULL`. |
| `cancelled_at` | INTEGER | **yes** | epoch ms UTC | `CHECK`: must be non-null whenever `status = 'CANCELLED'`. |
| `cancellation_reason` | TEXT | **yes** | — | `CHECK`: must be non-null **and** contain a non-whitespace character whenever `status = 'CANCELLED'`. |

### 3.3 `occupancy`

| Column | Type | Null? | Unit / TZ | Meaning and enumerated values |
|---|---|---|---|---|
| `id` | INTEGER | no | surrogate | Primary key. |
| `resource_unit_id` | INTEGER | no | FK → `resource_unit.id` | `ON DELETE CASCADE`. The unit being claimed. |
| `space_id` | INTEGER | no | FK → `space.id` | `ON DELETE CASCADE`. Denormalised for cheap space-level queries. |
| `start_at` | INTEGER | no | epoch ms UTC | Inclusive. |
| `end_at` | INTEGER | no | epoch ms UTC | Exclusive. `CHECK (end_at > start_at)`. |
| `status` | TEXT | no | — | `ACTIVE` (default) consumes the unit. `RELEASED` consumes nothing and is retained for audit. |
| `source` | TEXT | no | — | `RESERVATION` · `MAINTENANCE`. No default; the writer must state it. |
| `reservation_id` | INTEGER | **yes** | FK → `reservation.id` | `ON DELETE CASCADE`. `CHECK`: non-null **exactly when** `source = 'RESERVATION'`. |
| `maintenance_block_id` | INTEGER | **yes** | soft reference | Points at `maintenance_block.id`. **There is no foreign key on this column** (§4.5). |
| `created_at` | INTEGER | no | epoch ms UTC | — |
| `released_at` | INTEGER | **yes** | epoch ms UTC | Set when `status` becomes `RELEASED`. |

### 3.4 `inquiry`

| Column | Type | Null? | Unit / TZ | Meaning and enumerated values |
|---|---|---|---|---|
| `id` | INTEGER | no | surrogate | Primary key. |
| `reference` | TEXT | no | — | `UNIQUE`. `INQ-<year>-<5 digits>`. |
| `space_id` | INTEGER | **yes** | FK → `space.id` | `ON DELETE SET NULL`. Nullable so an inquiry about a deleted space survives. |
| `customer_name` | TEXT | no | — | As typed; no matching against `customer` is attempted. |
| `email` | TEXT | no | — | As typed. |
| `email_normalized` | TEXT | no | — | Lower-cased, trimmed. Used for rate limiting and duplicate reporting. |
| `phone` | TEXT | **yes** | — | — |
| `organization` | TEXT | **yes** | — | — |
| `requested_start_at` | INTEGER | no | epoch ms UTC | Inclusive. |
| `requested_end_at` | INTEGER | no | epoch ms UTC | Exclusive. `CHECK (requested_end_at > requested_start_at)`. |
| `attendees` | INTEGER | **yes** | headcount | `CHECK (IS NULL OR >= 0)`. |
| `desk_quantity` | INTEGER | **yes** | desks | `CHECK (IS NULL OR >= 1)`. |
| `message` | TEXT | **yes** | — | Visitor's own words. |
| `status` | TEXT | no | — | Default `NEW`. `NEW` → `CONTACTED` → `CONVERTED` · `CLOSED` · `WITHDRAWN`. |
| `withdraw_token_hash` | TEXT | **yes** | — | SHA-256 of the withdrawal token. The raw token exists only in the visitor's link. |
| `email_status` | TEXT | no | — | Default `PENDING`. `PENDING` · `SENT` · `FAILED` · `NOT_CONFIGURED`. |
| `email_error` | TEXT | **yes** | — | Failure detail for staff; never shown to the visitor. |
| `email_attempted_at` | INTEGER | **yes** | epoch ms UTC | — |
| `email_message_id` | TEXT | **yes** | — | SMTP message id when the provider returns one. |
| `internal_notes` | TEXT | **yes** | — | Admin-only. |
| `converted_reservation_id` | INTEGER | **yes** | FK → `reservation.id` | `ON DELETE SET NULL`. The conversion link. |
| `created_at`, `updated_at` | INTEGER | no | epoch ms UTC | — |

### 3.5 `customer`

| Column | Type | Null? | Unit / TZ | Meaning |
|---|---|---|---|---|
| `id` | INTEGER | no | surrogate | Primary key. |
| `full_name` | TEXT | no | — | Display and search name. |
| `email` | TEXT | no | — | As entered by staff. |
| `email_normalized` | TEXT | no | — | Lower-cased, trimmed. Indexed, **not unique** — duplicates are permitted and surfaced to staff, never merged automatically. |
| `phone` | TEXT | **yes** | — | Validated shape only; never dialled by the system. |
| `organization` | TEXT | **yes** | — | — |
| `notes` | TEXT | **yes** | — | Admin-only free text. |
| `created_at`, `updated_at` | INTEGER | no | epoch ms UTC | — |

### 3.6 `space_image`

| Column | Type | Null? | Unit / TZ | Meaning |
|---|---|---|---|---|
| `id` | INTEGER | no | surrogate | Primary key. |
| `space_id` | INTEGER | no | FK → `space.id` | `ON DELETE CASCADE`. |
| `stored_name` | TEXT | no | — | `UNIQUE`. 32 random hex characters + extension derived from **sniffed bytes**. |
| `original_name` | TEXT | no | — | The client's filename, kept only for display in admin. Never used on the filesystem. |
| `mime_type` | TEXT | no | — | `image/jpeg` · `image/png` · `image/webp`. Never `image/svg+xml`. |
| `byte_size` | INTEGER | no | bytes | `CHECK (byte_size > 0)`. |
| `alt_text` | TEXT | **yes** | — | Accessibility text. |
| `sort_order` | INTEGER | no | ordinal | Default 0. Display order; rewritten as a dense 0..n-1 sequence on reorder. |
| `is_cover` | INTEGER | no | 0/1 | `CHECK (is_cover IN (0,1))`. At most one `1` per space (partial unique index). |
| `created_at` | INTEGER | no | epoch ms UTC | — |

### 3.7 `resource_unit`

| Column | Type | Null? | Unit / TZ | Meaning |
|---|---|---|---|---|
| `id` | INTEGER | no | surrogate | Primary key. |
| `space_id` | INTEGER | no | FK → `space.id` | `ON DELETE CASCADE`. |
| `code` | TEXT | no | — | `UNIQUE (space_id, code)`. `UNIT-01` for exclusive units, `DESK-01`… for desks. |
| `label` | TEXT | no | — | `Desk 07`, or the space name for an exclusive unit. |
| `kind` | TEXT | no | — | `EXCLUSIVE` (one booking at a time) · `DESK` (pooled). |
| `is_active` | INTEGER | no | 0/1 | Default 1. Deactivated, never deleted, so historical occupancy keeps a real target. |
| `created_at` | INTEGER | no | epoch ms UTC | — |

---

## 4. Constraint and index inventory

### 4.1 `CHECK` constraints

| Table | Constraint | Invariant it protects |
|---|---|---|
| `admin_user` | `role IN ('ADMIN','STAFF')` | No third role can appear without a migration. Roles are never taken from the client. |
| `admin_user` | `is_active IN (0,1)` | Boolean discipline; a disabled account cannot be represented ambiguously. |
| `admin_user` | `is_system IN (0,1)` | Public-checkout attribution principals are explicit and cannot masquerade as ordinary staff rows. |
| `reservation` | `booking_channel IN ('STAFF','PUBLIC')` | Every reservation has an auditable source. |
| `space` | `category IN ('MEETING_ROOM','AUDITORIUM','COWORKING')` | Exactly three catalogue shapes; inventory and pricing rules key off this. |
| `space` | `capacity >= 1` | A space with zero capacity is meaningless. |
| `space` | `status IN ('DRAFT','PUBLISHED','ARCHIVED')` | Public visibility is a closed set; nothing else can leak. |
| `space` | `pricing_unit IN (...5 units...)` | Billing units cannot be invented. |
| `space` | `min_duration_minutes > 0` | No zero-minute bookings. |
| `space` | `max_duration_minutes IS NULL OR max_duration_minutes > 0` | A maximum of 0 would make the space unbookable. |
| `space` | `buffer_minutes >= 0` | A negative buffer would let bookings be pulled backwards. |
| `space_rate` | `unit IN (...5 units...)` | Rate rows cannot carry an unknown unit. |
| `space_rate` | `amount_cents >= 0` | Prices are non-negative; no negative totals. |
| `space_rate` | `is_default IN (0,1)` | — |
| `space_image` | `byte_size > 0` | Zero-byte "photographs" cannot exist. |
| `space_image` | `is_cover IN (0,1)` | Boolean discipline, so the partial unique index is meaningful. |
| `resource_unit` | `kind IN ('EXCLUSIVE','DESK')` | Pooled-vs-exclusive behaviour is a closed set. |
| `resource_unit` | `is_active IN (0,1)` | — |
| `reservation` | **`end_at > start_at`** | The authoritative non-inverted-interval rule. Together with the half-open convention it makes zero-length bookings impossible and makes the trigger predicate well-defined. |
| `reservation` | `unit_count >= 1` | A reservation always claims at least one unit. |
| `reservation` | `attendees IS NULL OR attendees >= 0` | Headcount is never negative. |
| `reservation` | `billing_quantity >= 1` | Billing quantity is always at least one unit. |
| `reservation` | `rate_cents >= 0`, `total_cents >= 0` | — |
| `reservation` | **`status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL AND trim(cancellation_reason) <> '')`** | **Anonymity prevention.** A cancelled reservation can never exist without a timestamp and a *substantive* reason. Note the constraint is a one-way implication: it does **not** forbid a reason on a non-cancelled row (verified in §9). |
| `occupancy` | `status IN ('ACTIVE','RELEASED')` | Only two states exist; "ACTIVE-ish" is not expressible. |
| `occupancy` | `source IN ('RESERVATION','MAINTENANCE')` | — |
| `occupancy` | **`end_at > start_at`** | Every claim has positive length, so the trigger predicate has a stable meaning. |
| `occupancy` | **`(source = 'RESERVATION') = (reservation_id IS NOT NULL)`** | **Structural integrity of the claim.** This is an equivalence, not an implication: a `RESERVATION` row *must* name its reservation, and a `MAINTENANCE` row *must not*. Without it, a maintenance block could inherit a reservation's identity in a join and corrupt conflict reporting. Verified in §9 (both directions rejected). |
| `maintenance_block` | `status IN ('ACTIVE','CANCELLED')` | — |
| `maintenance_block` | `end_at > start_at` | Maintenance cannot be zero-length. |
| `inquiry` | `status IN ('NEW','CONTACTED','CONVERTED','CLOSED','WITHDRAWN')` | The queue is a closed workflow. |
| `inquiry` | `email_status IN ('PENDING','SENT','FAILED','NOT_CONFIGURED')` | Delivery honesty is enforced by the schema: there is no "probably sent". |
| `inquiry` | `attendees IS NULL OR attendees >= 0`; `desk_quantity IS NULL OR desk_quantity >= 1` | — |
| `inquiry` | `requested_end_at > requested_start_at` | A visitor cannot submit an inverted request. |
| `admin_session` / `admin_user` | `is_active IN (0,1)` | — |

### 4.2 `UNIQUE` constraints and partial unique indexes

| Object | Definition | Invariant / query served |
|---|---|---|
| `admin_user.email` | `UNIQUE COLLATE NOCASE` | One account per human, case-insensitively. Sign-in looks up `WHERE email = ? COLLATE NOCASE`. |
| `admin_session.token_hash` | `UNIQUE` | One row per session token; lookup by hash is a single index probe. |
| `space.code` | `UNIQUE COLLATE NOCASE` | Public identifiers are unambiguous — `/spaces/trc-mr-01` and `/spaces/TRC-MR-01` are the same space. **Verified** in §9: inserting `s1` when `S1` exists is rejected. |
| `space_rate (space_id, unit)` | `UNIQUE` | One rate per pricing unit per space; no ambiguity about which price applies. |
| `space_image.stored_name` | `UNIQUE` | Two photographs can never share a file; also stops a crafted upload from overwriting another space's image. |
| **`ux_image_cover`** | `CRSLSTE UNIQUE INDEX ux_image_cover ON space_image(space_id) WHERE is_cover = 1` | **At most one cover photograph per space, enforced by the database.** This is a *partial* unique index: it indexes only the rows where `is_cover = 1`, so a space may legally have many `is_cover = 0` rows. Verified in §9: a second cover row for the same space is rejected with `UNIQUE constraint failed: space_image.space_id`. It is what lets `setCoverImage()` clear-then-set inside one transaction and still be crash-safe: a half-applied change cannot leave two covers. Note SQLite does not allow a partial unique *constraint*, only a partial unique index — the behaviour is identical. |
| `resource_unit (space_id, code)` | `UNIQUE` | Desk codes are unique within a space. Note these are unique *per space*, not globally, so `DESK-01` exists in every co-working space. |
| **`reservation.reference`** | `UNIQUE` | **Human-facing reference uniqueness.** Two bookings can never share `NG-2026-00042` even if `app_sequence` were reset; the index is the last line of defence behind the sequence allocation. Verified in §9: a duplicate reference is rejected. |
| **`reservation.idempotency_key`** | `UNIQUE` (nullable) | **Retry safety.** A client that resends the same create request cannot book twice: the second attempt hits the unique index and `handleBookingFailure()` returns the original reservation instead of an error. Because the column is nullable and SQLite allows many NULLs in a unique index, ordinary bookings that omit a key never collide. Verified in §9: a duplicate key is rejected, two NULL keys coexist. |
| `inquiry.reference` | `UNIQUE` | Inquiry references are unique. |
| `rate_limit_counter (bucket_key, window_start)` | primary key | One counter row per bucket per window; `INSERT … ON CONFLICT DO UPDATE` gives an atomic increment. |
| `app_sequence.name` | primary key | One sequence per document type. |
| `schema_migrations.name` | primary key | A migration file is applied at most once. |

### 4.3 Foreign keys and their `ON DELETE` behaviour

| Child column | Parent | `ON DELETE` | Why |
|---|---|---|---|
| `admin_session.admin_user_id` | `admin_user.id` | `CASCADE` | Removing an account removes its sessions. Nothing else should survive. |
| `audit_log.actor_admin_user_id` | `admin_user.id` | `SET NULL` | History stays readable after an account is removed; the denormalised `actor_label` preserves who did it. |
| `space_rate.space_id` | `space.id` | `CASCADE` | Rates are meaningless without their space. |
| `space_image.space_id` | `space.id` | `CASCADE` | Same. |
| `resource_unit.space_id` | `space.id` | `CASCADE` | Same. |
| **`reservation.space_id`** | `space.id` | **`RESTRICT`** | **A space with any booking, past or future, cannot be deleted.** Deliberate: deleting a space would erase the meaning of historical bookings and their prices. Verified in §9 (`FOREIGN KEY constraint failed`). |
| **`reservation.customer_id`** | `customer.id` | **`RESTRICT`** | A customer with history cannot be deleted, so no booking loses its counterparty. |
| `reservation.created_by` | `admin_user.id` | `RESTRICT` | Every booking keeps an attributable creator. |
| `reservation.updated_by` / `cancelled_by` | `admin_user.id` | `SET NULL` | Optional attribution. |
| `occupancy.resource_unit_id` | `resource_unit.id` | `CASCADE` | Claims on a unit are meaningless without it. (In practice units are deactivated, not deleted.) |
| `occupancy.space_id` | `space.id` | `CASCADE` | — |
| `occupancy.reservation_id` | `reservation.id` | `CASCADE` | A booking's claims die with it. No application path deletes a reservation, so this is a safety net rather than normal behaviour. |
| `maintenance_block.space_id` | `space.id` | `CASCADE` | — |
| `maintenance_block.created_by` | `admin_user.id` | `RESTRICT` | Every block keeps its author. |
| `maintenance_block.cancelled_by` | `admin_user.id` | `SET NULL` | — |
| `inquiry.space_id` | `space.id` | `SET NULL` | An inquiry about a space that no longer exists is still a business record of a person who asked. |
| `inquiry.converted_reservation_id` | `reservation.id` | `SET NULL` | The conversion link is severable without destroying the inquiry. |

Foreign keys are enforced because `getDb()` issues `PRAGMA foreign_keys = ON` on every connection
(`src/server/db/connection.js`). **Without that pragma, none of the `RESTRICT` guarantees above hold** —
see §5.6.

### 4.4 Indexes and the queries they serve

| Index | Definition | Query it serves |
|---|---|---|
| `ix_space_status_cat` | `space(status, category)` | Public directory (`WHERE status = 'PUBLISHED' AND category = ?`) and the admin space list filter. |
| `ix_space_pricing` | `space(pricing_unit)` | Pricing-unit filters and reporting. |
| `ix_image_space_order` | `space_image(space_id, sort_order)` | Gallery rendering in display order. |
| `ux_image_cover` | `space_image(space_id) WHERE is_cover = 1` | Cover-photo lookup **and** the at-most-one-cover invariant (§4.2). |
| `ix_unit_space` | `resource_unit(space_id, is_active)` | `activeUnits(db, spaceId)` — the allocation pool. |
| `ix_customer_email_norm` | `customer(email_normalized)` | Duplicate detection on create/update. |
| `ix_customer_name` | `customer(full_name COLLATE NOCASE)` | Customer directory search. |
| `ix_res_window` | `reservation(start_at, end_at)` | Cross-space window queries (calendar, "what overlaps this period?"). |
| `ix_res_space_window` | `reservation(space_id, start_at)` | Space history and per-space ranges. |
| `ix_res_customer` | `reservation(customer_id, start_at DESC)` | Customer booking history, newest first. |
| `ix_res_status` | `reservation(status, start_at)` | Status filters; reconciliation (`status = 'CONFIRMED' AND end_at < ?`). |
| **`ix_occ_unit_active`** | `occupancy(resource_unit_id, start_at) WHERE status = 'ACTIVE'` | **The single most important index in the system.** It is what the anti-overlap trigger probe uses, so the trigger is an index range scan rather than a table scan. Verified plan: `SEARCH o USING INDEX ix_occ_unit_active (resource_unit_id=? AND start_at<?)`. |
| **`ix_occ_space_active`** | `occupancy(space_id, start_at) WHERE status = 'ACTIVE'` | **The hot availability query**: "what is booked on this space in this period?" Verified plan: `SEARCH o USING INDEX ix_occ_space_active (space_id=?)`. |
| `ix_occ_reservation` | `occupancy(reservation_id)` | Hydrating a reservation's unit list; releasing its claims. |
| `ix_occ_maint` | `occupancy(maintenance_block_id)` | Releasing a cancelled maintenance block's claims. No FK backs this column, so this index carries the join alone. |
| `ix_maint_space` | `maintenance_block(space_id, start_at)` | Maintenance listing per space and per range. |
| `ix_inquiry_status` | `inquiry(status, created_at DESC)` | The admin inquiry queue, newest first. |
| `ix_inquiry_space` | `inquiry(space_id, requested_start_at)` | Per-space inquiry history. |
| `ix_inquiry_email` | `inquiry(email_normalized)` | Repeat-visitor reporting. |
| `ix_session_user` | `admin_session(admin_user_id, expires_at)` | Revoke-all-for-user and expiry sweeps. |
| `ix_audit_entity` | `audit_log(entity_type, entity_id, at DESC)` | "Show me this reservation's history." |
| `ix_audit_at` | `audit_log(at DESC)` | Recent-activity feed on the dashboard. |

The partial `WHERE status = 'ACTIVE'` indexes are deliberate: `RELEASED` rows accumulate forever and are
never needed for availability questions, so excluding them keeps the index small and the scan tight.

### 4.5 Deliberate omissions and soft references

- **`occupancy.maintenance_block_id` has no foreign key.** It is a soft reference. Every other
  relationship in the schema is enforced; this one is not, so `PRAGMA foreign_key_check` will not detect a
  dangling maintenance block id. `maintenance_block` rows are never deleted (cancelling sets
  `status = 'CANCELLED'`), so a dangling value cannot arise today — but any future code that deletes
  maintenance rows must release their occupancy first.
- **`audit_log` has no foreign key to the entities it describes.** `entity_id` is `TEXT` on purpose so the
  same column can address an integer id, a code, or a composite. The log must survive the entity.
- **`customer.email_normalized` is not unique.** Duplicate customer records are a supported state, not a
  data error: the system detects likely duplicates and shows them to staff, and never merges records
  automatically.
- **`space_rate` has no unique constraint on `is_default`.** `persistRates()` maintains exactly one default
  row per space by deleting and re-inserting the rate set inside one transaction, but the invariant is
  service-level, not database-level.
- **`reservation.billing_*` is not derived on read.** The stored values are history; nothing recomputes
  them from current rates.

---

## 5. The concurrency mechanism, in detail

### 5.1 The problem in one sentence

Two processes ask "is this slot free?", both are told yes, both insert — unless something serialises the
check with the write. SQLite has **no `EXCLUDE` constraint** (that is a PostgreSQL feature), so this
system replaces it with two mechanisms that together produce the same guarantee:
**single-writer serialisation** (`BEGIN IMMEDIATE` + `busy_timeout`) and **database triggers** that refuse
an overlapping `ACTIVE` row regardless of how it was constructed.

### 5.2 The two triggers, verbatim

From `src/server/db/migrations/0001_init.sql`:

```sql
CRSLSTE TRIGGER trg_occupancy_no_overlap_insert
BEFORE INSERT ON occupancy
FOR EACH ROW WHEN NEW.status = 'ACTIVE'
BEGIN
  SELECT RAISE(ABORT, 'DOUBLE_BOOKING_CONFLICT')
  WHERE EXISTS (
    SELECT 1 FROM occupancy o
    WHERE o.resource_unit_id = NEW.resource_unit_id
      AND o.status = 'ACTIVE'
      AND o.id <> NEW.id
      AND o.start_at < NEW.end_at
      AND o.end_at   > NEW.start_at
  );
END;

CRSLSTE TRIGGER trg_occupancy_no_overlap_update
BEFORE UPDATE ON occupancy
FOR EACH ROW WHEN NEW.status = 'ACTIVE'
BEGIN
  SELECT RAISE(ABORT, 'DOUBLE_BOOKING_CONFLICT')
  WHERE EXISTS (
    SELECT 1 FROM occupancy o
    WHERE o.resource_unit_id = NEW.resource_unit_id
      AND o.status = 'ACTIVE'
      AND o.id <> NEW.id
      AND o.start_at < NEW.end_at
      AND o.end_at   > NEW.start_at
  );
END;
```

Four details that matter:

1. **`WHEN NEW.status = 'ACTIVE'`** — a release (`ACTIVE` → `RELEASED`) never trips the trigger, which is
   what makes cancellation possible in one statement.
2. **`o.status = 'ACTIVE'`** — released rows are invisible to the check. That is the whole point of
   keeping them: they are audit, not inventory.
3. **`o.id <> NEW.id`** — the update trigger cannot collide with the row it is updating. For inserts
   `NEW.id` is `NULL` and `o.id <> NULL` evaluates to `NULL`, so the clause is inert, which is the
   intended effect.
4. **The predicate is the same three-line inequality as the rest of the system** —
   `o.start_at < NEW.end_at AND o.end_at > NEW.start_at` — so trigger and service can never drift.

### 5.3 What happens when two processes race for the same slot

Setup: process A and process B both call `createReservation()` for `TRC-MR-01` at 09:00–11:00, and the
slot is free.

| # | Process A | Process B | Database state |
|---|---|---|---|
| 1 | `withWriteTransaction()` issues `BEGIN IMMEDIATE` | — | A holds the `RESERVED` write lock. WAL readers are unaffected. |
| 2 | — | `BEGIN IMMEDIATE` fails to acquire the lock and **queues on `busy_timeout = 10000`** | B is blocked, not errored. It sleeps and retries internally. |
| 3 | A re-checks availability **while holding the lock**: `inspectUnits()` / `allocateUnits()` see committed rows only | — | A sees the slot free. |
| 4 | A inserts the `reservation` row (`app_sequence` also advances under the same lock, so the reference is unique) | — | — |
| 5 | A inserts one `occupancy` row per allocated unit, `status = 'ACTIVE'`. The insert trigger runs; `EXISTS` finds no overlapping `ACTIVE` row | — | Claim committed. |
| 6 | A writes the `audit_log` row in the same transaction | — | — |
| 7 | A issues `COMMIT` and **releases the write lock** | — | — |
| 8 | — | B's `BEGIN IMMEDIATE` finally succeeds | — |
| 9 | — | B re-checks availability. The re-check queries committed data, so **it now sees A's `ACTIVE` occupancy row** | B sees the slot as taken. |
| 10 | — | `allocateUnits()` finds zero free units and throws `DoubleBookingError` before any insert | B's transaction rolls back. |
| 11 | — | Caller receives **HTTP 409 / `DOUBLE_BOOKING_CONFLICT`**, with `details.conflicts` naming the blocking reservation | Nothing was written by B. |

The critical property is at steps 3 and 9: **the availability check happens after the write lock is held**,
so a booking that committed between the two checks is always visible. A successful *preview* (the
`/api/public/availability` response) is therefore worth nothing on its own. It is advisory, and
`getPublicAvailability()` marks it `provisional: true`.

### 5.4 The trigger as the independent second line

The service-layer check at step 3 and step 9 could be bypassed by a bug or by a future code path that
forgot it. The trigger cannot be bypassed by SQL. If B, for whatever reason, reached the insert
(unlocked, stale check, hand-written query, a future admin importer), the `BEFORE INSERT` trigger would
find A's overlapping `ACTIVE` row, raise `ABORT`, and SQLite would reject the statement. Because the whole
booking is one transaction, the abort rolls back the reservation row, every occupancy row, and the audit
entry.

`RAISE(ABORT, …)` means "abort the statement and roll back the current transaction" — it is not a
warning. The error surfaces to `node:sqlite` as `ERR_SQLITE_ERROR` with `errcode 1811` and
`message === 'DOUBLE_BOOKING_CONFLICT'`, which `isTriggerConflict()` detects by substring and converts
into a `DoubleBookingError` with a human explanation.

**What the trigger does *not* enforce is the buffer.** Triggers compare raw intervals. Two reservations
that a space's `buffer_minutes` should have kept apart are, at the database level, merely non-overlapping —
permitted. The buffer exists only in `allocateUnits()` / `inspectUnits()`. Any new write path that inserts
occupancy rows directly would therefore keep the no-double-booking guarantee but silently lose the
turnaround guarantee. See `BOOKING_RULES.md` §4 and assumption A20.

### 5.5 Cancellation, editing and idempotency under the same lock

- **Cancellation** is `UPDATE reservation SET status='CANCELLED' … WHERE id = ? AND status = 'CONFIRMED'`,
  then `UPDATE occupancy SET status='RELEASED' WHERE reservation_id = ? AND status='ACTIVE'`, then the
  audit row, all inside one `BEGIN IMMEDIATE`. The `WHERE status = 'CONFIRMED'` clause is an optimistic
  guard: a second cancel changes zero rows and is rejected with a conflict instead of releasing inventory
  twice. The release `UPDATE` does not trip the update trigger because `NEW.status = 'RELEASED'`.
- **Editing** releases the reservation's existing claims and inserts the new ones in the same transaction.
  A failed edit rolls back to the exact previous state, so "rejected edit leaves the original untouched"
  is a property of the transaction, not of careful bookkeeping.
- **Idempotent creation** short-circuits inside the transaction: if the key is already present, the
  original reservation is returned. If two processes race with the same key, one commits and the other
  hits `UNIQUE constraint failed: reservation.idempotency_key`, which `handleBookingFailure()` turns back
  into the original reservation. Both callers get the same booking, and only one booking exists.
- **Reference allocation** uses `UPDATE app_sequence SET value = value + 1 … RETURNING value` inside the
  caller's write transaction, so the write lock serialises it and two concurrent bookings cannot receive
  the same number.

### 5.6 When this guarantee does **not** hold

The guarantee is a property of *this* application plus *these* pragmas plus *this* storage. It is not a
property of the SQLite file in the abstract. It would fail if:

1. **A second application writes to the same database file without the pragmas.**
   `PRAGMA foreign_keys = ON` is per-connection, so a foreign tool would silently ignore every `RESTRICT`
   and `CASCADE`; and a writer that does not use `BEGIN IMMEDIATE` could interleave a read with another
   process's write. The triggers would still fire, so double booking specifically would still be refused —
   but the surrounding invariants (foreign keys, `busy_timeout` queueing, atomic rollback of a
   multi-statement transaction) would not.
2. **`PRAGMA ignore_check_constraints = ON`.** This disables `CHECK` constraints, `NOT NULL` and
   `UNIQUE` — not triggers. A cancelled reservation could lose its reason, and `unit_count` could go to
   zero. The overlap trigger would still refuse a double booking, but the data model would be inconsistent.
3. **A migration drops or alters a trigger.** Removing `trg_occupancy_no_overlap_insert` (or narrowing its
   `WHEN` clause, or changing `o.status = 'ACTIVE'`) disables the database-level guarantee for every code
   path, permanently and silently. This is the single highest-consequence change anyone can make to this
   schema, which is why `tests/unit/bookingRulesTraceability.test.js` asserts that both trigger names exist
   **and** that each body still contains `RAISE(ABORT, 'DOUBLE_BOOKING_CONFLICT')`.
4. **A migration weakens the predicate.** Changing `<` to `<=` (or `>` to `>=`) would make abutting
   bookings conflict, and the availability service would disagree with the database. The half-open rule
   must be changed in the trigger, `intervalsOverlap()` and this document together or not at all.
5. **The database file lives on a network share, a synced folder, or a virtualised filesystem with
   unreliable locking.** SQLite's locking relies on POSIX/Windows file locks (and, in WAL mode, shared
   memory). On NFS or SMB with broken lock semantics, two processes can both believe they hold the write
   lock and both commit. **This is a silent, data-corrupting failure** — the trigger's `EXISTS` check is
   evaluated against a snapshot that may already be stale. WAL mode also requires all processes to be on
   the same host. Keep `data/nagaro.db` on local storage, or move to a client/server database.
6. **`PRAGMA foreign_keys` is never issued on a new connection.** `getDb()` sets it; a script that opens
   `new DatabaseSync(path)` directly without the pragma gets no referential integrity.
7. **Someone deletes and recreates the `occupancy` table** (a "clean rebuild" migration). Triggers are
   dropped with the table.

---

## 6. Occupancy and interval semantics

### 6.1 The authoritative conflict predicate

```
conflict(existing, requested)  ⇔  existing.start_at < requested.end_at
                              AND  existing.end_at   > requested.start_at
```

This is the *only* definition of conflict in the system. It appears in:

- `trg_occupancy_no_overlap_insert` and `trg_occupancy_no_overlap_update` (above);
- `findConflicts()` and `inspectUnits()` — `src/server/services/availabilityService.js`;
- `intervalsOverlap(aStart, aEnd, bStart, bEnd)` — `src/server/domain/time.js`;
- `getSpaceDayGrid()`'s per-slot filter.

If these ever disagree, the database is right and the code is wrong, because the database is what commits.

### 6.2 Half-open convention, worked

Intervals are `[start, end)`. The start instant is inside the interval; the end instant is not.

| Existing | Requested | Conflict? | Why |
|---|---|---|---|
| 09:00–11:00 | 11:00–13:00 | **No** | `11:00 > 11:00` is false — they touch, they do not overlap. |
| 09:00–11:00 | 10:59–13:00 | **Yes** | One minute of overlap is overlap. |
| 09:00–11:00 | 08:00–09:00 | **No** | `09:00 > 09:00` is false. |
| 09:00–11:00 | 09:00–11:00 | **Yes** | The identical interval is the maximal conflict. |
| 09:00–11:00 | 10:00–10:30 | **Yes** | Total containment still conflicts. |
| 09:00–11:00 | 08:00–13:00 | **Yes** | Total engulfment still conflicts. |

**The 11:00 example in operational terms.** Room `TRC-MR-01` is booked 09:00–11:00. A new request for
11:00–13:00 is accepted, and the space is genuinely double-booked for zero minutes. Losing this property
would make every back-to-back hand-over impossible and would force staff to book "09:00–10:59" and
"11:01–13:00", leaking a fake two-minute gap into every calendar and every price.

The same convention, in SQLite integer milliseconds, is exact: `11:00` SLST is `05:30Z`, i.e. the epoch
millisecond `businessLocalToEpoch('2026-11-10', '11:00')`. There is no rounding, no floating point and no
DST.

### 6.3 How `buffer_minutes` widens the comparison

`inflate(startAt, endAt, minutes)` returns `{ start: startAt − pad, end: endAt + pad }` where
`pad = minutes × 60 000`. If `pad` is 0 the interval is returned unchanged.

`findConflicts()` and `inspectUnits()` apply the widened window **only to reservation-sourced rows**,
and the raw window to maintenance:

```sql
(
     (o.source = 'MAINTENANCE' AND o.start_at < ?  AND o.end_at > ?  )
  OR (o.source = 'RESERVATION' AND o.start_at < ?  AND o.end_at > ?  )
)
--  params:  endAt, startAt,            window.end, window.start
```

Two consequences:

- **Reservations only.** A buffer never enlarges a maintenance block, so a technician gets exactly the
  window that was scheduled.
- **Symmetric.** Both sides grow, so an earlier booking blocks a later one and a later booking blocks an
  earlier one by the same amount. There is no asymmetry to reason about.

`buffer_minutes` lives on the *space*, so it applies to every reservation on that space. It is **not**
stored on `occupancy`: the claim records the interval the customer actually occupies, and the buffer is
recomputed from the space at every check. If a space's buffer is raised from 0 to 30, existing bookings do
not move, but future edits and creations will be checked with 30 minutes of clearance.

### 6.4 What counts as a conflict, and what does not

| Occupancy row | Counts as a blocker? |
|---|---|
| `status = 'ACTIVE'`, `source = 'RESERVATION'`, reservation `CONFIRMED` | Yes. |
| `status = 'ACTIVE'`, `source = 'RESERVATION'`, reservation `COMPLETED` | Yes — but the interval is in the past, so it can only ever block a past-dated request. |
| `status = 'ACTIVE'`, `source = 'RESERVATION'`, reservation `CANCELLED` | Cannot occur: cancellation releases the rows in the same transaction. `CHECK` and the trigger make the row-level state unambiguous. |
| `status = 'ACTIVE'`, `source = 'MAINTENANCE'`, `maintenance_block.status = 'CANCELLED'` | Cannot occur after the cancel path runs: cancelling releases the block's rows. |
| `status = 'RELEASED'`, any source | **Never.** That is the point of the status. |
| A row excluded by `excludeReservationId` during an edit | No — the edit's own claims are ignored while it re-allocates. |

---

## 7. Retention and lifecycle rules

### 7.1 What happens to a cancelled reservation

1. `reservation.status` becomes `CANCELLED`; `cancelled_by`, `cancelled_at` and `cancellation_reason` are
   populated in the same `UPDATE`.
2. Every `occupancy` row for that reservation moves from `ACTIVE` to `RELEASED`, with `released_at` set.
3. An `audit_log` row records the actor, the reason, and the number of rows released.
4. **Nothing is deleted.** The reservation keeps its reference, its window, its units, its price and its
   reason. The released occupancy rows remain indefinitely.

Why: a cancelled booking is a business event. "Was this room held and then released, and by whom?" must
remain answerable a year later, and revenue reporting must be able to distinguish "never booked" from
"booked then cancelled".

The release is **exactly once** by construction (the `WHERE status = 'CONFIRMED'` guard), so a released
interval can never be double-released, and the count of released rows is an honest, auditable number.

### 7.2 What `reconcileCompletedReservations()` changes

`reconcileCompletedReservations(db, now)`:

- selects every reservation with `status = 'CONFIRMED' AND end_at < now`;
- sets `status = 'COMPLETED'` and `updated_at = now` for each;
- returns the number of rows changed;
- runs inside a single `BEGIN IMMEDIATE` transaction;
- **does not touch `occupancy`.** The rows stay `ACTIVE` because the claim really did happen. This is
  what makes the historical calendar truthful.
- **does not write an audit row.** Reconciliation is a scheduled bookkeeping transition, not a human
  action; adding one audit row per past booking would drown the activity log.

A `COMPLETED` reservation is history. It cannot be cancelled (assumption A6). `updateReservation()` refuses
only `CANCELLED` reservations, so a `COMPLETED` booking is still technically editable — moving its window
re-allocates its claims under the same trigger, which is why a past-dated edit can still be refused with
`DOUBLE_BOOKING_CONFLICT`. In practice the admin UI is expected to offer an explicit "correct this booking"
affordance rather than an edit form; that view does not exist yet.

### 7.3 Maintenance lifecycle

`createMaintenanceBlock()` inserts a `maintenance_block` row and one `occupancy` row per affected unit with
`source = 'MAINTENANCE'` and `reservation_id = NULL`. The insert goes through the same trigger as a
booking, so a maintenance block can never be laid over a confirmed booking — and a booking can never be
laid over a maintenance block.

`cancelMaintenanceBlock()` sets `maintenance_block.status = 'CANCELLED'` and flips the block's occupancy
rows to `RELEASED`. Again, nothing is deleted.

### 7.4 Space and customer lifecycle

- Spaces move `DRAFT → PUBLISHED → ARCHIVED` and back; `restoreSpace()` returns a space to `DRAFT`, never
  straight to `PUBLISHED`. Publishing again re-runs the publish gate.
- **Space deletion is not exposed.** There is no route and no service function that deletes a space, and
  `reservation.space_id` is `ON DELETE RESTRICT`, so a space with any booking is undeletable even if a
  deletion path were added carelessly.
- Customers are never deleted either; `reservation.customer_id` is `ON DELETE RESTRICT`.
- Photographs are the one thing users *can* delete: `deleteImage()` removes the `space_image` row and
  returns the `stored_name` so the caller can unlink the file. If the removed image was the cover, the
  next image in `sort_order` is promoted inside the same transaction, so a space never loses its cover
  while it still has photographs.
- Deactivated `resource_unit` rows are retained. A desk that has ever been bookable keeps its row forever,
  so historical occupancy still points at a real desk.

### 7.5 Sessions and counters

- Sessions are `revoked_at`-stamped on logout and on idle timeout; `purgeExpiredSessions()` deletes rows
  that expired, or that were revoked more than seven days ago.
- `rate_limit_counter` rows are opportunistically pruned by `hit()` — every increment deletes rows whose
  window started more than 24 hours ago. No scheduled job is required.

---

## 8. Migration policy

1. **Forward-only.** There are no `down` migrations and no rollback script. A mistake is corrected by a new
   forward migration, never by rewriting an applied one.
2. **One file per change**, named `NNNN_description.sql`, sorted lexicographically and applied in that
   order (`migrationFiles()` sorts, then skips anything already recorded in `schema_migrations`).
3. **One transaction per file.** `applyMigrations()` wraps each file in `BEGIN IMMEDIATE … COMMIT` and
   records the filename plus `Date.now()` in `schema_migrations` **inside that transaction**. A failing
   migration is rolled back entirely and rethrown as `Migration <file> failed: …`, and nothing is recorded,
   so the next boot retries it from a clean state.
4. **`schema_migrations` is created by the runner**, not by `0001_init.sql`, so a fresh database and an
   existing one take the same code path.
5. **Never edit an applied migration.** Editing `0001_init.sql` after it has been applied changes nothing on
   existing databases and creates a permanent divergence between fresh and existing installs.
   One deliberate exception is recorded here: when the venue locale was corrected from Addis Ababa to
   Colombo, `0001_init.sql`'s currency default was changed from `ETB` to `LKR` **and** the forward
   migration `0003_currency_sri_lanka.sql` was added to upgrade rows in databases that had already been
   seeded under the old default. The forward migration is what keeps existing installs honest; the
   in-place default only affects brand-new databases.
6. **Any new write path must not bypass the triggers.** Concretely, new code that touches inventory must:
   - open with `withWriteTransaction()` (`BEGIN IMMEDIATE`);
   - call the availability service rather than issuing inserts itself;
   - insert `occupancy` rows with `status` and `source` stated explicitly;
   - never insert an `ACTIVE` row outside a transaction that has re-checked availability.
   Inserting occupancy rows directly is permitted only in a test that is *deliberately* exercising the
   trigger.
7. **A migration that drops a trigger, narrows its `WHEN` clause, or changes the inequality operators is a
   correctness change to the defining property of the system.** It must be accompanied by an update to
   this document, to `BOOKING_RULES.md`, and to
   `tests/unit/bookingRulesTraceability.test.js`, which asserts the triggers still exist and still raise
   `DOUBLE_BOOKING_CONFLICT`.
8. **Adding a `CHECK` constraint to an existing table requires a table rebuild** in SQLite (there is no
   `ALTER TABLE … ADD CONSTRAINT`). Do it in a migration that creates a new table, copies rows, drops the
   old one and renames — and reproduce the triggers on the rebuilt table, because dropping a table drops
   its triggers.
9. **Pragmas are part of the contract.** `journal_mode = WAL`, `busy_timeout = 10000`,
   `foreign_keys = ON`, `synchronous = NORMAL` and `trusted_schema = OFF` are set on every connection in
   `getDb()`. A migration must not depend on a pragma that a future connection might not set.

---

## 9. How to verify the schema is intact

These checks are executable and were run against a database created by `applyMigrations()`. Expected
output is shown verbatim.

### 9.1 Referential integrity is intact

```sql
PRAGMA foreign_key_check;   -- expected: no rows
PRAGMA integrity_check;     -- expected: ok
```

Actual output:

```
== integrity_check ==
[ { integrity_check: 'ok' } ]
== foreign_key_check ==
[]
```

`foreign_key_check` returning rows would name a child table and rowid with a broken reference.
Remember: this pragma cannot check `occupancy.maintenance_block_id`, which has no foreign key (§4.5).

### 9.2 The concurrency guard is still installed

```sql
SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name;
```

Actual output:

```
trg_occupancy_no_overlap_insert
trg_occupancy_no_overlap_update
```

Then confirm the bodies still contain the abort:

```sql
SELECT name, sql FROM sqlite_master
 WHERE type = 'trigger' AND name LIKE 'trg_occupancy%';
```

Each body must contain `RAISE(ABORT, 'DOUBLE_BOOKING_CONFLICT')`. A behavioural check is stronger than a
textual one:

```sql
-- should succeed (abutting)
INSERT INTO occupancy (resource_unit_id, space_id, start_at, end_at, status, source, created_at)
VALUES (1, 1, 0, 100, 'ACTIVE', 'MAINTENANCE', 0);
INSERT INTO occupancy (resource_unit_id, space_id, start_at, end_at, status, source, created_at)
VALUES (1, 1, 100, 200, 'ACTIVE', 'MAINTENANCE', 0);

-- should fail with "DOUBLE_BOOKING_CONFLICT"
INSERT INTO occupancy (resource_unit_id, space_id, start_at, end_at, status, source, created_at)
VALUES (1, 1, 150, 250, 'ACTIVE', 'MAINTENANCE', 0);
```

Observed results: the abutting insert succeeded; the overlapping insert was rejected with
`ERR_SQLITE_ERROR` / `errcode 1811` / `message = 'DOUBLE_BOOKING_CONFLICT'`, and the row was not written.
The same experiment on an `UPDATE` that would create an overlap likewise failed and left the row unchanged.

### 9.3 The other invariants fire

| Probe | Observed result |
|---|---|
| `reservation` with `status='CANCELLED'` and no reason | rejected: `CHECK constraint failed: status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL AND trim(cancellation_reason) <> '')` |
| `reservation` with `status='CANCELLED'` and reason `'   '` | rejected by the same `CHECK` |
| `reservation` with `status='CONFIRMED'` and a reason set | allowed — the `CHECK` is a one-way implication by design |
| `reservation` with `end_at = start_at` | rejected: `CHECK constraint failed: end_at > start_at` |
| two reservations sharing an `idempotency_key` | second rejected: `UNIQUE constraint failed: reservation.idempotency_key` |
| two reservations with `idempotency_key = NULL` | both allowed |
| duplicate `reservation.reference` | rejected: `UNIQUE constraint failed: reservation.reference` |
| `occupancy` with `source='RESERVATION'` and `reservation_id IS NULL` | rejected: `CHECK constraint failed: (source = 'RESERVATION') = (reservation_id IS NOT NULL)` |
| `occupancy` with `source='MAINTENANCE'` and a non-null `reservation_id` | rejected by the same `CHECK` |
| a second `space_image` with `is_cover = 1` for one space | rejected: `UNIQUE constraint failed: space_image.space_id` |
| `space` code `s1` when `S1` exists | rejected: `UNIQUE constraint failed: space.code` |
| `DELETE FROM space` while a reservation references it | rejected: `FOREIGN KEY constraint failed` |
| `DELETE FROM resource_unit` | allowed; the unit's `occupancy` rows were cascaded away (0 rows remained) |

### 9.4 The hot availability query is indexed

```sql
EXPLAIN QUERY PLAN
SELECT o.id, o.resource_unit_id, o.start_at, o.end_at, o.source, o.reservation_id,
       o.maintenance_block_id,
       r.reference AS reservation_reference, r.status AS reservation_status,
       c.full_name AS customer_name,
       m.reason AS maintenance_reason,
       u.code AS unit_code, u.label AS unit_label
  FROM occupancy o
  LEFT JOIN reservation r          ON r.id = o.reservation_id
  LEFT JOIN customer c             ON c.id = r.customer_id
  LEFT JOIN maintenance_block m    ON m.id = o.maintenance_block_id
  LEFT JOIN resource_unit u        ON u.id = o.resource_unit_id
 WHERE o.space_id = ?
   AND o.status = 'ACTIVE'
   AND o.resource_unit_id IN (?,?)
   AND (
        (o.source = 'MAINTENANCE' AND o.start_at < ? AND o.end_at > ?)
     OR (o.source = 'RESERVATION' AND o.start_at < ? AND o.end_at > ?)
   )
 ORDER BY o.start_at ASC;
```

Actual plan:

```
SEARCH o USING INDEX ix_occ_space_active (space_id=?)
SEARCH r USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN
SEARCH c USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN
SEARCH m USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN
SEARCH u USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN
```

No `SCAN` appears. The partial index is chosen for the space-and-status predicate, and every join is an
integer-primary-key probe. Two things to note:

- The plan narrows by `space_id` only; the unit filter and the interval predicate are applied as a filter
  over that space's `ACTIVE` rows. For a co-working space with a large `occupancy` history this is the
  intended shape, because the set of `ACTIVE` rows for one space at any moment is small. If a space ever
  accumulated a very large number of simultaneously-active rows, a covering index on
  `(space_id, resource_unit_id, start_at) WHERE status='ACTIVE'` would be the next step.
- The trigger's own probe is likewise indexed:

```
-- EXPLAIN QUERY PLAN SELECT 1 FROM occupancy o
--   WHERE o.resource_unit_id=? AND o.status='ACTIVE' AND o.id<>? AND o.start_at<? AND o.end_at>?
SEARCH o USING INDEX ix_occ_unit_active (resource_unit_id=? AND start_at<?)
```

So each occupancy insert costs one indexed range scan, not a table scan. That is what keeps the
serialised write path short.

### 9.5 The migration ledger is honest

```sql
SELECT name FROM schema_migrations;   -- expected: 0001_init.sql, 0002_blob_columns.sql, 0003_currency_sri_lanka.sql
```

If a migration is missing from this list, it did not run; if a file exists on disk but not in the ledger,
the next `applyMigrations()` will attempt it inside its own transaction (or fail and roll back cleanly).

---

## 10. Schema ↔ service discrepancies found while writing this document

Recorded here so nobody has to rediscover them. Full impact analysis is in `BOOKING_RULES.md` §12 and in
the hand-off report.

1. **`createMaintenanceBlock()` cannot insert its occupancy rows.**
   `src/server/services/bookingService.js:630-641` declares nine columns
   `(resource_unit_id, space_id, start_at, end_at, status, source, reservation_id, maintenance_block_id, created_at)`
   but supplies only seven placeholders, `VALUES (?,?,?,?,?,NULL,NULL,?,?)`, while `stmt.run(...)` passes
   eight arguments. `source` — a `NOT NULL` column — is bound to `NULL`, and the bind count does not match.
   Every call fails with `ERR_SQLITE_ERROR: column index out of range` before any row is written. The
   correct form binds the source: `VALUES (?,?,?,?,?,?,NULL,?,?)`.
2. **`checkBookingRules()` requires the raw `space` row, not the hydrated `Space` object.**
   `src/server/services/availabilityService.js:430` reads `space.open_time` / `space.close_time`, while
   `spaceService.getSpace()` returns camelCase `openTime` / `closeTime`. Passing a hydrated space — the
   natural thing for a route or view to hold — throws `Invalid clock value: undefined`. All current call
   sites happen to pass raw rows, so the defect is latent, but the public contract in `API_CONTRACTS.md` §4
   does not say which shape is expected. This document and `tests/unit/bookingRulesTraceability.test.js`
   both use the raw shape.
3. **`checkBookingRules()` rejects every interval that crosses a `close_time`**, including overnight and
   multi-day windows, even when the space is configured `00:00`–`23:59`. The comment above the loop claims
   it handles multi-day desk rentals. Consequence: `DAY` quantity is always 1 in practice, and `WEEK` /
   `MONTH` rentals cannot be created. See `BOOKING_RULES.md` §12, defect D-2.
4. **`spaceService.syncUnits()` does not do what its closing comment says.** The comment reads
   "Reactivate previously deactivated units before generating brand new ones", but the code always creates
   new codes: setting a desk count 20 → 10 → 20 leaves 30 `resource_unit` rows, ten of them permanently
   `is_active = 0` (`DESK-11`…`DESK-20` retired, `DESK-21`…`DESK-30` created). Counts stay correct because
   availability counts only `is_active = 1` rows, but the table accumulates retired desks and the comment is
   misleading.
5. **`occupancy.maintenance_block_id` has no foreign key** (§4.5). Deliberate or accidental, it is the one
   unenforced relationship in the schema, and `PRAGMA foreign_key_check` will not catch a dangling value.
6. **`checkBookingRules()`'s out-of-hours message names the cursor time, not the offending request.**
   A request from 17:30 to 18:30 on an 08:00–18:00 space is reported as "Requested time 18:00 falls outside
   opening hours", because the loop reports the clock time at which it gave up. The rejection is correct;
   only the wording is imprecise.
