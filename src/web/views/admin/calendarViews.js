/**
 * Admin calendar views: Microsoft Teams-style Day and Week planning.
 *
 * The server renders a complete agenda (with ordinary links) and a grid
 * skeleton. src/web/public/admin-calendar.js progressively enhances that into
 * the interactive calendar: 15-minute snapping, drag-create, drag-move,
 * edge-resize and side drawers. No business rule lives here: every write goes
 * back through bookingService, which owns the atomic conflict check.
 *
 * Data-attribute contract for src/web/public/admin-calendar.js:
 *   [data-admin-calendar]        root; view/date/filter state
 *   [data-calendar-events-url]   unified JSON feed
 *   [data-calendar-date]         rendered day (or week start)
 *   [data-calendar-view]         "day" | "week"
 *   [data-ac-spaces]             JSON <script> with the filterable space list
 *   [data-ac-initial-events]     JSON <script> with the initial feed
 *   [data-ac-board]              grid mount point
 *   [data-ac-column]             one day (week) or space column (day)
 *   [data-ac-event]              event card
 *   [data-ac-agenda]             no-JS agenda list
 *   [data-ac-drawer]             details / quick-create side drawer
 *   [data-ac-move-dialog]        accessible move dialog
 */
import {
  emptyState, friendlyDate, html, raw, statusBadge, tag, timeLabel,
} from '../../lib/html.js';
import { adminShell, card } from '../layout.js';
import {
  BOOKING_REQUEST_STATUS, RESERVATION_STATUS, SPACE_CATEGORY_LABEL, SPACE_CATEGORY_ORDER,
} from '../../../server/domain/constants.js';
import { businessDateKey, businessLocalToEpoch, todayBusinessDate } from '../../../server/domain/time.js';

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HOUR_HEIGHT = 56;
const DEFAULT_OPEN = 8 * 60;
const DEFAULT_CLOSE = 18 * 60;

/* --------------------------------------------------------------- date maths */

function epochFromDateKey(dateKey) {
  try {
    return businessLocalToEpoch(dateKey, '00:00');
  } catch {
    return Date.now();
  }
}

function addDaysToDateKey(dateKey, days) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function startOfWeekKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDaysToDateKey(dateKey, -((weekday + 6) % 7));
}

function weekdayIndex(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function weekdayLabel(dateKey) {
  return WEEKDAYS[weekdayIndex(dateKey)];
}

function weekdayLong(dateKey) {
  return WEEKDAYS_LONG[weekdayIndex(dateKey)];
}

function dayHeading(dateKey) {
  return `${weekdayLabel(dateKey)} ${friendlyDate(epochFromDateKey(dateKey))}`;
}

function shortDayHeading(dateKey) {
  const [, month, day] = String(dateKey).split('-').map(Number);
  return `${WEEKDAYS[weekdayIndex(dateKey)]} ${day} ${MONTHS[month - 1]}`;
}

function minutesLabel(minutes) {
  const bounded = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
  const h = Math.floor(bounded / 60);
  const m = bounded % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function safeClockMinutes(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return hours * 60 + minutes;
}

/**
 * The visible time range. It starts at the hour before the earliest opening
 * time and ends at the hour after the latest closing time, then grows if an
 * event sits outside opening hours. That keeps non-operating hours visible and
 * shaded instead of silently hiding a booking.
 */
export function calendarGridBounds(spaces = [], events = []) {
  let first = 24 * 60;
  let last = 0;
  let sawOpeningHours = false;
  for (const space of spaces) {
    const open = safeClockMinutes(space.openTime ?? space.open_time, DEFAULT_OPEN);
    const close = safeClockMinutes(space.closeTime ?? space.close_time, DEFAULT_CLOSE);
    if (close > open) {
      first = Math.min(first, open);
      last = Math.max(last, close);
      sawOpeningHours = true;
    }
  }
  for (const event of events) {
    if (!Number.isFinite(Number(event.startAt)) || !Number.isFinite(Number(event.endAt))) continue;
    const startAt = Number(event.startAt);
    const endAt = Number(event.endAt);
    if (endAt <= startAt) continue;
    const startDay = epochFromDateKey(businessDateKey(startAt));
    const endDay = epochFromDateKey(businessDateKey(endAt - 1));
    const startMinute = Math.max(0, Math.min(24 * 60, Math.round((startAt - startDay) / 60000)));
    const endMinute = Math.max(0, Math.min(24 * 60, Math.round((endAt - endDay) / 60000)));
    first = Math.min(first, startMinute);
    last = Math.max(last, endMinute);
  }
  if (!sawOpeningHours && events.length === 0) {
    first = DEFAULT_OPEN;
    last = DEFAULT_CLOSE;
  }
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) {
    first = DEFAULT_OPEN;
    last = DEFAULT_CLOSE;
  }
  const startMinute = Math.max(0, Math.floor(first / 60) * 60);
  const endMinute = Math.min(24 * 60, Math.max(startMinute + 60, Math.ceil(last / 60) * 60));
  return { startMinute, endMinute, hourHeight: HOUR_HEIGHT };
}

/** Round a timestamp to a quarter-hour (or any step) boundary. */
export function snapToStep(epochMs, stepMinutes = 15, mode = 'round') {
  const value = Number(epochMs);
  const step = Number(stepMinutes) * 60000;
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  const method = mode === 'floor' ? Math.floor : mode === 'ceil' ? Math.ceil : Math.round;
  return method(value / step) * step;
}

/** Clip events to a day and assign non-overlapping lanes within overlap groups. */
export function layoutDayEvents(events = [], { dayStart, dayEnd } = {}) {
  const start = Number(dayStart);
  const end = Number(dayEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const segments = [];
  for (const event of events) {
    const eventStart = Number(event.startAt);
    const eventEnd = Number(event.endAt);
    if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd)) continue;
    const clippedStart = Math.max(eventStart, start);
    const clippedEnd = Math.min(eventEnd, end);
    if (clippedEnd <= clippedStart) continue;
    segments.push({
      event,
      startAt: clippedStart,
      endAt: clippedEnd,
      startMinute: Math.round((clippedStart - start) / 60000),
      endMinute: Math.round((clippedEnd - start) / 60000),
      lane: 0,
      laneCount: 1,
    });
  }
  segments.sort((a, b) => (a.startMinute - b.startMinute) || (a.endMinute - b.endMinute) || String(a.event.id).localeCompare(String(b.event.id)));

  let cluster = [];
  let laneEnds = [];
  let clusterEnd = -Infinity;
  const finalise = () => {
    const laneCount = Math.max(1, laneEnds.length);
    for (const segment of cluster) segment.laneCount = laneCount;
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };

  for (const segment of segments) {
    if (cluster.length > 0 && segment.startMinute >= clusterEnd) finalise();
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= segment.startMinute);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(segment.endMinute);
    } else {
      laneEnds[lane] = segment.endMinute;
    }
    segment.lane = lane;
    cluster.push(segment);
    clusterEnd = Math.max(clusterEnd, segment.endMinute);
  }
  if (cluster.length > 0) finalise();
  return segments;
}

