# TRACE upgrade: team, availability, calendar and notifications

This release keeps the internal `NAGARO_*` environment names, the
`nagaro_session` cookie, `data/nagaro.db`, and the package names. Only
user-visible branding changes to **TRACE**.

## Database migrations

Run the normal migration commands before starting the new build:

```powershell
.\tools\npm.cmd run migrate
# Production PostgreSQL:
.\tools\npm.cmd run migrate:postgres
```

- SQLite: `0008_admin_roles_recycle_bin.sql`, `0009_notifications.sql`
- PostgreSQL: `0005_admin_roles_recycle_bin.sql`, `0006_notifications.sql`

Existing `ADMIN` accounts become Super Admins up to the three-seat cap;
extra `ADMIN` and legacy `STAFF` accounts become ordinary Admins. The
storage column remains `role = 'ADMIN'`; `is_super_admin` selects the
application role.

`npm run seed` only seeds the catalogue and requires an existing
administrator. Use `npm run seed -- --demo` (or set
`NAGARO_DEMO_ADMIN_PASSWORD`) to create the documented demo Super Admin
`admin@trace.local` / `TraceDemo2026`; that is development-only. Production
provisions accounts with `npm run provision:postgres` or the bootstrap
variables.

## Roles and recycle bin

- `SUPER_ADMIN` can add, promote/demote, reset, delete and restore accounts.
- `ADMIN` can use the console and change its own password.
- At most **3 active Super Admins**.
- Deleting an account is a 30-day soft delete. The email stays reserved until
  the automatic purge. The last active Super Admin and self-deletion are
  protected. Sessions are revoked on delete/reset.
- The scheduler and server boot purge expired recycle-bin accounts.

## Public availability

`GET /availability` is the public week view. It calls
`GET /api/public/availability/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&space=CODE`
and exposes only counts/instants. Pick a free hour to open
`/spaces/<code>/book?date=...&start=...&end=...` with the booking form
prefilled. The range is capped at 31 days in Sri Lanka Standard Time.

## Admin calendar

`/admin/calendar` supports Day and Week views, drag-to-create, drag-to-move,
edge resize, event drawers, pending requests and payment holds. Every write
goes through the canonical booking service and its database conflict guard.
The no-JavaScript agenda remains available below the grid.

## Notifications and Web Push

### Environment variables

Add these in Vercel **and** in any local `.env` used for push testing:

```text
VAPID_PUBLIC_KEY=<public key>
VAPID_PRIVATE_KEY=<private key>
VAPID_SUBJECT=mailto:ops@your-domain.example
CRON_SECRET=<long random secret>
```

Generate a VAPID pair once:

```powershell
npx web-push generate-vapid-keys
```

`VAPID_SUBJECT` must be a `mailto:` or `https:` identity. The public key is
served to the admin browser; the private key never leaves the server.

### Reminder scheduler

The secured endpoint is:

```text
GET|POST /api/internal/notifications/tick
Authorization: Bearer <CRON_SECRET>
```

It creates 30-minute room-preparation reminders, dispatches pending Web Push,
sends reminder email fallback when SMTP is configured, prunes failed
subscriptions, and purges expired recycle-bin accounts.

- **Vercel Pro:** add a Vercel Cron for that path every five minutes. The
  `CRON_SECRET` environment variable is sent by Vercel as a bearer token.
- **Vercel Hobby:** use an external scheduler (for example cron-job.org,
  GitHub Actions, or a monitoring service) to GET the endpoint every five
  minutes with the same bearer header. Vercel Hobby does not support
  five-minute cron jobs.

`vercel.json` deliberately does not declare the five-minute cron so a Hobby
deployment cannot fail validation. Add it only after confirming the plan.

Set `NAGARO_ALLOW_INSECURE_CRON=1` only for local development when no secret is
configured. Never enable it in production.

### Email fallback

Reminder email uses the existing SMTP settings (`SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) and
`NAGARO_ADMIN_NOTIFICATION_EMAIL`. Without SMTP the in-app notification and
Web Push still work.

### Browser support

Web Push requires HTTPS (localhost is exempt), a supported browser, and a
user gesture to enable desktop alerts. On iPhone/iPad the admin site must be
added to the Home Screen as a PWA before Safari can receive push. If the
browser is fully quit, delivery is controlled by the operating system; the
reminder email is the explicit fallback.

## UX changes

- The booking-request inbox has status tabs, search, request cards, one-click
  approval, collapsible rejection/payment forms and collapsible fee settings.
- The reservation ledger keeps status tabs visible and collapses advanced
  filters, with Today / Next 7 days shortcuts.
- The dashboard has task shortcuts and collapsed secondary metrics.
- The admin header has global search (two-character minimum). It groups spaces,
  customers, reservations, requests and inquiries and focuses with `/` or
  `Ctrl/Cmd+K`.
- Space list rows expose inline publish, unpublish, archive and restore actions
  without opening the edit page.
- The booking form keeps a sticky availability/price panel on desktop.
