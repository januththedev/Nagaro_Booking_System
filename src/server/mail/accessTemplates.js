/**
 * Customer messages for the smart-access feature: the access link (email and
 * SMS) and the extension receipt. Deliberately short and free of technical
 * detail; the link itself is the only secret and appears nowhere else.
 */
import { BUSINESS_TZ } from '../domain/time.js';

const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, hour: 'numeric', minute: '2-digit', hour12: true });

export function accessDateLabel(epochMs) { return dateFormat.format(new Date(Number(epochMs))); }
export function accessTimeLabel(epochMs) { return timeFormat.format(new Date(Number(epochMs))); }

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function cleanSubject(value) { return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200); }
function firstName(name) { return String(name ?? '').trim().split(/\s+/)[0] || 'there'; }
export function formatLkr(cents, currency = 'LKR') {
  const value = Math.round(Number(cents) || 0);
  const whole = Math.trunc(value / 100).toLocaleString('en-US');
  return `${currency} ${whole}.${String(Math.abs(value % 100)).padStart(2, '0')}`;
}

function frame({ eyebrow, heading, bodyHtml }) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:24px;background:#faf7f1;color:#171b18;font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fffdf8;border:1px solid #e2dac8;border-radius:10px">
    <tr><td style="padding:20px 24px;border-bottom:1px solid #e2dac8">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#9a6a1a">${esc(eyebrow)}</p>
      <h1 style="margin:0;font-size:21px;line-height:1.3">${esc(heading)}</h1>
    </td></tr>
    <tr><td style="padding:20px 24px">${bodyHtml}</td></tr>
  </table>
</body>
</html>`;
}

/**
 * @param {object} input
 * @param {string} input.customerName
 * @param {string} input.spaceName
 * @param {number} input.startAt / input.endAt  epoch ms
 * @param {string} input.url        the private access link
 * @param {boolean} input.doorControl  whether this room has an electronic door
 */
export function accessLinkEmail({ customerName, spaceName, reference, startAt, endAt, url, doorControl }) {
  const date = accessDateLabel(startAt);
  const window = `${accessTimeLabel(startAt)} to ${accessTimeLabel(endAt)}`;
  const how = doorControl
    ? 'Open the link on your phone when you arrive. During your booking you can unlock and lock the door of your room from that page. If you need more time, you can add 15 minutes there, or ask our staff for help.'
    : 'Open the link on your phone during your visit to see your booking, add 15 more minutes if you need them, or ask our staff for help.';
  const subject = cleanSubject(`Your room access link · ${spaceName} · ${date}`);
  const text = [
    `Hi ${firstName(customerName)},`,
    '',
    `Your booking is confirmed.`,
    '',
    `Room: ${spaceName}`,
    `Date: ${date}`,
    `Time: ${window} (Sri Lanka time)`,
    reference ? `Booking: ${reference}` : null,
    '',
    `Your room access link:`,
    url,
    '',
    how,
    '',
    'This link is personal to your booking. Please do not share it.',
    '',
    '— TRACE Spaces',
  ].filter((line) => line !== null).join('\n');
  const html = frame({
    eyebrow: 'TRACE Spaces · Booking confirmed',
    heading: 'Your room access link',
    bodyHtml: `
      <p style="margin:0 0 14px">Hi ${esc(firstName(customerName))}, your booking is confirmed.</p>
      <p style="margin:0 0 6px"><strong>Room:</strong> ${esc(spaceName)}</p>
      <p style="margin:0 0 6px"><strong>Date:</strong> ${esc(date)}</p>
      <p style="margin:0 0 ${reference ? '6' : '18'}px"><strong>Time:</strong> ${esc(window)} <span style="color:#55605a">(Sri Lanka time)</span></p>
      ${reference ? `<p style="margin:0 0 18px"><strong>Booking:</strong> ${esc(reference)}</p>` : ''}
      <p style="margin:0 0 18px"><a href="${esc(url)}" style="display:inline-block;background:#0b3d2e;color:#fffdf8;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600">Open room access</a></p>
      <p style="margin:0 0 14px;line-height:1.5">${esc(how)}</p>
      <p style="margin:0;font-size:12px;line-height:1.5;color:#55605a">This link is personal to your booking. Please do not share it.</p>`,
  });
  return { subject, text, html };
}

export function accessLinkSms({ customerName, spaceName, startAt, endAt, url }) {
  return `TRACE Spaces: Hi ${firstName(customerName)}, your booking for ${spaceName} on ${accessDateLabel(startAt)}, `
    + `${accessTimeLabel(startAt)}-${accessTimeLabel(endAt)} is confirmed. Room access: ${url}`;
}

export function extensionReceiptEmail({ customerName, spaceName, reference, minutes, newEndAt, amountCents, currency, method, orderId }) {
  const paid = method === 'COMPLIMENTARY' ? 'No charge' : formatLkr(amountCents, currency);
  const subject = cleanSubject(`Session extended · ${spaceName} · until ${accessTimeLabel(newEndAt)}`);
  const text = [
    `Hi ${firstName(customerName)},`,
    '',
    `${minutes} minutes have been added to your booking.`,
    '',
    `Room: ${spaceName}`,
    `New end time: ${accessTimeLabel(newEndAt)} on ${accessDateLabel(newEndAt)} (Sri Lanka time)`,
    `Amount: ${paid}${method === 'DESK' ? ' (paid at the front desk)' : ''}`,
    reference ? `Booking: ${reference}` : null,
    orderId ? `Receipt reference: ${orderId}` : null,
    '',
    'Your room access link works until the new end time.',
    '',
    '— TRACE Spaces',
  ].filter((line) => line !== null).join('\n');
  const html = frame({
    eyebrow: 'TRACE Spaces · Receipt',
    heading: 'Your session has been extended',
    bodyHtml: `
      <p style="margin:0 0 14px">Hi ${esc(firstName(customerName))}, ${esc(String(minutes))} minutes have been added to your booking.</p>
      <p style="margin:0 0 6px"><strong>Room:</strong> ${esc(spaceName)}</p>
      <p style="margin:0 0 6px"><strong>New end time:</strong> ${esc(accessTimeLabel(newEndAt))} on ${esc(accessDateLabel(newEndAt))}</p>
      <p style="margin:0 0 6px"><strong>Amount:</strong> ${esc(paid)}${method === 'DESK' ? ' (paid at the front desk)' : ''}</p>
      ${reference ? `<p style="margin:0 0 6px"><strong>Booking:</strong> ${esc(reference)}</p>` : ''}
      ${orderId ? `<p style="margin:0 0 6px"><strong>Receipt reference:</strong> ${esc(orderId)}</p>` : ''}
      <p style="margin:14px 0 0;line-height:1.5">Your room access link works until the new end time.</p>`,
  });
  return { subject, text, html };
}

export function extensionReceiptSms({ spaceName, minutes, newEndAt, amountCents, currency, method }) {
  const paid = method === 'COMPLIMENTARY' ? '' : ` Paid ${formatLkr(amountCents, currency)}.`;
  return `TRACE Spaces: ${minutes} minutes added to your booking for ${spaceName}. New end time ${accessTimeLabel(newEndAt)}.${paid}`;
}