/* ------------------------------------------------------------- view helpers */

function normalizeSpace(space) {
  const openTime = space.openTime ?? space.open_time ?? '08:00';
  const closeTime = space.closeTime ?? space.close_time ?? '18:00';
  return {
    id: Number(space.id),
    code: space.code ?? '',
    name: space.name ?? '',
    category: space.category ?? 'MEETING_ROOM',
    status: space.status ?? 'PUBLISHED',
    openTime,
    closeTime,
    minDurationMinutes: Number(space.minDurationMinutes ?? space.min_duration_minutes ?? 60),
    maxDurationMinutes: space.maxDurationMinutes ?? space.max_duration_minutes ?? null,
    bufferMinutes: Number(space.bufferMinutes ?? space.buffer_minutes ?? 0),
    unitCount: Number(space.unitCount ?? space.unit_count ?? (Array.isArray(space.units) ? space.units.length : 1)),
    pricingUnit: space.pricingUnit ?? space.pricing_unit ?? 'HOUR',
    currency: space.currency ?? 'LKR',
    capacity: space.capacity ?? null,
  };
}

function spaceMatchesFilter(space, filters, unknownSpace) {
  if (unknownSpace) return true;
  if (filters.space) {
    const wanted = String(filters.space);
    const isId = /^\d+$/.test(wanted);
    if (isId ? space.id !== Number(wanted) : space.code.toUpperCase() !== wanted.toUpperCase()) return false;
  }
  if (filters.category && space.category !== filters.category) return false;
  return true;
}

function viewHref(view, filters) {
  const params = new URLSearchParams();
  params.set('view', view);
  if (filters.date) params.set('date', filters.date);
  if (filters.space) params.set('space', filters.space);
  if (filters.category) params.set('category', filters.category);
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  return `/admin/calendar?${params.toString()}`;
}

function dayHref(dateKey, filters) {
  const params = new URLSearchParams();
  params.set('view', 'day');
  params.set('date', dateKey);
  if (filters.space) params.set('space', filters.space);
  if (filters.category) params.set('category', filters.category);
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  return `/admin/calendar?${params.toString()}`;
}

function eventClass(event) {
  const kind = String(event.kind ?? 'RESERVATION').toLowerCase();
  const status = String(event.status ?? '').toLowerCase();
  const classes = ['ac-event', `ac-event--${kind}`];
  if (status) classes.push(`ac-event--status-${status}`);
  if (event.kind === 'REQUEST') classes.push('ac-event--request');
  if (event.kind === 'HOLD') classes.push('ac-event--hold');
  if (!event.editable && event.kind === 'RESERVATION') classes.push('ac-event--readonly');
  return classes.join(' ');
}

