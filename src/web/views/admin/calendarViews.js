/**
 * Admin calendar views: the per-space day timeline and the week overview
 * (calendarViews.js).
 *
 * Both pages are read-only projections of committed occupancy. They receive
 * plain data — the space list, the hour grids built by `getSpaceDayGrid()` or
 * the range rows from `loadCalendarData()` — and never query the database.
 * Bookings are created, moved and cancelled from the reservation pages, where
 * availability is re-checked inside the write transaction.
 *
 * Markup follows the timeline convention documented at the top of
 * src/web/public/styles.css: hour rows are `.timeline__slot` elements inside a
 * `.timeline`, coloured with `.timeline__slot--free` / `.timeline__slot--busy`.
 * No new CSS class names are introduced here.
 *
 * Data-attribute contract for src/web/public/admin.js and integrations:
 *   [data-calendar-events-url]   JSON feed path (same data as the page)
 *   [data-calendar-date]         the rendered day (or week start)
 *   [data-calendar-view]         "day" | "week"
 */
import {
  emptyState, friendlyDate, html, raw, statusBadge, timeLabel,
} from '../../lib/html.js';
import { adminShell, card, table } from '../layout.js';
import {
  OCCUPANCY_SOURCE, RESERVATION_STATUS, SPACE_CATEGORY_LABEL, SPACE_CATEGORY_ORDER,
} from '../../../server/domain/constants.js';

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* ------------------------------------------------------------------ helpers */

