/**
 * Plain transactional email content for booking inquiries.
 *
 * Deliberately self-contained: no web view imports, no external assets, no
 * tracking pixels. Every interpolated value is HTML-escaped by the local
 * `esc()` helper before it reaches the HTML variant.
 */
import { businessDateTimeLabel, formatDuration } from '../domain/time.js';
import { SPACE_CATEGORY, SPACE_CATEGORY_LABEL } from '../domain/constants.js';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveBaseUrl(baseUrl) {
  const raw = String(baseUrl || process.env.NAGARO_BASE_URL || '').trim() || 'http://localhost:4173';
  return raw.replace(/\/+$/, '');
}

function startOf(inquiry) {
  return inquiry.startAt ?? inquiry.requested_start_at ?? null;
}

function endOf(inquiry) {
  return inquiry.endAt ?? inquiry.requested_end_at ?? null;
}

function windowText(inquiry) {
  const start = startOf(inquiry);
  const end = endOf(inquiry);
  if (start === null || end === null) return 'Not specified';
  return `${businessDateTimeLabel(start)} to ${businessDateTimeLabel(end)} (East Africa Time)`;
}

function durationText(inquiry) {
  const start = startOf(inquiry);
  const end = endOf(inquiry);
  return start === null || end === null ? null : formatDuration(start, end);
}

function spaceNameOf(inquiry, space) {
  return space?.name ?? inquiry.spaceName ?? 'the requested space';
}

function spaceLine(inquiry, space) {
  const name = spaceNameOf(inquiry, space);
  const code = space?.code ?? inquiry.spaceCode ?? null;
  const category = space?.category ?? inquiry.category ?? null;
  const categoryLabel = SPACE_CATEGORY_LABEL[category] ?? null;
  const parts = [name];
  if (code) parts.push(`(${code})`);
  if (categoryLabel) parts.push(`- ${categoryLabel}`);
  return parts.join(' ');
}

function quantityLines(inquiry, space) {
  const lines = [];
  if (inquiry.attendees !== null && inquiry.attendees !== undefined) {
    const capacity = space?.capacity ? ` (space capacity ${space.capacity})` : '';
    lines.push(`Attendees: ${inquiry.attendees}${capacity}`);
  }
  if (
    (space?.category === SPACE_CATEGORY.COWORKING || inquiry.deskQuantity !== null)
    && inquiry.deskQuantity !== null
    && inquiry.deskQuantity !== undefined
  ) {
    lines.push(`Desks requested: ${inquiry.deskQuantity}`);
  }
  return lines;
}

function contactLines(inquiry) {
  const lines = [`Name: ${inquiry.customerName ?? ''}`, `Email: ${inquiry.email ?? ''}`];
  if (inquiry.phone) lines.push(`Phone: ${inquiry.phone}`);
  if (inquiry.organization) lines.push(`Organization: ${inquiry.organization}`);
  return lines;
}

function withdrawUrl(inquiry, baseUrl) {
  if (!inquiry.withdrawToken) return null;
  return `${resolveBaseUrl(baseUrl)}/booking-request/withdraw`
    + `?ref=${encodeURIComponent(inquiry.reference ?? '')}`
    + `&token=${encodeURIComponent(inquiry.withdrawToken)}`;
}

function adminUrl(inquiry, baseUrl) {
  if (inquiry.id === null || inquiry.id === undefined) return null;
  return `${resolveBaseUrl(baseUrl)}/admin/inquiries/${encodeURIComponent(String(inquiry.id))}`;
}

/**
 * Staff notification: a new request-to-book arrived.
 * @returns {{subject: string, text: string, html: string}}
 */