function kindLabel(kind) {
  return {
    RESERVATION: 'Booking',
    MAINTENANCE: 'Maintenance',
    HOLD: 'Payment hold',
    REQUEST: 'Pending request',
  }[kind] ?? 'Calendar event';
}

function eventTimeRange(event) {
  if (!event.startAt || !event.endAt) return '';
  const sameDay = businessDateKey(event.startAt) === businessDateKey(event.endAt - 1);
  if (sameDay) return `${timeLabel(event.startAt)}\u2013${timeLabel(event.endAt)}`;
  return `${friendlyDate(event.startAt)} ${timeLabel(event.startAt)} \u2013 ${friendlyDate(event.endAt)} ${timeLabel(event.endAt)}`;
}

function eventSearchText(event) {
  return [
    event.reference, event.spaceCode, event.spaceName, event.customerName,
    event.purpose, kindLabel(event.kind),
  ].filter(Boolean).join(' ').toLowerCase();
}

/* --------------------------------------------------------------- fallbacks */

/** Convert the old day-grid projection into events if a caller passes no feed. */
export function eventsFromDayGrids(dayGrids = []) {
  const collected = new Map();
  for (const { space, grid } of dayGrids) {
    for (const slot of grid?.slots ?? []) {
      for (const occupant of slot.occupancy ?? []) {
        const key = occupant.reservationId
          ? `reservation:${occupant.reservationId}`
          : occupant.maintenanceBlockId
            ? `maintenance:${occupant.maintenanceBlockId}`
            : occupant.source === 'HOLD'
              ? `hold:${occupant.reference ?? occupant.occupancyId}`
              : `occupancy:${occupant.occupancyId ?? `${occupant.startAt}:${occupant.endAt}`}`;
        const existing = collected.get(key);
        if (existing) {
          existing.startAt = Math.min(existing.startAt, occupant.startAt);
          existing.endAt = Math.max(existing.endAt, occupant.endAt);
          if (occupant.unitCode && !existing.unitCodes.includes(occupant.unitCode)) existing.unitCodes.push(occupant.unitCode);
          continue;
        }
        const isMaintenance = occupant.source === 'MAINTENANCE';
        const isHold = occupant.source === 'HOLD';
        collected.set(key, {
          kind: isHold ? 'HOLD' : isMaintenance ? 'MAINTENANCE' : 'RESERVATION',
          id: key,
          recordId: occupant.reservationId ?? occupant.maintenanceBlockId ?? occupant.occupancyId ?? key,
          reference: occupant.reference ?? null,
          status: occupant.reservationStatus ?? (isHold ? BOOKING_REQUEST_STATUS.APPROVED_AWAITING_PAYMENT : isMaintenance ? 'MAINTENANCE' : 'CONFIRMED'),
          startAt: occupant.startAt,
          endAt: occupant.endAt,
          spaceId: Number(space.id),
          spaceCode: space.code,
          spaceName: space.name,
          category: space.category,
          customerName: occupant.customerName ?? null,
          purpose: occupant.purpose ?? occupant.maintenanceReason ?? null,
          reason: occupant.maintenanceReason ?? null,
          unitCount: occupant.unitCount ?? 1,
          unitCodes: occupant.unitCode ? [occupant.unitCode] : [],
          editable: !isHold && !isMaintenance && occupant.reservationStatus === RESERVATION_STATUS.CONFIRMED,
          url: occupant.reservationId ? `/admin/reservations/${occupant.reservationId}` : isMaintenance ? '/admin/maintenance' : '/admin/booking-requests',
        });
      }
    }
  }
  return [...collected.values()].sort((a, b) => a.startAt - b.startAt);
}

function eventsFromDays(days = []) {
  const collected = new Map();
  for (const day of days) {
    for (const reservation of day.reservations ?? []) {
      const key = `reservation:${reservation.id}`;
      if (!collected.has(key)) {
        collected.set(key, {
          kind: 'RESERVATION',
          id: key,
          recordId: reservation.id,
          reference: reservation.reference,
          status: reservation.status,
          startAt: reservation.startAt,
          endAt: reservation.endAt,
          spaceId: reservation.spaceId,
          spaceCode: reservation.spaceCode,
          spaceName: reservation.spaceName,
          category: reservation.category,
          customerName: reservation.customerName,
          unitCount: reservation.unitCount,
          unitCodes: reservation.unitCodes ?? [],
          editable: reservation.status === RESERVATION_STATUS.CONFIRMED,
          url: reservation.url ?? `/admin/reservations/${reservation.id}`,
        });
      }
    }
    for (const block of day.maintenance ?? []) {
      const key = `maintenance:${block.id}`;
      if (!collected.has(key)) {
        collected.set(key, {
          kind: 'MAINTENANCE',
          id: key,
          recordId: block.id,
          reference: null,
          status: 'MAINTENANCE',
          startAt: block.startAt,
          endAt: block.endAt,
          spaceId: block.spaceId,
          spaceCode: block.spaceCode,
          spaceName: block.spaceName,
          category: block.category,
          customerName: null,
          reason: block.reason,
          unitCount: (block.unitCodes ?? []).length,
          unitCodes: block.unitCodes ?? [],
          editable: false,
          url: block.url ?? '/admin/maintenance',
        });
      }
    }
  }
  return [...collected.values()].sort((a, b) => a.startAt - b.startAt);
}

