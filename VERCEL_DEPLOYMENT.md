# Vercel deployment checklist

This repository deploys as one Vercel project from the repository root. Next.js
owns public pages and `api/index.js` owns the booking engine, staff console,
assets and media routes.

## Required Vercel environment variables

Set these for **Production** and for any Preview deployment that must use real
persistent data:

| Variable | Required value |
|---|---|
| `DATABASE_URL` | Supabase **transaction pooler** connection string (port `6543`) with `sslmode=require`. |
| `BLOB_READ_WRITE_TOKEN` | Token created when a Vercel Blob store is connected to this Vercel project. |
| `NAGARO_BASE_URL` | Canonical deployed URL, for example `https://spaces.example.com`. |
| `NAGARO_IP_SALT` | A long random secret used to hash IP addresses. Generate once and keep it stable. |
| `NAGARO_TRUST_PROXY` | `1` on Vercel so rate limiting uses Vercel's forwarded client address. |
| `NAGARO_FORCE_SECURE_COOKIES` | `1` so staff session and CSRF cookies are always Secure. |
| `NAGARO_BOOTSTRAP_ADMIN_EMAIL` | First staff administrator email. Used only while no human administrator exists. |
| `NAGARO_BOOTSTRAP_ADMIN_PASSWORD` | Strong first administrator password. Remove from Vercel after the account is created. |
| `NAGARO_BOOTSTRAP_ADMIN_NAME` | Display name for the first administrator. |

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

## Supabase setup

1. Create the Supabase project and copy both connection strings from **Connect**.
2. On a trusted local machine, set `DIRECT_URL` to the direct/session-pooler URL
   and run `npm run migrate:postgres` once. The command records applied files in
   `schema_migrations` and is safe to rerun.
3. Put only the transaction-pooler URL in Vercel as `DATABASE_URL`.
4. Verify that `public.space` exists and that the `occupancy_no_overlap` GiST
   exclusion constraint exists before accepting bookings. The API refuses to
   boot if either guard is missing.

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

- Import the GitHub repository and keep **Root Directory** at the repository root.
- Framework Preset: **Next.js**.
- Build and output settings come from `vercel.json`; do not override them in the
  dashboard unless deliberately replacing the checked-in configuration.
- Node.js: `24.x` (the repository engine range is compatible).
- Deploy after the Supabase migration has completed.

`outputFileTracingIncludes` intentionally does not appear in `vercel.json`; it
is a Next.js option, not a valid top-level Vercel project key. The API function's
own files are included with its supported `functions.api/index.js.includeFiles`
configuration, while the Next app sets its tracing root in `next.config.mjs`.

## Release smoke test

After deployment, verify `/`, `/spaces`, one venue detail page, a direct booking,
the private management link, cancellation, `/admin`, a staff login, an image
upload, and an inquiry. Confirm that a second overlapping booking is rejected.