export function inquiryNotificationEmail({ inquiry, space = null, baseUrl = null } = {}) {
  const reference = inquiry.reference ?? '(new inquiry)';
  const subject = `New booking request ${reference} - ${spaceNameOf(inquiry, space)}`;
  const reviewUrl = adminUrl(inquiry, baseUrl);
  const duration = durationText(inquiry);
  const quantities = quantityLines(inquiry, space);
  const contact = contactLines(inquiry);
  const message = inquiry.message ? String(inquiry.message) : null;

  const textLines = [
    'A new booking request has been submitted.',
    '',
    `Reference: ${reference}`,
    `Space: ${spaceLine(inquiry, space)}`,
    `Requested window: ${windowText(inquiry)}`,
  ];
  if (duration) textLines.push(`Duration: ${duration}`);
  textLines.push(...quantities);
  textLines.push('', 'Visitor', ...contact);
  if (message) textLines.push('', 'Message from the visitor:', message);
  textLines.push('', 'This request is provisional and does not reserve inventory.');
  if (reviewUrl) textLines.push(`Review it in the admin area: ${reviewUrl}`);

  const quantityRows = quantities
    .map((line) => {
      const [label, ...rest] = line.split(':');
      return `<tr><th align="left" style="padding:4px 12px 4px 0;">${esc(label)}</th><td>${esc(rest.join(':').trim())}</td></tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:8px;">
      <tr>
        <td style="padding:24px;">
          <h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;">New booking request</h1>
          <p style="margin:0 0 20px;color:#57534e;">A visitor has asked to book a space. This request is provisional and does not reserve inventory.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.5;">
            <tr><th align="left" style="padding:4px 12px 4px 0;">Reference</th><td>${esc(reference)}</td></tr>
            <tr><th align="left" style="padding:4px 12px 4px 0;">Space</th><td>${esc(spaceLine(inquiry, space))}</td></tr>
            <tr><th align="left" style="padding:4px 12px 4px 0;">Requested window</th><td>${esc(windowText(inquiry))}</td></tr>
            ${duration ? `<tr><th align="left" style="padding:4px 12px 4px 0;">Duration</th><td>${esc(duration)}</td></tr>` : ''}
            ${quantityRows}
          </table>
          <h2 style="margin:24px 0 8px;font-size:16px;">Visitor</h2>
          <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.5;">
            <tr><th align="left" style="padding:4px 12px 4px 0;">Name</th><td>${esc(inquiry.customerName)}</td></tr>
            <tr><th align="left" style="padding:4px 12px 4px 0;">Email</th><td>${esc(inquiry.email)}</td></tr>
            ${inquiry.phone ? `<tr><th align="left" style="padding:4px 12px 4px 0;">Phone</th><td>${esc(inquiry.phone)}</td></tr>` : ''}
            ${inquiry.organization ? `<tr><th align="left" style="padding:4px 12px 4px 0;">Organization</th><td>${esc(inquiry.organization)}</td></tr>` : ''}
          </table>
          ${message ? `<h2 style="margin:24px 0 8px;font-size:16px;">Message from the visitor</h2><p style="margin:0;font-size:14px;line-height:1.6;white-space:pre-wrap;">${esc(message)}</p>` : ''}
          ${reviewUrl ? `<p style="margin:24px 0 0;font-size:14px;"><a href="${esc(reviewUrl)}" style="color:#1d4ed8;">Review this request in the admin area</a></p>` : ''}
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text: textLines.join('\n'), html };
}

/**
 * Visitor acknowledgement: the request was received, nothing is confirmed yet.
 * @returns {{subject: string, text: string, html: string}}
 */
export function inquiryAcknowledgementEmail({ inquiry, space = null, baseUrl = null } = {}) {
  const reference = inquiry.reference ?? '(new inquiry)';
  const subject = `We received your booking request ${reference} - Nagaro`;
  const duration = durationText(inquiry);
  const quantities = quantityLines(inquiry, space);
  const message = inquiry.message ? String(inquiry.message) : null;
  const withdrawal = withdrawUrl(inquiry, baseUrl);

  const textLines = [
    `Dear ${inquiry.customerName ?? 'visitor'},`,
    '',
    'Thank you for your booking request. We have received it and will contact you',
    'to confirm availability and the next steps.',
    '',
    `Reference: ${reference}`,
    `Space: ${spaceLine(inquiry, space)}`,
    `Requested window: ${windowText(inquiry)}`,
  ];
  if (duration) textLines.push(`Duration: ${duration}`);
  textLines.push(...quantities);
  if (message) textLines.push('', 'The message you sent:', message);
  textLines.push(
    '',
    'This request is provisional: no booking is confirmed and no payment has been taken.',
    'A member of the Nagaro team will be in touch using the contact details you provided.',
  );
  if (withdrawal) {
    textLines.push(
      '',
      'If you no longer need this space, you can withdraw the request here:',
      withdrawal,
    );
  }
  textLines.push('', 'Nagaro - Trace Expert City');

  const quantityRows = quantities
    .map((line) => {
      const [label, ...rest] = line.split(':');
      return `<tr><th align="left" style="padding:4px 12px 4px 0;">${esc(label)}</th><td>${esc(rest.join(':').trim())}</td></tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:8px;">
      <tr>
        <td style="padding:24px;">
          <h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;">We received your booking request</h1>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;">Dear ${esc(inquiry.customerName)}, thank you for your request. We will contact you to confirm availability and the next steps.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.5;">
            <tr><th align="left" style="padding:4px 12px 4px 0;">Reference</th><td>${esc(reference)}</td></tr>
            <tr><th align="left" style="padding:4px 12px 4px 0;">Space</th><td>${esc(spaceLine(inquiry, space))}</td></tr>
            <tr><th align="left" style="padding:4px 12px 4px 0;">Requested window</th><td>${esc(windowText(inquiry))}</td></tr>
            ${duration ? `<tr><th align="left" style="padding:4px 12px 4px 0;">Duration</th><td>${esc(duration)}</td></tr>` : ''}
            ${quantityRows}
          </table>
          ${message ? `<h2 style="margin:24px 0 8px;font-size:16px;">Your message</h2><p style="margin:0;font-size:14px;line-height:1.6;white-space:pre-wrap;">${esc(message)}</p>` : ''}
          <p style="margin:24px 0 0;font-size:14px;line-height:1.6;color:#57534e;">This request is provisional: no booking is confirmed and no payment has been taken. A member of the Nagaro team will be in touch using the contact details you provided.</p>
          ${withdrawal ? `<p style="margin:16px 0 0;font-size:14px;line-height:1.6;">If you no longer need this space, you can <a href="${esc(withdrawal)}" style="color:#1d4ed8;">withdraw your request</a>.</p>` : ''}
          <p style="margin:24px 0 0;font-size:13px;color:#78716c;">Nagaro - Trace Expert City</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text: textLines.join('\n'), html };
}

export const _internals = { esc, resolveBaseUrl, windowText };