/* ------------------------------------------------------------------ toolbar */

function selected(value, wanted) {
  return raw(String(value) === String(wanted) ? ' selected' : '');
}

function spaceOptions(spaces, filters) {
  return spaces.map((space) => html`<option value="${space.id}"${selected(
    space.id,
    filters.space && /^\d+$/.test(String(filters.space)) ? Number(filters.space) : '',
  )}>${space.code} \u2014 ${space.name}</option>`);
}

function calendarToolbar({ filters, spaces, nav, heading, summary }) {
  const isDay = filters.view !== 'week';
  return html`<div class="ac-toolbar" data-ac-toolbar>
    <div class="ac-toolbar__nav">
      <a class="ac-btn ac-btn--primary" data-ac-nav="today" href="${nav?.today?.href ?? dayHref(filters.date, filters)}">Today</a>
      <div class="ac-nav-group" role="group" aria-label="Previous or next period">
        <a class="ac-btn ac-btn--icon" data-ac-nav="prev" href="${nav?.previous?.href ?? viewHref(filters.view, { ...filters, date: addDaysToDateKey(filters.date, isDay ? -1 : -7) })}"
           aria-label="${isDay ? 'Previous day' : 'Previous week'}"><span aria-hidden="true">\u2039</span></a>
        <a class="ac-btn ac-btn--icon" data-ac-nav="next" href="${nav?.next?.href ?? viewHref(filters.view, { ...filters, date: addDaysToDateKey(filters.date, isDay ? 1 : 7) })}"
           aria-label="${isDay ? 'Next day' : 'Next week'}"><span aria-hidden="true">\u203a</span></a>
      </div>
      <h2 class="ac-toolbar__heading" data-ac-range>${heading}</h2>
    </div>

    <div class="ac-toolbar__views" role="group" aria-label="Calendar view">
      <a class="ac-btn ${isDay ? 'is-active' : ''}" data-ac-view-link="day"
         href="${viewHref('day', filters)}" ${isDay ? raw('aria-current="page"') : ''}>Day</a>
      <a class="ac-btn ${!isDay ? 'is-active' : ''}" data-ac-view-link="week"
         href="${viewHref('week', filters)}" ${!isDay ? raw('aria-current="page"') : ''}>Week</a>
    </div>

    <form class="ac-filters" method="get" action="/admin/calendar" data-ac-filters>
      <input type="hidden" name="view" value="${filters.view ?? 'day'}">
      <input type="hidden" name="date" value="${filters.date ?? ''}">
      <label class="visually-hidden" for="ac-space-filter">Filter by space</label>
      <select id="ac-space-filter" name="space" data-ac-filter="space">
        <option value="">All spaces</option>
        ${spaceOptions(spaces, filters)}
      </select>
      <label class="visually-hidden" for="ac-status-filter">Filter by status</label>
      <select id="ac-status-filter" name="status" data-ac-filter="status">
        <option value="all"${selected(filters.status ?? 'all', 'all')}>Confirmed + completed</option>
        <option value="CONFIRMED"${selected(filters.status, 'CONFIRMED')}>Confirmed only</option>
        <option value="COMPLETED"${selected(filters.status, 'COMPLETED')}>Completed only</option>
        <option value="CANCELLED"${selected(filters.status, 'CANCELLED')}>Cancelled only</option>
      </select>
      <label class="visually-hidden" for="ac-category-filter">Filter by category</label>
      <select id="ac-category-filter" name="category" data-ac-filter="category">
        <option value="">All categories</option>
        ${SPACE_CATEGORY_ORDER.map((category) => html`<option value="${category}"${selected(filters.category, category)}>${SPACE_CATEGORY_LABEL[category]}</option>`)}
      </select>
      <button class="ac-btn" type="submit">Apply</button>
    </form>

    <a class="ac-btn ac-btn--primary ac-new-reservation" data-ac-new-reservation
       href="/admin/reservations/new?space=${encodeURIComponent(filters.space ?? '')}&date=${encodeURIComponent(filters.date ?? '')}">New reservation</a>
    ${summary}
  </div>`;
}

/* ------------------------------------------------------------------- board */

function hourRows(openTime, closeTime) {
  const open = safeClockMinutes(openTime, DEFAULT_OPEN);
  const close = safeClockMinutes(closeTime, DEFAULT_CLOSE);
  const rows = [];
  for (let minute = 0; minute < 24 * 60; minute += 60) {
    rows.push({ minute, closed: minute < open || minute >= close });
  }
  return rows;
}

