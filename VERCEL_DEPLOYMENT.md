# Vercel deployment checklist

This repository deploys as **one Vercel project from the repository root**.
Next.js owns public pages and `api/index.js` owns the booking engine, staff
console, assets and media routes.

> **Root Directory is non-negotiable:** leave it blank (repository root) or set
> it to `.`. Do not select `apps/public-web`. The backend function, migrations,
> verified TRACE media, and root dependency workspace all live above that
> folder. A build path containing `apps/public-web/apps/public-web` proves that
> the Vercel project Root Directory is wrong or that an old dashboard command
> override is still active.

## Required Vercel environment variables

Set these for **Production** and for any Preview deployment that must use real
persistent data:

| Variable | Required value |
|---|---|
| `DATABASE_URL` | Supabase **transaction pooler** connection string (port `6543`) with `sslmode=require`. |
| `BLOB_READ_WRITE_TOKEN` | Token created when a Vercel Blob store is connected to this Vercel project. |
| `NAGARO_BASE_URL` | Canonical deployed URL, for example `https://spaces.example.com`. Required so private booking and inquiry links use the correct public origin. |
| `NAGARO_IP_SALT` | A long random secret used to hash IP addresses. Generate once and keep it stable. |
| `NAGARO_TRUST_PROXY` | `1` on Vercel so rate limiting uses Vercel's forwarded client address. |
| `NAGARO_FORCE_SECURE_COOKIES` | `1` so staff session and CSRF cookies are always Secure. |

The first administrator is created by the provisioning command below. Set
these variables on the trusted machine for that one command; they do not need
to remain in Vercel after the account exists:

- `NAGARO_BOOTSTRAP_ADMIN_EMAIL`
- `NAGARO_BOOTSTRAP_ADMIN_PASSWORD`
- `NAGARO_BOOTSTRAP_ADMIN_NAME`

`VERCEL`, `VERCEL_URL`, `NODE_ENV` and the deployment hostname variables are
provided by Vercel automatically. Do not add `DIRECT_URL` to Vercel unless a
separate controlled migration job actually needs it.

## Optional email variables

The app safely records inquiries without SMTP, but delivery is marked
`NOT_CONFIGURED`. To send notifications, set:

- `SMTP_HOST`
- `SMTP_PORT` (normally `587`)
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_SECURE` (`0` for STARTTLS on port 587, `1` for implicit TLS)
- `SMTP_FROM`
- `NAGARO_ADMIN_NOTIFICATION_EMAIL`

## Optional Guider and payment variables

Guider remains available as a factual catalogue fallback without an AI key.
To enable grounded conversational answers, set these server-side variables and
add public Markdown from **Admin â†’ Guider knowledge**:

- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL` (for example `openai/gpt-4.1-mini`)

To collect a configured registration fee and let visitors add an optional
advance toward the remaining venue balance, set:

- `PAYHERE_MERCHANT_ID`
- `PAYHERE_MERCHANT_SECRET`
- `PAYHERE_MODE` (`sandbox` until PayHere approves the production domain, then `live`)

The registration-fee policy is managed in **Admin â†’ Booking requests**.
Venue prices remain editable per hour, half-day, day, week or month in
**Admin â†’ Spaces â†’ Edit rates**.

## Supabase setup

1. Create the Supabase project and copy both connection strings from **Connect**.
2. On a trusted local machine, set `DIRECT_URL` to the direct or session-pooler
   URL, plus the three `NAGARO_BOOTSTRAP_ADMIN_*` values, and run
   `npm run provision:postgres`. This applies the versioned migrations, creates
   the first administrator only when none exists, and idempotently creates the
   five production catalogue spaces without demo bookings or placeholder image
   rows. It is safe to rerun.
3. Put only the transaction-pooler URL (port `6543`, TLS required) in Vercel as
   `DATABASE_URL`. Do not copy `DIRECT_URL` into the Vercel project.
   If Supabase's connection panel gave you its standard names
   (`POSTGRES_PRISMA_URL`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, …), the
   application still reads `DATABASE_URL`: add it and copy the **transaction
   pooler** value (`POSTGRES_PRISMA_URL`, port 6543, `pgbouncer=true`) into it.
4. The API verifies `public.space` and the `occupancy_no_overlap` GiST exclusion
   constraint on cold start and refuses to serve against a partial schema.
5. TLS note: current node-postgres treats `sslmode=require` as `verify-full`, and
   the Supabase pooler's certificate chain is not in Node's bundled trust store,
   which fails the handshake before the first query. `src/server/db/pgSsl.js`
   normalises this: connections are always encrypted, chain verification is only
   enforced when you ask for `sslmode=verify-full`/`verify-ca`.

Example in PowerShell (values are placeholders):

```powershell
$env:DIRECT_URL='postgresql://...:5432/postgres?sslmode=require'
$env:NAGARO_BOOTSTRAP_ADMIN_EMAIL='ops@example.com'
$env:NAGARO_BOOTSTRAP_ADMIN_PASSWORD='use-a-long-unique-password'
$env:NAGARO_BOOTSTRAP_ADMIN_NAME='TRACE Operations'
npm run provision:postgres
```

Do not enable `NAGARO_ALLOW_EPHEMERAL_SQLITE` for production. It exists only for
throwaway preview demonstrations and loses data whenever the function instance
is recycled.

## Vercel Blob setup

Create or connect a **public** Blob store to the same Vercel project. Vercel
adds `BLOB_READ_WRITE_TOKEN` automatically. Space photos are validated by magic
bytes before upload, stored with random suffixes, and their Blob URLs are saved
in `space_image`. Failed database writes remove their uploaded Blob, and deleting
an image removes both the row and Blob object.

## Vercel project settings

- Import the GitHub repository and keep **Root Directory** blank / `.` (the
  repository root), never `apps/public-web`.
- Framework Preset: **Next.js**.
- Clear dashboard overrides for **Install Command**, **Build Command**, and
  **Output Directory**. The repository config uses Vercel's automatic npm
  workspace install, `npm run build`, and `apps/public-web/.next` respectively.
- Node.js: `24.x` (also pinned by the root `package.json`).
- Deploy after the Supabase migration has completed.

The npm warning about Vercel's internal `cache-dir` setting is non-fatal and is
not produced by this repository. The actual install must run once at
`/vercel/path0`; it must not run from `/vercel/path0/apps/public-web`.

`outputFileTracingIncludes` intentionally does not appear in `vercel.json`; it
is a Next.js option, not a valid top-level Vercel project key. The API function's
own files are included with its supported `functions.api/index.js.includeFiles`
configuration, while the Next app sets its tracing root in `next.config.mjs`.

Before deploying, run:

```bash
npm ci
npm run verify:vercel
npm run build
```

After `vercel env pull`, `npm run verify:vercel -- --require-env` checks the
required variable names and production security flags without printing secret
values.

## Release smoke test

After deployment, verify `/`, `/spaces`, one venue detail page, direct booking,
registration-fee checkout with and without an optional advance, the private
management link, cancellation, `/admin`, a staff login, a venue-rate edit, an
image upload, a Guider Markdown upload and an inquiry. Ask Guider one question
answered by that Markdown. Confirm that a second overlapping booking is rejected
and that the paid advance is deducted from the remaining balance.