/** UTC-stable epoch for a `YYYY-MM-DD` business date key (03:00 EAT same day). */
function epochFromDateKey(dateKey) {
  const parsed = Date.parse(`${dateKey}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function addDaysToDateKey(dateKey, days) {
  return new Date(epochFromDateKey(dateKey) + days * DAY_MS).toISOString().slice(0, 10);
}

function weekdayLabel(dateKey) {
  const index = (new Date(epochFromDateKey(dateKey)).getUTCDay() + 6) % 7;
  return WEEKDAYS[index];
}

function dayHeading(dateKey) {
  return `${weekdayLabel(dateKey)} ${friendlyDate(epochFromDateKey(dateKey))}`;
}

/**
 * One occupant per reservation or maintenance block, even when several units
 * of the same booking cover the slot. Unit codes are folded into one entry so
 * a three-desk booking reads as one line, not three.
 *
 * The grid rows carry `reservationId` for bookings; maintenance rows do not
 * expose their block id, so distinct maintenance blocks are told apart by
 * their reason + period (the occupancy trigger makes two blocks with the same
 * reason over the same period impossible anyway).
 */
export function dedupeGridOccupants(rows = []) {
  const seen = new Map();
  for (const row of rows) {
    const key = row.reservationId
      ? `reservation:${row.reservationId}`
      : row.maintenanceBlockId
        ? `maintenance:${row.maintenanceBlockId}`
        : row.source === OCCUPANCY_SOURCE.MAINTENANCE
          ? `maintenance:${row.maintenanceReason ?? ''}|${row.startAt}|${row.endAt}`
          : `occupancy:${row.occupancyId}`;
    if (!seen.has(key)) seen.set(key, { ...row, unitCodes: [] });
    const entry = seen.get(key);
    if (row.unitCode && !entry.unitCodes.includes(row.unitCode)) entry.unitCodes.push(row.unitCode);
  }
  return [...seen.values()];
}

function occupantLine(occupant) {
  const units = occupant.unitCodes.length ? ` · ${occupant.unitCodes.join(', ')}` : '';
  const when = `${timeLabel(occupant.startAt)}\u2013${timeLabel(occupant.endAt)}`;
  if (occupant.source === OCCUPANCY_SOURCE.MAINTENANCE) {
    return html`${when} · <strong>Maintenance</strong>${occupant.maintenanceReason ? `: ${occupant.maintenanceReason}` : ''}${units}`;
  }
  return html`${when} ·
    <a href="/admin/reservations/${occupant.reservationId}">${occupant.reference ?? 'Booking'}</a>
    · ${occupant.customerName ?? 'Customer'}${units}
    ${occupant.reservationStatus === RESERVATION_STATUS.COMPLETED ? statusBadge(RESERVATION_STATUS.COMPLETED) : ''}`;
}

/** Legend for the timeline colouring; mirrors .timeline__slot--free/--busy. */
export function timelineLegend() {
  return html`<ul class="timeline-legend">
    <li class="is-free">Free \u2014 at least one unit bookable</li>
    <li class="is-busy">Fully booked \u2014 every unit claimed</li>
  </ul>`;
}

/* ------------------------------------------------------------------- filters */

function spaceFilterOptions(spaces, selected) {
  const wanted = String(selected ?? '');
  return spaces.map((space) => html`<option value="${space.id}"${raw(
    wanted === String(space.id) || (wanted && space.code.toUpperCase() === wanted.toUpperCase()) ? ' selected' : '',
  )}>${space.code} \u2014 ${space.name}</option>`);
}

function calendarFilterCard({ filters, spaces }) {
  return card({
    title: 'Filters',
    description: 'Pick the view, the date, a space, a category and a reservation status. Changing a dropdown applies it immediately.',
    body: html`<form class="filter-bar" method="get" action="/admin/calendar">
      <div class="filter-bar__field">
        <label for="calendar-view">View</label>
        <select id="calendar-view" name="view">
          ${[['day', 'Day \u2014 hour-by-hour per space'], ['week', 'Week \u2014 seven day columns']]
      .map(([value, label]) => html`<option value="${value}"${raw(filters.view === value ? ' selected' : '')}>${label}</option>`)}
        </select>
      </div>
      <div class="filter-bar__field">
        <label for="calendar-date">Date</label>
        <input id="calendar-date" name="date" type="date" value="${filters.date ?? ''}">
      </div>
      <div class="filter-bar__field">
        <label for="calendar-space">Space</label>
        <select id="calendar-space" name="space">
          <option value="">All spaces</option>
          ${spaceFilterOptions(spaces, filters.space)}
        </select>
      </div>
      <div class="filter-bar__field">
        <label for="calendar-category">Category</label>
        <select id="calendar-category" name="category">
          <option value="">All categories</option>
          ${SPACE_CATEGORY_ORDER.map((category) => html`<option value="${category}"${raw(filters.category === category ? ' selected' : '')}>${SPACE_CATEGORY_LABEL[category]}</option>`)}
        </select>
      </div>
      <div class="filter-bar__field">
        <label for="calendar-status">Status</label>
        <select id="calendar-status" name="status">
          <option value="all"${raw(filters.status === 'all' ? ' selected' : '')}>Confirmed and completed</option>
          <option value="CONFIRMED"${raw(filters.status === 'CONFIRMED' ? ' selected' : '')}>Confirmed only</option>
          <option value="COMPLETED"${raw(filters.status === 'COMPLETED' ? ' selected' : '')}>Completed only</option>
          <option value="CANCELLED"${raw(filters.status === 'CANCELLED' ? ' selected' : '')}>Cancelled only (history)</option>
        </select>
      </div>
      <div class="filter-bar__actions">
        <button class="button button--primary button--small" type="submit">Apply</button>
        <a class="button button--ghost button--small" href="/admin/calendar">Reset</a>
      </div>
    </form>`,
  });
}

function unknownSpaceAlert(rawFilter) {
  if (!rawFilter) return '';
  return html`<div class="alert alert--error" role="alert">
    <p><strong>No space matches \u201c${String(rawFilter)}\u201d.</strong></p>
    <p>The calendar is unfiltered. Pick a space from the list, or reset the filters.</p>
  </div>`;
}

function calendarNavBar(nav) {
  if (!nav) return '';
  return html`<div class="cluster">
    <a class="button button--ghost button--small" href="${nav.previous.href}">${nav.previous.label}</a>
    <a class="button button--ghost button--small" href="${nav.today.href}">${nav.today.label}</a>
    <a class="button button--ghost button--small" href="${nav.next.href}">${nav.next.label}</a>
  </div>`;
}

function projectionNote({ eventsUrl, fromKey, toKey }) {
  const href = `${eventsUrl}?from=${fromKey}&to=${toKey}`;
  return card({
    title: 'Read-only projection',
    description: 'This page never writes. Booking changes happen on the reservation pages, under the database write lock.',
    body: html`<p class="hint">Every entry below is committed occupancy read back from the database. Creating, moving or cancelling a
      booking happens on the reservation pages, where availability is re-checked inside the write transaction \u2014 a check that
      blocks concurrent duplicates. Nothing shown here can be \u201chalf-booked\u201d.</p>
      <p class="hint">Machine-readable feed for the same data: <a href="${href}">${href}</a></p>`,
  });
}

/* ------------------------------------------------------------------- day view */

function spaceDayCard({ space, grid }) {
  const slots = grid?.slots ?? [];
  const legend = timelineLegend();

  const timelineBody = slots.length === 0
    ? emptyState(
      'No hour rows for this day.',
      'The space has no bookable hours on this date, or no active units.',
    )
    : html`<div class="timeline">
        ${slots.map((slot) => {
          const occupants = dedupeGridOccupants(slot.occupancy);
          return html`<div class="timeline__slot ${slot.isFree ? 'timeline__slot--free' : 'timeline__slot--busy'}">
            <div>${timeLabel(slot.startAt)}</div>
            <div>
              ${occupants.length === 0
                ? html`<span class="hint">Free \u2014 ${slot.freeUnits} of ${slot.totalUnits} ${slot.totalUnits === 1 ? 'unit' : 'units'} bookable.</span>`
                : html`${occupants.map((occupant) => html`<div>${occupantLine(occupant)}</div>`)}
                   ${slot.isFree
                  ? html`<p class="hint">${slot.freeUnits} of ${slot.totalUnits} still free in this hour.</p>`
                  : ''}`}
            </div>
          </div>`;
        })}
      </div>`;

  const unitsText = grid
    ? `${grid.totalUnits} active ${grid.totalUnits === 1 ? 'unit' : 'units'} \u00b7 opening hours ${grid.openTime}\u2013${grid.closeTime}`
    : '';
  const bufferText = grid && grid.bufferMinutes > 0
    ? html`<span class="hint"> \u00b7 ${grid.bufferMinutes} min changeover buffer between bookings is enforced by the server.</span>`
    : '';

  return card({
    title: `${space.code} \u2014 ${space.name}`,
    description: html`${SPACE_CATEGORY_LABEL[space.category] ?? space.category}. ${unitsText}.${bufferText}${' '}
      ${space.status === 'ARCHIVED' ? html`<strong>This space is archived and no longer bookable.</strong>` : ''}`,
    actions: html`<a class="button button--ghost button--small"
      href="/admin/reservations/new?space=${space.id}&date=${grid?.dateKey ?? ''}">Book this space</a>`,
    body: html`${timelineBody}${legend}`,
  });
}

export function renderCalendarPage({
  actor, csrfToken, flash = null, filters = {}, spaces = [], dayGrids = [],
  nav = null, unknownSpace = false, eventsUrl = '/api/admin/calendar/events',
}) {
  const dayKey = filters.date ?? '';
  const hasSpaces = dayGrids.length > 0;

  const body = html`
    ${unknownSpaceAlert(unknownSpace ? filters.space : null)}
    ${calendarFilterCard({ filters, spaces })}

    ${card({
    title: `${dayHeading(dayKey)} \u2014 day view`,
    description: 'One row per hour of the space\u2019s opening hours. Rows tinted green are free; striped rows are fully booked for that hour.',
    actions: calendarNavBar(nav),
    body: html`<div data-calendar-events-url="${eventsUrl}"
                       data-calendar-date="${dayKey}"
                       data-calendar-view="day"
                       data-tz-offset="+03:00">
        ${hasSpaces
      ? dayGrids.map(({ space, grid }) => spaceDayCard({ space, grid }))
      : emptyState(
        'No bookable spaces match these filters.',
        'Adjust the space or category filter, or reset the filters to see the whole calendar.',
      )}
      </div>`,
  })}

    ${projectionNote({ eventsUrl, fromKey: dayKey, toKey: addDaysToDateKey(dayKey, 1) })}`;

  return adminShell({
    title: 'Calendar',
    subtitle: `Availability by hour for ${dayHeading(dayKey)}. Read-only: bookings are created and changed from the reservation pages.`,
    actor,
    csrfToken,
    flash,
    activePath: '/admin/calendar',
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Calendar' }],
    pageActions: html`<a class="button button--primary button--small" href="/admin/reservations/new">New reservation</a>`,
    body,
  });
}

/* ------------------------------------------------------------------ week view */

/**
 * The visible part of an entry inside one day column: multi-day bookings are
 * clipped to the day and marked as continued, so a desk rental that spans a
 * week reads correctly in every column it touches.
 */
function clippedWeekEntry(entry, day) {
  const start = Math.max(entry.startAt, day.startAt);
  const end = Math.min(entry.endAt, day.endAt);
  const startedEarlier = entry.startAt < day.startAt;
  const continues = entry.endAt > day.endAt;
  const when = `${timeLabel(start)}\u2013${timeLabel(end)}`;
  const marks = `${startedEarlier ? ' (from earlier)' : ''}${continues ? ' (continues)' : ''}`;
  return { when, marks };
}

function weekReservationEntry(reservation, day) {
  const { when, marks } = clippedWeekEntry(reservation, day);
  const units = reservation.unitCount === 1 ? '1 unit' : `${reservation.unitCount} units`;
  return html`<a href="${reservation.url}">${reservation.reference}</a>
    <br><span class="hint">${when}${marks} \u00b7 ${reservation.spaceCode} \u00b7 ${reservation.customerName} \u00b7 ${units}</span>
    <br>${statusBadge(reservation.status)}`;
}

function weekMaintenanceEntry(block, day) {
  const { when, marks } = clippedWeekEntry(block, day);
  return html`<a href="${block.url}">Maintenance</a>
    <br><span class="hint">${when}${marks} \u00b7 ${block.spaceCode} \u00b7 ${block.reason}</span>`;
}

function weekDayCell(day, todayKey) {
  const entries = [
    ...day.reservations.map((reservation) => ({ sortAt: reservation.startAt, node: weekReservationEntry(reservation, day) })),
    ...day.maintenance.map((block) => ({ sortAt: block.startAt, node: weekMaintenanceEntry(block, day) })),
  ].sort((a, b) => a.sortAt - b.sortAt);

  const total = day.reservations.length + day.maintenance.length;
  const today = day.dateKey === todayKey ? html`<p class="hint">Today</p>` : '';

  if (entries.length === 0) {
    return html`${today}${emptyState('Nothing scheduled.')}`;
  }
  return html`${today}${' '}
    <p class="hint">${total} ${total === 1 ? 'entry' : 'entries'}</p>
    <ul>${entries.map((entry) => html`<li>${entry.node}</li>`)}</ul>`;
}

export function renderCalendarWeekPage({
  actor, csrfToken, flash = null, filters = {}, spaces = [], days = [],
  nav = null, unknownSpace = false, eventsUrl = '/api/admin/calendar/events',
}) {
  const firstDayKey = days.length ? days[0].dateKey : (filters.date ?? '');
  const lastDayKey = days.length ? days[days.length - 1].dateKey : (filters.date ?? '');
  const todayKey = filters.today ?? new Date().toISOString().slice(0, 10);

  const columns = days.map((day) => ({ label: dayHeading(day.dateKey) }));
  const rows = days.length
    ? [{ cells: days.map((day) => weekDayCell(day, todayKey)) }]
    : [];
  const headerText = days.length
    ? `${dayHeading(firstDayKey)} \u2192 ${dayHeading(lastDayKey)}`
    : 'No days to show';

  const body = html`
    ${unknownSpaceAlert(unknownSpace ? filters.space : null)}
    ${calendarFilterCard({ filters, spaces })}

    ${card({
    title: `${headerText} \u2014 week view`,
    description: 'Seven day columns. A booking that spans several days appears, clipped, in every day it covers. Maintenance blocks are listed with the reservations they were checked against.',
    actions: calendarNavBar(nav),
    body: html`<div data-calendar-events-url="${eventsUrl}"
                       data-calendar-date="${firstDayKey}"
                       data-calendar-view="week"
                       data-tz-offset="+03:00">
        ${days.length
      ? table({
        columns,
        rows,
        emptyMessage: 'Nothing scheduled this week.',
      })
      : emptyState('No week to show. Pick a date and try again.')}
      </div>
      ${timelineLegend()}`,
  })}

    ${projectionNote({ eventsUrl, fromKey: firstDayKey, toKey: addDaysToDateKey(lastDayKey, 1) })}`;

  return adminShell({
    title: 'Calendar',
    subtitle: `Week at a glance: ${headerText}. Confirmed and completed bookings by default; choose \u201cCancelled only\u201d to audit released bookings.`,
    actor,
    csrfToken,
    flash,
    activePath: '/admin/calendar',
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Calendar' }],
    pageActions: html`<a class="button button--primary button--small" href="/admin/reservations/new">New reservation</a>`,
    body,
  });
}