function gridHourLabels(startMinute, endMinute) {
  const labels = [];
  for (let minute = startMinute; minute < endMinute; minute += 60) {
    labels.push(html`<div class="ac-hour-label" aria-hidden="true">${minutesLabel(minute)}</div>`);
  }
  return labels;
}

function columnHours(space, startMinute, endMinute) {
  const open = space ? safeClockMinutes(space.openTime, DEFAULT_OPEN) : startMinute;
  const close = space ? safeClockMinutes(space.closeTime, DEFAULT_CLOSE) : endMinute;
  const rows = [];
  // Render exactly the visible grid range. Rendering all 24 hours while the
  // gutter only labelled the operating window put events on the wrong rows.
  for (let minute = startMinute; minute < endMinute; minute += 60) {
    rows.push({ minute, closed: minute < open || minute >= close });
  }
  return rows;
}

function staticColumn({ dateKey, space, todayKey, gridStartMinute, gridEndMinute }) {
  const isToday = dateKey === todayKey;
  const rows = columnHours(space, gridStartMinute, gridEndMinute);
  return html`<div class="ac-column ${isToday ? 'is-today' : ''}"
                    data-ac-column
                    data-date="${dateKey}"
                    data-space-id="${space ? space.id : ''}"
                    data-day-start="${businessLocalToEpoch(dateKey, '00:00')}">
    ${isToday ? html`<span class="ac-today-flag">Today</span>` : ''}
    <div class="ac-column__hours" aria-hidden="true">
      ${rows.map((row) => html`<div class="ac-hour${row.closed ? ' is-closed' : ''}"></div>`)}
    </div>
    <div class="ac-column__events" data-ac-events></div>
  </div>`;
}

function dayColumnHead({ dateKey, space, todayKey }) {
  const isToday = dateKey === todayKey;
  return html`<div class="ac-column-head ${isToday ? 'is-today' : ''}" data-ac-column-head data-date="${dateKey}">
    <span class="ac-column-head__code">${space.code}</span>
    <span class="ac-column-head__name">${space.name}</span>
    <span class="ac-column-head__meta">${space.openTime}\u2013${space.closeTime} \u00b7 ${space.unitCount} ${space.unitCount === 1 ? 'unit' : 'units'}</span>
  </div>`;
}

function weekColumnHead({ dateKey, todayKey }) {
  const isToday = dateKey === todayKey;
  const [, month, day] = dateKey.split('-').map(Number);
  return html`<div class="ac-column-head ac-column-head--week ${isToday ? 'is-today' : ''}" data-ac-column-head data-date="${dateKey}">
    <span class="ac-column-head__weekday">${WEEKDAYS[weekdayIndex(dateKey)]}</span>
    <span class="ac-column-head__date">${day}</span>
    <span class="ac-column-head__month">${MONTHS[month - 1]}</span>
    ${isToday ? html`<span class="ac-badge">Today</span>` : ''}
  </div>`;
}

function gridBoard({ view, columns, todayKey, gridStartMinute, gridEndMinute }) {
  const labels = gridHourLabels(gridStartMinute, gridEndMinute);
  const isWeek = view === 'week';
  return html`<div class="ac-board ${isWeek ? 'ac-board--week' : 'ac-board--day'}" data-ac-board>
    <div class="ac-board__head">
      <div class="ac-gutter ac-gutter--head"><span class="visually-hidden">Time</span></div>
      <div class="ac-column-heads" role="presentation">
        ${columns.map((column) => (isWeek ? weekColumnHead(column) : dayColumnHead(column)))}
      </div>
    </div>
    <div class="ac-board__body" data-ac-scroll>
      <div class="ac-gutter" aria-hidden="true">
        <div class="ac-gutter__hours">${labels}</div>
      </div>
      <div class="ac-columns" role="presentation">
        ${columns.map((column) => staticColumn({ ...column, todayKey, gridStartMinute, gridEndMinute }))}
      </div>
    </div>
    <noscript>
      <p class="ac-noscript">The interactive grid needs JavaScript. Every event is still available in the agenda below.</p>
    </noscript>
  </div>`;
}

/* ------------------------------------------------------------------- agenda */

function agendaEvent(event) {
  const secondary = [
    eventTimeRange(event),
    event.spaceCode ? `${event.spaceCode} \u00b7 ${event.spaceName}` : null,
    event.customerName,
    event.reference,
  ].filter(Boolean).join(' \u00b7 ');
  const holdNote = event.kind === 'HOLD' && event.heldUntil
    ? ` \u00b7 held until ${timeLabel(event.heldUntil)}`
    : '';
  return html`<li class="ac-agenda__item ac-agenda__item--${String(event.kind ?? 'reservation').toLowerCase()}">
    <a class="ac-agenda__link" href="${event.url ?? '#'}" data-ac-event-link="${event.id}">
      <span class="ac-agenda__kind">${kindLabel(event.kind)}</span>
      <span class="ac-agenda__title">${event.reference ?? event.reason ?? event.spaceCode}</span>
      <span class="ac-agenda__meta">${secondary}${holdNote}</span>
    </a>
    ${event.status ? html`<span class="ac-agenda__status">${statusBadge(event.status === 'MAINTENANCE' ? 'DRAFT' : event.status)}</span>` : ''}
  </li>`;
}

