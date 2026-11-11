# Smart booking access

Customers get a private link (`/access/<token>`) by email and SMS when a booking
is confirmed. During the booking it unlocks and locks their room's door. After
the booking it shows "Your booking has ended" with a paid 15-minute extension
and a "Get Staff Assistance" button.

## Setup checklist

| What | Environment variables |
| --- | --- |
| Email (Resend) | `RESEND_API_KEY`, `RESEND_FROM` (address on a domain verified in Resend) |
| SMS (Twilio) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (or `TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET`), and `TWILIO_MESSAGING_SERVICE_SID` **or** `TWILIO_FROM_NUMBER` |
| Door controllers | `DOOR_CONTROLLER_SECRET` (16+ random characters) |
| Online extension payments | the existing `PAYHERE_MERCHANT_ID` / `PAYHERE_MERCHANT_SECRET` |
| Scheduler (serverless only) | `CRON_SECRET`, plus a per-minute call to `/api/internal/access/tick` |
| Links in messages | `NAGARO_BASE_URL` must be the public https address |

Then, in the console, **Door access → Settings**: set the policy and, for each
room, choose the controller type, its URL and door identifier, and tick
"Enable door control". **Settings → Connections** shows which of the above
are missing.

Run the migrations (`npm run migrate`, or `npm run migrate:postgres` for
Supabase). They add `0010_booking_access.sql` / `0007_booking_access.sql`.

### Sri Lanka SMS note

Twilio needs a sender that is allowed for Sri Lankan numbers. An alphanumeric
sender ID (for example `TRACE`) usually has to be registered first. Use a
Messaging Service so you can change senders without redeploying. Local numbers
such as `077 123 4567` are converted to `+94771234567` automatically
(`SMS_DEFAULT_COUNTRY_CODE`, default `94`).

## The automatic-lock rule

Every unlock stores a deadline in `door_state.auto_lock_at`:

    deadline = min(now + chosen minutes, booking end)

"Keep unlocked until booking ends" uses the booking end. There is no unlock
without a deadline, for customers or staff.

The deadline is a database row, not a timer. Due rows become a single
`SYSTEM` CLOSE command. Its idempotency key is derived from the door and the
deadline, so duplicate scheduler runs collapse into one. The command is sent
under a lease, so two app instances never send it twice. A failed CLOSE is
retried six times with back-off, then once every 10 minutes for an hour, and
staff get a high-priority "Door did not confirm locking" alert. The deadline
is cleared only when the controller accepts the CLOSE.

What runs the schedule:

- **A long-running Node server** (`npm start`) polls every 10 seconds by itself.
- **Vercel / serverless**: something must call
  `GET /api/internal/access/tick` with `Authorization: Bearer $CRON_SECRET`
  **every minute**. Vercel Cron on the Pro plan can do this
  (`"schedule": "* * * * *"`); on Hobby use an external pinger such as
  cron-job.org. Customer and staff page loads also run due work, but do not
  rely on that alone.

### Hardware limitation (read this)

The server can only *ask* a door to lock. If the controller loses power or
network while unlocked, no software can lock it. For a hard guarantee, use a
controller that honours the `autoLockAt` field it receives with every OPEN and
locks locally at that time. A fail-secure lock or a relay timer also works.
The console never claims "Locked" or "Unlocked" unless the controller said so.
A controller with "confirms the lock state" turned off shows "sent", not a state.

## Door controller contract (HTTP driver)

Request sent for every command:

    POST <controller URL>
    Content-Type: application/json
    X-Nagaro-Timestamp: <epoch ms>
    X-Nagaro-Signature: sha256=<hex HMAC-SHA256(DOOR_CONTROLLER_SECRET, timestamp + "." + body)>

    {"commandId":"42","door":"MR01","action":"OPEN","autoLockAt":1794409928090,
     "validUntil":1794406358469,"issuedAt":1794406338469}

The controller should:

- verify the signature;
- reject the command when `now > validUntil`;
- on OPEN, lock by itself at `autoLockAt`;
- answer `200 {"ok":true,"state":"UNLOCKED"|"LOCKED"}` with the real state
  after acting. A 2xx without `state` counts as "sent, unconfirmed". Answer
  `{"ok":false,"error":"..."}` or a non-2xx status to refuse.

Optional state reports (heartbeat, a physical key used, a late confirmation):

    POST /api/internal/door/status   (same two signature headers)
    {"door":"MR01","state":"LOCKED","commandId":"42"}

An unexpected "UNLOCKED" with no unlock in force raises a staff alert.

For a demo without hardware, set `NAGARO_DOOR_SIMULATOR=1` and choose
"Simulator". It never operates a real door and cannot be selected otherwise.

## Extensions

**Price.** `hourly rate ÷ 4 × (1 + surcharge%)`, in integer cents, rounded half
up. With a 1,000 LKR hourly rate and a 20% surcharge, the price is 300 LKR.

Rooms without an hourly rate use the half-day rate ÷ 4. Failing that, they use
the day rate ÷ opening hours. A room can also set a fixed 15-minute base price;
the surcharge still applies on top. Rooms booked with several desks or seats
pay per unit. The minimum-payment setting is a floor.

**Availability.** Starting an extension writes real `occupancy` rows for the
extra 15 minutes. The database's existing double-booking guard therefore stops
anyone else, including another booking or another extension, from taking those
minutes. The hold expires after the "hold the room while paying" setting (10
minutes by default). It is released on failure, cancellation or expiry.

**Payment.** Only a signed PayHere server notification for the exact amount
and currency extends the booking. Repeated notifications are ignored; a forged
one is rejected and logged. The return page never counts as payment, and
payment never unlocks the door. The customer taps Unlock again.

**Late payment.** The 15 minutes are counted from the later of the booking end
and the moment payment is verified. If the room is no longer free that long,
the originally held interval is used, as long as no more than the
"late-payment tolerance" (default 5 minutes) was lost.

**Paid but no time available.** This includes an amount mismatch, the room
being taken, the booking being cancelled, a second payment for the same order,
or a chargeback. The extension becomes *Payment review*, the hold is released
and staff get a high-priority alert. The customer sees "We received your
payment but could not add the time".

In **Door access → Extensions needing attention**, staff then refund in the
PayHere portal and record it, add the time if the room is now free, or record
that the payment was kept. Every step is in the audit log.

Other options in the policy: staff approval before payment, front-desk payment
(staff confirm the cash before time is added), maximum extensions and minutes
per booking, and how long before or after the end extensions are offered.

## Security notes

- Tokens are 32 random bytes. Only their SHA-256 hash is stored. The raw token
  is kept just long enough to send the email and SMS, then erased.
- API calls carry the token in an `X-Access-Token` header, never a query string.
- Access pages are `no-store`, `Referrer-Policy: no-referrer`, `noindex` and use
  a strict Content Security Policy. The PayHere return URL contains no token: an
  HttpOnly cookie scoped to `/access` brings the customer back.
- Wrong tokens are rate-limited per IP. Door, extension and assistance actions
  are rate-limited per link.
- Optional: "Ask for the last 4 digits of the booking phone number" adds a
  per-device check before door controls appear.
- Staff can, from the reservation page, turn off door access while keeping the
  page, revoke the link, or send a new link (the old one stops working).
