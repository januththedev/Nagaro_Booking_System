/**
 * Notification email content.
 *
 * Deliberately customer-name free: this message is the email fallback for a
 * room-preparation reminder, and it may land in a shared operations mailbox.
 * Reference, space code, time and the admin link are sufficient to act.
 */
import { businessDateTimeLabel, businessTimeLabel } from '../domain/time.js';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanSubject(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
}

/**
 * Render the 30-minute room-preparation reminder.
 *
 * @param {object} input
 * @param {object} input.reservation `{ id, reference, startAt, endAt }`
 * @param {object} input.space       `{ code, name }`
 * @param {string} input.adminUrl    absolute (or root-relative) admin link
 */
export function reminderEmail({ reservation, space, adminUrl }) {
  const reference = String(reservation?.reference ?? '').trim() || 'reservation';
  const code = String(space?.code ?? '').trim();
  const spaceName = String(space?.name ?? '').trim();
  const start = Number(reservation?.startAt);
  const end = Number(reservation?.endAt);
  const timeText = Number.isFinite(start) && Number.isFinite(end)
    ? `${businessDateTimeLabel(start)} to ${businessTimeLabel(end)} (Sri Lanka Standard Time)`
    : 'Time shown in the admin console';
  const link = String(adminUrl ?? '').trim();

  const subject = cleanSubject(
    `Room prep in 30 minutes · ${code || spaceName || reference} · ${Number.isFinite(start) ? businessTimeLabel(start) : ''}`
      .replace(/\s+·\s+$/, ''),
  );

  const lines = [
    `Room preparation reminder`,
    '',
    `Space: ${spaceName || '—'}${code ? ` (${code})` : ''}`,
    `When: ${timeText}`,
    `Reference: ${reference}`,
    '',
    'Please make sure the room or desk is ready before the booking starts.',
    '',
    link ? `Open the reservation: ${link}` : 'Open the admin console to view the reservation.',
    '',
    'Desktop alerts need a browser that supports Web Push. If the browser was fully quit, or this is an iPhone/iPad, install the admin site to the Home Screen to receive push alerts. This email is the fallback for that case.',
    '',
    '— TRACE Spaces operations',
  ];

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px;background:#faf7f1;color:#171b18;font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fffdf8;border:1px solid #e2dac8;border-radius:10px">
    <tr><td style="padding:20px 24px;border-bottom:1px solid #e2dac8">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#9a6a1a">TRACE Spaces · Operations</p>
      <h1 style="margin:0;font-size:21px;line-height:1.3">Room prep in 30 minutes</h1>
    </td></tr>
    <tr><td style="padding:20px 24px">
      <p style="margin:0 0 12px;font-size:16px"><strong>${esc(spaceName || 'Reserved space')}</strong>${code ? ` <span style="color:#55605a">(${esc(code)})</span>` : ''}</p>
      <p style="margin:0 0 8px"><strong>When:</strong> ${esc(timeText)}</p>
      <p style="margin:0 0 16px"><strong>Reference:</strong> ${esc(reference)}</p>
      <p style="margin:0 0 18px">Please make sure the room or desk is ready before the booking starts.</p>
      ${link ? `<p style="margin:0 0 18px"><a href="${esc(link)}" style="display:inline-block;background:#0b3d2e;color:#fffdf8;text-decoration:none;padding:10px 16px;border-radius:6px">Open the reservation</a></p>` : ''}
      <p style="margin:0;font-size:12px;line-height:1.5;color:#55605a">Desktop alerts need a browser that supports Web Push. If the browser was fully quit, or this is an iPhone/iPad, install the admin site to the Home Screen to receive push alerts. This email is the fallback for that case.</p>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text: lines.join('\n'), html };
}