function agenda(events, view, dateKey, todayKey) {
  const startKey = view === 'week' ? startOfWeekKey(dateKey) : dateKey;
  const keys = [];
  if (view === 'week') {
    for (let index = 0; index < 7; index += 1) keys.push(addDaysToDateKey(startKey, index));
  } else {
    keys.push(dateKey);
  }
  const groups = keys.map((key) => {
    const dayStart = businessLocalToEpoch(key, '00:00');
    const dayEnd = dayStart + DAY_MS;
    const items = events.filter((event) => event.startAt < dayEnd && event.endAt > dayStart);
    return { dateKey: key, items };
  }).filter((group) => group.items.length > 0);

  return html`<section class="ac-agenda" data-ac-agenda aria-labelledby="ac-agenda-title">
    <div class="ac-agenda__head">
      <h3 id="ac-agenda-title">Agenda</h3>
      <p class="hint">Keyboard and no-JavaScript fallback. Every item links to its record; holds reserve inventory, pending requests do not.</p>
    </div>
    ${groups.length === 0
      ? emptyState('Nothing scheduled in this range.', 'Drag on the grid to create a booking, or use New reservation.')
      : groups.map((group) => html`<div class="ac-agenda__day ${group.dateKey === todayKey ? 'is-today' : ''}">
          <h4 class="ac-agenda__date">${weekdayLong(group.dateKey)} \u00b7 ${friendlyDate(epochFromDateKey(group.dateKey))}</h4>
          <ul class="ac-agenda__list">${group.items.map(agendaEvent)}</ul>
        </div>`)}
  </section>`;
}

/* ------------------------------------------------------------------ summary */

function calendarSummary(events) {
  const reservations = events.filter((event) => event.kind === 'RESERVATION' && event.status !== RESERVATION_STATUS.CANCELLED);
  const holds = events.filter((event) => event.kind === 'HOLD');
  const requests = events.filter((event) => event.kind === 'REQUEST');
  return html`<div class="ac-summary" aria-label="Calendar summary">
    <span class="ac-summary__pill">${reservations.length} booking${reservations.length === 1 ? '' : 's'}</span>
    <span class="ac-summary__pill ac-summary__pill--hold">${holds.length} hold${holds.length === 1 ? '' : 's'}</span>
    <span class="ac-summary__pill ac-summary__pill--request">${requests.length} request${requests.length === 1 ? '' : 's'}</span>
  </div>`;
}

function unknownSpaceAlert(rawFilter) {
  if (!rawFilter) return '';
  return html`<div class="alert alert--error" role="alert">
    <p><strong>No space matches \u201c${String(rawFilter)}\u201d.</strong></p>
    <p>The calendar is unfiltered. Pick a space from the list, or reset the filters.</p>
  </div>`;
}

/* --------------------------------------------------------------- root view */

function safeJson(value) {
  return raw(JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029'));
}

function rangeLabel(view, dateKey) {
  if (view === 'week') {
    const weekStart = startOfWeekKey(dateKey);
    const weekEnd = addDaysToDateKey(weekStart, 6);
    return `${friendlyDate(epochFromDateKey(weekStart))} \u2013 ${friendlyDate(epochFromDateKey(weekEnd))}`;
  }
  return dayHeading(dateKey);
}

function resolvedRange(view, dateKey) {
  if (view === 'week') {
    const weekStart = startOfWeekKey(dateKey);
    return {
      firstKey: weekStart,
      fromAt: businessLocalToEpoch(weekStart, '00:00'),
      toAt: businessLocalToEpoch(addDaysToDateKey(weekStart, 7), '00:00'),
    };
  }
  return {
    firstKey: dateKey,
    fromAt: businessLocalToEpoch(dateKey, '00:00'),
    toAt: businessLocalToEpoch(addDaysToDateKey(dateKey, 1), '00:00'),
  };
}

function renderCalendarShell({
  actor, csrfToken, flash, filters, spaces, nav, unknownSpace, eventsUrl,
  events, data, today,
}) {
  const view = filters.view === 'week' ? 'week' : 'day';
  const dateKey = filters.date || todayBusinessDate();
  const todayKey = today || todayBusinessDate();
  const allSpaces = (spaces ?? []).map(normalizeSpace);
  const visibleSpaces = allSpaces.filter((space) => spaceMatchesFilter(space, filters, unknownSpace));
  const normalisedEvents = events ?? (view === 'week' ? eventsFromDays(data?.days) : eventsFromDayGrids(data?.dayGrids));
  const range = resolvedRange(view, dateKey);
  const bounds = calendarGridBounds(visibleSpaces, normalisedEvents);

  const columns = view === 'week'
    ? Array.from({ length: 7 }, (_, index) => ({
      dateKey: addDaysToDateKey(range.firstKey, index),
      space: null,
    }))
    : visibleSpaces.map((space) => ({ dateKey, space }));

  const board = gridBoard({
    view,
    columns,
    todayKey,
    gridStartMinute: bounds.startMinute,
    gridEndMinute: bounds.endMinute,
  });

  const body = html`<div class="stack ac-page">
    ${unknownSpaceAlert(unknownSpace ? filters.space : null)}
    <section class="ac-shell"
             data-admin-calendar
             data-calendar-events-url="${eventsUrl}"
             data-calendar-date="${dateKey}"
             data-calendar-view="${view}"
             data-tz-offset="+05:30"
             data-ac-view="${view}"
             data-ac-date="${dateKey}"
             data-ac-today="${todayKey}"
             data-ac-space="${filters.space ?? ''}"
             data-ac-category="${filters.category ?? ''}"
             data-ac-status="${filters.status ?? 'all'}"
             data-ac-events-url="${eventsUrl}"
             data-ac-reschedule-url="/api/admin/calendar/reschedule"
             data-ac-create-url="/api/admin/reservations"
             data-ac-availability-url="/api/admin/availability"
             data-ac-customers-url="/api/admin/customers/search"
             data-ac-grid-start="${bounds.startMinute}"
             data-ac-grid-end="${bounds.endMinute}"
             data-ac-csrf-token="${csrfToken}">
      ${calendarToolbar({
    filters: { ...filters, view, date: dateKey },
    spaces: allSpaces,
    nav,
    heading: rangeLabel(view, dateKey),
    summary: calendarSummary(normalisedEvents),
  })}
      <div class="ac-board-card">${card({
    title: view === 'week' ? 'Week schedule' : 'Day schedule',
    description: html`<span class="hint">15-minute snapping \u00b7 SLST \u00b7 shaded hours are outside opening times. Drag empty space to create; drag a booking to move it, or its top/bottom edge to resize.</span>`,
    body: html`<div class="ac-grid-wrap">${board}</div>`,
  })}</div>
      ${agenda(normalisedEvents, view, dateKey, todayKey)}
      <p class="hint ac-footnote">Payment holds reserve inventory until their expiry. Pending requests are annotations and do not block a booking until approved.</p>

    <script type="application/json" data-ac-spaces>${safeJson(allSpaces)}</script>
    <script type="application/json" data-ac-initial-events>${safeJson(normalisedEvents)}</script>

    <aside class="ac-drawer" data-ac-drawer hidden aria-labelledby="ac-drawer-title">
      <div class="ac-drawer__head">
        <div>
          <p class="ac-drawer__eyebrow" data-ac-drawer-kind></p>
          <h2 class="ac-drawer__title" id="ac-drawer-title" data-ac-drawer-title>Event</h2>
        </div>
        <button class="ac-btn ac-btn--icon" type="button" data-ac-close-drawer aria-label="Close details">\u00d7</button>
      </div>
      <div class="ac-drawer__body" data-ac-drawer-body></div>
    </aside>
    <div class="ac-scrim" data-ac-scrim hidden></div>

    <dialog class="ac-dialog" data-ac-move-dialog aria-labelledby="ac-move-title">
      <form method="dialog" data-ac-move-form>
        <h2 id="ac-move-title">Move or resize booking</h2>
        <p class="hint" data-ac-move-summary></p>
        <div class="ac-form-grid">
          <label>Space
            <select name="spaceId" data-ac-move-space required></select>
          </label>
          <label>Date
            <input type="date" name="date" data-ac-move-date required>
          </label>
          <label>Start
            <input type="time" name="startTime" step="900" data-ac-move-start required>
          </label>
          <label>End
            <input type="time" name="endTime" step="900" data-ac-move-end required>
          </label>
        </div>
        <p class="ac-form-error" data-ac-move-error role="alert"></p>
        <div class="ac-dialog__actions">
          <button class="ac-btn" type="button" data-ac-move-cancel>Cancel</button>
          <button class="ac-btn ac-btn--primary" type="submit">Save</button>
        </div>
      </form>
    </dialog>

    <dialog class="ac-dialog ac-dialog--create" data-ac-create-dialog aria-labelledby="ac-create-title">
      <form data-ac-create-form>
        <h2 id="ac-create-title">New reservation</h2>
        <p class="hint" data-ac-create-summary></p>
        <div class="ac-form-grid">
          <label>Space
            <select name="spaceId" data-ac-create-space required>
              ${allSpaces.map((space) => html`<option value="${space.id}">${space.code} \u2014 ${space.name}</option>`)}
            </select>
          </label>
          <label>Date
            <input type="date" name="date" data-ac-create-date required>
          </label>
          <label>Start
            <input type="time" name="startTime" step="900" data-ac-create-start required>
          </label>
          <label>End
            <input type="time" name="endTime" step="900" data-ac-create-end required>
          </label>
          <label>Units / desks
            <input type="number" name="unitCount" min="1" max="500" value="1" data-ac-create-units>
          </label>
          <label>Purpose
            <input type="text" name="purpose" maxlength="2000" placeholder="Team workshop" data-ac-create-purpose>
          </label>
          <div class="ac-field ac-field--full">
            <label for="ac-create-customer-search">Existing customer</label>
            <input id="ac-create-customer-search" type="search" name="customerSearch" autocomplete="off"
                   placeholder="Search by name, email or organisation" data-ac-customer-search>
            <input type="hidden" name="customerId" data-ac-customer-id>
            <div class="ac-customer-results" data-ac-customer-results hidden></div>
            <p class="hint" data-ac-customer-chosen>No customer selected. Fill the new-customer fields below, or search and pick an existing profile.</p>
          </div>
          <label>New customer name
            <input type="text" name="newCustomerName" maxlength="160" data-ac-new-customer-name>
          </label>
          <label>New customer email
            <input type="email" name="newCustomerEmail" maxlength="254" data-ac-new-customer-email>
          </label>
          <label>New customer telephone
            <input type="tel" name="newCustomerPhone" maxlength="40" data-ac-new-customer-phone>
          </label>
          <label>Organisation
            <input type="text" name="newCustomerOrganization" maxlength="160" data-ac-new-customer-organization>
          </label>
        </div>
        <p class="ac-form-error" data-ac-create-error role="alert"></p>
        <div class="ac-dialog__actions">
          <button class="ac-btn" type="button" data-ac-create-cancel>Cancel</button>
          <button class="ac-btn ac-btn--primary" type="submit">Create reservation</button>
        </div>
      </form>
    </dialog>

    <div class="ac-toast" data-ac-toast role="status" aria-live="polite"></div>
    </section>
  </div>`;

  return adminShell({
    title: 'Calendar',
    subtitle: 'Day and week planning for TRACE. Holds reserve inventory; pending requests are annotations until approved.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/calendar',
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Calendar' }],
    extraStyles: ['/assets/admin-calendar.css'],
    extraScripts: ['/assets/admin-calendar.js'],
    body,
  });
}

/* ------------------------------------------------------------- entry points */

export function renderCalendarPage({
  actor, csrfToken, flash = null, filters = {}, spaces = [], dayGrids = [],
  nav = null, unknownSpace = false, eventsUrl = '/api/admin/calendar/events',
  events = null, data = null, today = null, range = null,
}) {
  const view = 'day';
  const rootData = data ?? { dayGrids };
  return renderCalendarShell({
    actor, csrfToken, flash,
    filters: { ...filters, view, date: filters.date ?? todayBusinessDate() },
    spaces,
    nav,
    unknownSpace,
    eventsUrl,
    events: events ?? (data?.events ?? null),
    data: rootData,
    today,
    range,
  });
}

export function renderCalendarWeekPage({
  actor, csrfToken, flash = null, filters = {}, spaces = [], days = [],
  nav = null, unknownSpace = false, eventsUrl = '/api/admin/calendar/events',
  events = null, data = null, today = null, range = null,
}) {
  const view = 'week';
  const rootData = data ?? { days };
  return renderCalendarShell({
    actor, csrfToken, flash,
    filters: { ...filters, view, date: filters.date ?? todayBusinessDate() },
    spaces,
    nav,
    unknownSpace,
    eventsUrl,
    events: events ?? (data?.events ?? null),
    data: rootData,
    today,
    range,
  });
}

/* Kept for compatibility with older imports/tests. */
export function dedupeGridOccupants(rows = []) {
  const seen = new Map();
  for (const row of rows) {
    const key = row.reservationId
      ? `reservation:${row.reservationId}`
      : row.maintenanceBlockId
        ? `maintenance:${row.maintenanceBlockId}`
        : row.source === 'MAINTENANCE'
          ? `maintenance:${row.maintenanceReason ?? ''}|${row.startAt}|${row.endAt}`
          : `occupancy:${row.occupancyId}`;
    if (!seen.has(key)) seen.set(key, { ...row, unitCodes: [] });
    const entry = seen.get(key);
    if (row.unitCode && !entry.unitCodes.includes(row.unitCode)) entry.unitCodes.push(row.unitCode);
  }
  return [...seen.values()];
}

export function timelineLegend() {
  return html`<ul class="timeline-legend ac-legend">
    <li class="is-free">Free \u2014 at least one unit bookable</li>
    <li class="is-busy">Fully booked \u2014 every unit claimed</li>
  </ul>`;
}

export { HOUR_HEIGHT, WEEKDAYS, dayHeading, rangeLabel };
