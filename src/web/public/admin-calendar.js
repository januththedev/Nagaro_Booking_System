/* TRACE Ops interactive calendar.
 *
 * The server renders the grid, space columns and agenda. This module hydrates
 * the grid from the unified feed, adds drag-to-create/move/resize, and opens
 * the detail and quick-create drawers. It is deliberately dependency-free.
 */
'use strict';

(function () {
  var root = document.querySelector('[data-admin-calendar]');
  if (!root) return;

  var spacesScript = document.querySelector('[data-ac-spaces]');
  var eventsScript = document.querySelector('[data-ac-initial-events]');
  var spaces = readJson(spacesScript, []);
  var state = {
    events: readJson(eventsScript, []),
    selected: null,
    drag: null,
    createDrag: null,
    moveEvent: null,
    customerResults: []
  };
  var gridStart = Number(root.getAttribute('data-ac-grid-start') || 0);
  var gridEnd = Number(root.getAttribute('data-ac-grid-end') || 1440);
  var HOUR_HEIGHT = 64;
  var DAY_MS = 86400000;
  var SLST_OFFSET = 5.5 * 60 * 60 * 1000;
  var csrf = root.getAttribute('data-ac-csrf-token') || '';
  var eventsUrl = root.getAttribute('data-ac-events-url') || '/api/admin/calendar/events';
  var rescheduleUrl = root.getAttribute('data-ac-reschedule-url') || '/api/admin/calendar/reschedule';
  var createUrl = root.getAttribute('data-ac-create-url') || '/api/admin/reservations';
  var customersUrl = root.getAttribute('data-ac-customers-url') || '/api/admin/customers/search';
  var toastTimer = null;

  function readJson(node, fallback) {
    if (!node) return fallback;
    try { return JSON.parse(node.textContent || ''); } catch { return fallback; }
  }

  function pad(value) { return value < 10 ? '0' + value : String(value); }
  function epochOf(dateKey, clock) { return Date.parse(dateKey + 'T' + clock + ':00+05:30'); }
  function dateKeyOf(epochMs) { return new Date(Number(epochMs) + SLST_OFFSET).toISOString().slice(0, 10); }
  function clockOf(epochMs) {
    var d = new Date(Number(epochMs) + SLST_OFFSET);
    return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }
  function minuteOf(epochMs, dateKey) { return (Number(epochMs) - epochOf(dateKey, '00:00')) / 60000; }
  function snapMinute(minute, step) {
    var size = Number(step) || 15;
    return Math.round(minute / size) * size;
  }
  function addDaysKey(key, days) {
    return new Date(Date.parse(key + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function selectedSpace() {
    var id = Number(root.getAttribute('data-ac-space') || 0);
    return spaces.find(function (space) { return Number(space.id) === id; }) || null;
  }
  function kindLabel(kind) {
    return { RESERVATION: 'Booking', MAINTENANCE: 'Maintenance', HOLD: 'Payment hold', REQUEST: 'Pending request' }[kind] || 'Calendar event';
  }
  function eventTitle(event) {
    if (event.kind === 'MAINTENANCE') return event.reason || 'Maintenance';
    if (event.kind === 'REQUEST') return event.reference || 'Pending request';
    return event.reference || event.spaceCode || 'Booking';
  }
  function eventTime(event, dateKey) {
    var start = Math.max(Number(event.startAt), epochOf(dateKey, '00:00'));
    var end = Math.min(Number(event.endAt), epochOf(dateKey, '00:00') + DAY_MS);
    return clockOf(start) + '\u2013' + clockOf(end);
  }
  function showToast(message, tone) {
    var node = root.querySelector('[data-ac-toast]');
    if (!node) return;
    node.textContent = message;
    node.className = 'ac-toast is-visible' + (tone ? ' ac-toast--' + tone : '');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { node.className = 'ac-toast'; }, 4200);
  }
  function request(path, options) {
    var init = options || {};
    return fetch(path, Object.assign({}, init, {
      credentials: 'same-origin',
      headers: Object.assign({
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-csrf-token': csrf
      }, init.headers || {})
    })).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) {
          var error = new Error(body && body.error && body.error.message ? body.error.message : 'The request could not be completed.');
          error.status = response.status;
          error.body = body;
          throw error;
        }
        return body;
      });
    });
  }

  /* ---------------------------------------------------------------- layout */

  function layoutSegments(items, dayStart, dayEnd) {
    var segments = [];
    items.forEach(function (event) {
      var start = Math.max(Number(event.startAt), dayStart);
      var end = Math.min(Number(event.endAt), dayEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      segments.push({
        event: event,
        startAt: start,
        endAt: end,
        startMinute: (start - dayStart) / 60000,
        endMinute: (end - dayStart) / 60000,
        lane: 0,
        laneCount: 1
      });
    });
    segments.sort(function (a, b) {
      return (a.startMinute - b.startMinute) || (a.endMinute - b.endMinute) || String(a.event.id).localeCompare(String(b.event.id));
    });
    var cluster = [];
    var laneEnds = [];
    var clusterEnd = -Infinity;
    function finalise() {
      var count = Math.max(1, laneEnds.length);
      cluster.forEach(function (segment) { segment.laneCount = count; });
      cluster = [];
      laneEnds = [];
      clusterEnd = -Infinity;
    }
    segments.forEach(function (segment) {
      if (cluster.length && segment.startMinute >= clusterEnd) finalise();
      var lane = laneEnds.findIndex(function (end) { return end <= segment.startMinute; });
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(segment.endMinute);
      } else {
        laneEnds[lane] = segment.endMinute;
      }
      segment.lane = lane;
      cluster.push(segment);
      clusterEnd = Math.max(clusterEnd, segment.endMinute);
    });
    if (cluster.length) finalise();
    return segments;
  }

  function eventClass(event) {
    var status = String(event.status || '').toLowerCase();
    var classes = ['ac-event', 'ac-event--' + String(event.kind || 'reservation').toLowerCase()];
    if (status) classes.push('ac-event--status-' + status.replace(/[^a-z0-9_-]/g, ''));
    if (event.kind === 'REQUEST') classes.push('ac-event--request');
    if (event.kind === 'HOLD') classes.push('ac-event--hold');
    if (event.kind === 'RESERVATION' && event.canMove) classes.push('ac-event--movable');
    return classes.join(' ');
  }

  function renderColumn(column) {
    var dateKey = column.getAttribute('data-date');
    var spaceId = column.getAttribute('data-space-id');
    var dayStart = epochOf(dateKey, '00:00');
    var dayEnd = dayStart + DAY_MS;
    var laneWrap = column.querySelector('[data-ac-events]');
    if (!laneWrap) return;
    laneWrap.textContent = '';
    laneWrap.style.height = ((gridEnd - gridStart) / 60 * HOUR_HEIGHT) + 'px';

    var items = state.events.filter(function (event) {
      if (Number(event.startAt) >= dayEnd || Number(event.endAt) <= dayStart) return false;
      if (spaceId && Number(event.spaceId) !== Number(spaceId)) return false;
      return true;
    });
    if (column.classList.contains('is-today')) {
      var now = Date.now();
      var nowMinute = (now - dayStart) / 60000;
      if (nowMinute >= gridStart && nowMinute <= gridEnd) {
        var line = el('span', 'ac-now-line');
        line.style.top = ((nowMinute - gridStart) * HOUR_HEIGHT / 60) + 'px';
        line.setAttribute('aria-hidden', 'true');
        laneWrap.appendChild(line);
      }
    }
    layoutSegments(items, dayStart, dayEnd).forEach(function (segment) {
      var event = segment.event;
      var node = el('article', eventClass(event));
      node.setAttribute('data-ac-event', String(event.id));
      node.setAttribute('data-event-id', String(event.id));
      node.setAttribute('tabindex', '0');
      node.setAttribute('role', 'button');
      node.setAttribute('aria-label', kindLabel(event.kind) + ' ' + eventTitle(event) + ', ' + eventTime(event, dateKey));
      node.style.top = Math.max(0, (segment.startMinute - gridStart) * HOUR_HEIGHT / 60) + 'px';
      node.style.height = Math.max(20, (segment.endMinute - segment.startMinute) * HOUR_HEIGHT / 60 - 2) + 'px';
      node.style.left = 'calc(' + (segment.lane / segment.laneCount * 100) + '% + 2px)';
      node.style.width = 'calc(' + (100 / segment.laneCount) + '% - 4px)';

      node.appendChild(el('span', 'ac-event__time', eventTime(event, dateKey)));
      var title = el('strong', 'ac-event__title');
      title.textContent = kindLabel(event.kind) + ' \u00b7 ' + eventTitle(event);
      node.appendChild(title);
      var metaBits = [event.spaceCode, event.customerName].filter(Boolean);
      if (metaBits.length) node.appendChild(el('span', 'ac-event__meta', metaBits.join(' \u00b7 ')));
      if (event.kind === 'HOLD' && event.expiresAt) {
        node.appendChild(el('span', 'ac-event__meta', 'Held until ' + clockOf(event.expiresAt)));
      }
      if (event.kind === 'RESERVATION' && event.canMove) {
        var top = el('span', 'ac-event__resize ac-event__resize--top');
        top.setAttribute('data-ac-resize', 'top');
        top.setAttribute('aria-hidden', 'true');
        var bottom = el('span', 'ac-event__resize ac-event__resize--bottom');
        bottom.setAttribute('data-ac-resize', 'bottom');
        bottom.setAttribute('aria-hidden', 'true');
        node.appendChild(top);
        node.appendChild(bottom);
      }
      node.addEventListener('click', function (clickEvent) {
        if (node.getAttribute('data-dragged') === '1') {
          node.setAttribute('data-dragged', '0');
          return;
        }
        if (clickEvent.target.closest('[data-ac-resize]')) return;
        openDrawer(event);
      });
      node.addEventListener('keydown', function (keyEvent) {
        if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
          keyEvent.preventDefault();
          openDrawer(event);
        }
      });
      node.addEventListener('pointerdown', function (pointerEvent) {
        beginEventDrag(pointerEvent, event, node, column, segment);
      });
      laneWrap.appendChild(node);
    });
  }

  function renderGrid() {
    root.querySelectorAll('[data-ac-column]').forEach(renderColumn);
  }

  /* --------------------------------------------------------------- drawer */

  function drawerNode(selector) { return root.querySelector(selector); }
  function closeDrawer() {
    var drawer = drawerNode('[data-ac-drawer]');
    var scrim = drawerNode('[data-ac-scrim]');
    if (drawer) drawer.hidden = true;
    if (scrim) scrim.hidden = true;
    state.selected = null;
  }
  function openDrawer(event) {
    state.selected = event;
    var drawer = drawerNode('[data-ac-drawer]');
    var scrim = drawerNode('[data-ac-scrim]');
    var kind = drawerNode('[data-ac-drawer-kind]');
    var title = drawerNode('[data-ac-drawer-title]');
    var body = drawerNode('[data-ac-drawer-body]');
    if (!drawer || !body) return;
    if (kind) kind.textContent = kindLabel(event.kind);
    if (title) title.textContent = eventTitle(event);
    body.textContent = '';

    var details = el('dl', 'detail-list');
    function detail(label, value) {
      if (!value) return;
      details.appendChild(el('dt', null, label));
      details.appendChild(el('dd', null, value));
    }
    detail('When', eventTime(event, dateKeyOf(event.startAt)));
    detail('Space', [event.spaceCode, event.spaceName].filter(Boolean).join(' \u00b7 '));
    detail('Customer', event.customerName);
    detail('Status', event.status);
    if (event.kind === 'HOLD' && event.expiresAt) detail('Held until', clockOf(event.expiresAt));
    if (event.purpose) detail('Purpose', event.purpose);
    if (event.reason) detail('Reason', event.reason);
    body.appendChild(details);

    var actions = el('div', 'cluster ac-drawer__actions');
    if (event.url) {
      var open = el('a', 'ac-btn', 'Open record');
      open.href = event.url;
      actions.appendChild(open);
    }
    if (event.kind === 'RESERVATION' && event.editUrl) {
      var edit = el('a', 'ac-btn', 'Edit');
      edit.href = event.editUrl;
      actions.appendChild(edit);
      if (event.canMove) {
        var move = el('button', 'ac-btn ac-btn--primary', 'Move / resize');
        move.type = 'button';
        move.addEventListener('click', function () { openMoveDialog(event); });
        actions.appendChild(move);
      }
    }
    if (event.kind === 'REQUEST' && event.bookingRequestId) {
      var approve = el('button', 'ac-btn ac-btn--primary', 'Approve request');
      approve.type = 'button';
      approve.addEventListener('click', function () { decideRequest(event, 'approve'); });
      actions.appendChild(approve);
      var reject = el('button', 'ac-btn ac-btn--danger', 'Reject');
      reject.type = 'button';
      reject.addEventListener('click', function () { decideRequest(event, 'reject'); });
      actions.appendChild(reject);
    }
    body.appendChild(actions);
    drawer.hidden = false;
    if (scrim) scrim.hidden = false;
    var close = drawerNode('[data-ac-close-drawer]');
    if (close) close.focus();
  }

  function decideRequest(event, action) {
    var reason = '';
    if (action === 'reject') {
      reason = window.prompt('Reason for rejecting this request?');
      if (reason === null) return;
      if (!reason.trim()) { showToast('A rejection reason is required.', 'error'); return; }
    }
    request('/api/admin/calendar/requests/' + encodeURIComponent(event.bookingRequestId) + '/' + action, {
      method: 'POST',
      body: JSON.stringify(action === 'reject' ? { reason: reason.trim() } : {})
    }).then(function () {
      closeDrawer();
      showToast(action === 'approve' ? 'Request approved.' : 'Request rejected.', 'ok');
      window.setTimeout(function () { window.location.reload(); }, 700);
    }).catch(function (error) {
      showToast(error.message || 'The request could not be updated.', 'error');
    });
  }

  /* ---------------------------------------------------------- move dialog */

  function openMoveDialog(event) {
    state.moveEvent = event;
    var dialog = root.querySelector('[data-ac-move-dialog]');
    var form = root.querySelector('[data-ac-move-form]');
    if (!dialog || !form) return;
    var select = form.querySelector('[data-ac-move-space]');
    select.textContent = '';
    spaces.forEach(function (space) {
      var option = el('option', null, space.code + ' \u2014 ' + space.name);
      option.value = String(space.id);
      select.appendChild(option);
    });
    select.value = String(event.spaceId || '');
    form.querySelector('[data-ac-move-date]').value = dateKeyOf(event.startAt);
    form.querySelector('[data-ac-move-start]').value = clockOf(event.startAt);
    form.querySelector('[data-ac-move-end]').value = clockOf(event.endAt);
    var summary = form.querySelector('[data-ac-move-summary]');
    if (summary) summary.textContent = event.reference + ' \u00b7 currently ' + eventTime(event, dateKeyOf(event.startAt));
    var error = form.querySelector('[data-ac-move-error]');
    if (error) error.textContent = '';
    closeDrawer();
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', 'open');
  }

  function submitMove(formEvent) {
    formEvent.preventDefault();
    var event = state.moveEvent;
    if (!event) return;
    var date = formEvent.target.querySelector('[data-ac-move-date]').value;
    var start = formEvent.target.querySelector('[data-ac-move-start]').value;
    var end = formEvent.target.querySelector('[data-ac-move-end]').value;
    var spaceId = formEvent.target.querySelector('[data-ac-move-space]').value;
    var error = formEvent.target.querySelector('[data-ac-move-error]');
    if (!date || !start || !end) { if (error) error.textContent = 'Choose a date and time window.'; return; }
    var startAt = epochOf(date, start);
    var endAt = epochOf(date, end);
    if (endAt <= startAt) { if (error) error.textContent = 'The end time must be after the start time.'; return; }
    var payload = { kind: 'reservation', id: event.recordId, startAt: startAt, endAt: endAt, spaceId: Number(spaceId) };
    request(rescheduleUrl, { method: 'POST', body: JSON.stringify(payload) })
      .then(function () {
        var dialog = formEvent.target.closest('dialog');
        if (dialog) dialog.close();
        showToast('Booking moved.', 'ok');
        window.setTimeout(function () { window.location.reload(); }, 600);
      })
      .catch(function (requestError) {
        if (error) error.textContent = requestError.message || 'The booking could not be moved.';
      });
  }

  /* --------------------------------------------------------------- drag */

  function beginEventDrag(pointerEvent, event, node, column, segment) {
    if (pointerEvent.button !== 0) return;
    var handle = pointerEvent.target.closest('[data-ac-resize]');
    if (event.kind !== 'RESERVATION' || !event.canMove) return;
    pointerEvent.preventDefault();
    state.drag = {
      event: event,
      node: node,
      column: column,
      mode: handle ? (handle.getAttribute('data-ac-resize') === 'top' ? 'resize-top' : 'resize-bottom') : 'move',
      startX: pointerEvent.clientX,
      startY: pointerEvent.clientY,
      originalStart: Number(event.startAt),
      originalEnd: Number(event.endAt),
      moved: false,
      newStart: Number(event.startAt),
      newEnd: Number(event.endAt),
      newSpaceId: event.spaceId,
      newDateKey: dateKeyOf(event.startAt)
    };
    node.classList.add('is-dragging');
    if (node.setPointerCapture) node.setPointerCapture(pointerEvent.pointerId);
  }

  function updateDrag(pointerEvent) {
    var drag = state.drag;
    if (!drag) return;
    var dx = pointerEvent.clientX - drag.startX;
    var dy = pointerEvent.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    var minuteDelta = snapMinute(dy / (HOUR_HEIGHT / 60), 15);
    if (drag.mode === 'resize-bottom') {
      drag.newEnd = Math.max(drag.originalStart + 15 * 60000, drag.originalEnd + minuteDelta * 60000);
      drag.newStart = drag.originalStart;
      drag.node.style.height = Math.max(20, (drag.newEnd - drag.newStart) / 60000 * HOUR_HEIGHT / 60 - 2) + 'px';
      return;
    }
    var nextStart = drag.originalStart + minuteDelta * 60000;
    if (drag.mode === 'resize-top') {
      drag.newStart = Math.min(drag.originalEnd - 15 * 60000, nextStart);
      drag.newEnd = drag.originalEnd;
      var topMinute = minuteOf(drag.newStart, dateKeyOf(drag.newStart));
      drag.node.style.top = Math.max(0, (topMinute - gridStart) * HOUR_HEIGHT / 60) + 'px';
      drag.node.style.height = Math.max(20, (drag.newEnd - drag.newStart) / 60000 * HOUR_HEIGHT / 60 - 2) + 'px';
      return;
    }
    drag.newStart = nextStart;
    drag.newEnd = drag.originalEnd + (nextStart - drag.originalStart);
    var under = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY);
    var targetColumn = under && under.closest ? under.closest('[data-ac-column]') : null;
    if (targetColumn) {
      drag.newDateKey = targetColumn.getAttribute('data-date') || drag.newDateKey;
      if (targetColumn.getAttribute('data-space-id')) drag.newSpaceId = Number(targetColumn.getAttribute('data-space-id'));
    }
    var baseMinute = minuteOf(nextStart, dateKeyOf(nextStart));
    drag.node.style.top = Math.max(0, (baseMinute - gridStart) * HOUR_HEIGHT / 60) + 'px';
  }

  function finishDrag(pointerEvent) {
    var drag = state.drag;
    if (!drag) return;
    state.drag = null;
    drag.node.classList.remove('is-dragging');
    if (!drag.moved) return;
    drag.node.setAttribute('data-dragged', '1');
    var baseDate = drag.newDateKey || dateKeyOf(drag.newStart);
    var startClock = clockOf(drag.newStart);
    var duration = drag.newEnd - drag.newStart;
    var startAt = epochOf(baseDate, startClock);
    var endAt = startAt + duration;
    request(rescheduleUrl, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'reservation',
        id: drag.event.recordId,
        startAt: startAt,
        endAt: endAt,
        spaceId: drag.newSpaceId || drag.event.spaceId
      })
    }).then(function () {
      showToast('Booking updated.', 'ok');
      window.setTimeout(function () { window.location.reload(); }, 500);
    }).catch(function (error) {
      showToast(error.message || 'The booking could not be moved. It has not been changed.', 'error');
      window.setTimeout(function () { window.location.reload(); }, 900);
    });
  }

  function beginCreateDrag(pointerEvent, column) {
    if (pointerEvent.button !== 0) return;
    if (pointerEvent.target.closest('[data-ac-event]')) return;
    if (pointerEvent.target.closest('.ac-now-line')) return;
    var wrap = pointerEvent.currentTarget;
    var rect = wrap.getBoundingClientRect();
    var startMinute = gridStart + (pointerEvent.clientY - rect.top) / (HOUR_HEIGHT / 60);
    var ghost = el('span', 'ac-create-ghost');
    ghost.style.left = '2px';
    ghost.style.right = '2px';
    ghost.style.top = Math.max(0, (startMinute - gridStart) * HOUR_HEIGHT / 60) + 'px';
    ghost.style.height = '16px';
    wrap.appendChild(ghost);
    state.createDrag = {
      column: column,
      wrap: wrap,
      ghost: ghost,
      startY: pointerEvent.clientY,
      startMinute: startMinute,
      currentMinute: startMinute
    };
    pointerEvent.preventDefault();
  }

  function updateCreateDrag(pointerEvent) {
    var drag = state.createDrag;
    if (!drag) return;
    var delta = (pointerEvent.clientY - drag.startY) / (HOUR_HEIGHT / 60);
    drag.currentMinute = Math.max(drag.startMinute, drag.startMinute + delta);
    var start = Math.min(drag.startMinute, drag.currentMinute);
    var end = Math.max(drag.startMinute, drag.currentMinute);
    drag.ghost.style.top = Math.max(0, (start - gridStart) * HOUR_HEIGHT / 60) + 'px';
    drag.ghost.style.height = Math.max(16, (end - start) * HOUR_HEIGHT / 60) + 'px';
  }

  function finishCreateDrag() {
    var drag = state.createDrag;
    if (!drag) return;
    state.createDrag = null;
    if (drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    var start = snapMinute(Math.min(drag.startMinute, drag.currentMinute), 15);
    var end = snapMinute(Math.max(drag.startMinute, drag.currentMinute), 15);
    if (end - start < 15) end = start + 60;
    var dateKey = drag.column.getAttribute('data-date');
    var spaceId = drag.column.getAttribute('data-space-id') || (selectedSpace() && selectedSpace().id) || '';
    openCreateDialog({ dateKey: dateKey, spaceId: spaceId, startMinute: start, endMinute: end });
  }

  /* --------------------------------------------------------- create dialog */

  function minuteClock(minute) {
    var value = Math.max(0, Math.min(24 * 60, Math.round(minute)));
    return pad(Math.floor(value / 60)) + ':' + pad(value % 60);
  }

  function openCreateDialog({ dateKey, spaceId, startMinute, endMinute }) {
    var dialog = root.querySelector('[data-ac-create-dialog]');
    var form = root.querySelector('[data-ac-create-form]');
    if (!dialog || !form) return;
    form.reset();
    form.querySelector('[data-ac-create-date]').value = dateKey;
    form.querySelector('[data-ac-create-space]').value = String(spaceId || (spaces[0] && spaces[0].id) || '');
    form.querySelector('[data-ac-create-start]').value = minuteClock(startMinute);
    form.querySelector('[data-ac-create-end]').value = minuteClock(endMinute);
    form.querySelector('[data-ac-create-units]').value = '1';
    form.querySelector('[data-ac-customer-id]').value = '';
    var chosen = form.querySelector('[data-ac-customer-chosen]');
    if (chosen) chosen.textContent = 'No customer selected. Fill the new-customer fields below, or search and pick an existing profile.';
    var results = form.querySelector('[data-ac-customer-results]');
    if (results) { results.textContent = ''; results.hidden = true; }
    var summary = form.querySelector('[data-ac-create-summary]');
    if (summary) {
      var space = spaces.find(function (item) { return Number(item.id) === Number(spaceId); });
      summary.textContent = (space ? space.code + ' \u00b7 ' + space.name + ' \u00b7 ' : '') + dateKey + ' ' + minuteClock(startMinute) + '\u2013' + minuteClock(endMinute);
    }
    var error = form.querySelector('[data-ac-create-error]');
    if (error) error.textContent = '';
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', 'open');
    var name = form.querySelector('[data-ac-new-customer-name]');
    if (name) name.focus();
  }

  function searchCustomers(form, query) {
    var term = String(query || '').trim();
    var results = form.querySelector('[data-ac-customer-results]');
    if (!results) return;
    if (term.length < 2) { results.hidden = true; results.textContent = ''; return; }
    window.clearTimeout(form.__customerTimer);
    form.__customerTimer = window.setTimeout(function () {
      request(customersUrl + '?q=' + encodeURIComponent(term))
        .then(function (body) {
          var items = Array.isArray(body.items) ? body.items : (Array.isArray(body) ? body : []);
          results.textContent = '';
          if (!items.length) {
            results.hidden = false;
            results.appendChild(el('p', 'hint', 'No matching customer. Fill the new-customer fields below.'));
            return;
          }
          items.slice(0, 8).forEach(function (customer) {
            var button = el('button', 'ac-customer-result', [customer.fullName, customer.email, customer.organization].filter(Boolean).join(' \u00b7 '));
            button.type = 'button';
            button.addEventListener('click', function () {
              form.querySelector('[data-ac-customer-id]').value = String(customer.id);
              var chosen = form.querySelector('[data-ac-customer-chosen]');
              if (chosen) chosen.textContent = 'Selected: ' + customer.fullName + (customer.email ? ' \u00b7 ' + customer.email : '');
              results.hidden = true;
            });
            results.appendChild(button);
          });
          results.hidden = false;
        })
        .catch(function () { results.hidden = true; });
    }, 220);
  }

  function submitCreate(formEvent) {
    formEvent.preventDefault();
    var form = formEvent.target;
    var error = form.querySelector('[data-ac-create-error]');
    var date = form.querySelector('[data-ac-create-date]').value;
    var start = form.querySelector('[data-ac-create-start]').value;
    var end = form.querySelector('[data-ac-create-end]').value;
    var spaceId = form.querySelector('[data-ac-create-space]').value;
    var customerId = form.querySelector('[data-ac-customer-id]').value;
    var name = form.querySelector('[data-ac-new-customer-name]').value.trim();
    var email = form.querySelector('[data-ac-new-customer-email]').value.trim();
    if (!date || !start || !end || !spaceId) { if (error) error.textContent = 'Choose a space, date and time window.'; return; }
    if (!customerId && (!name || !email)) { if (error) error.textContent = 'Pick an existing customer or enter a new customer name and email.'; return; }
    var payload = {
      space_id: spaceId,
      date: date,
      start_time: start,
      end_time: end,
      unit_count: form.querySelector('[data-ac-create-units]').value || '1',
      purpose: form.querySelector('[data-ac-create-purpose]').value,
      form_token: (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + Math.random())
    };
    if (customerId) payload.customer_id = customerId;
    else {
      payload.new_customer_name = name;
      payload.new_customer_email = email;
      payload.new_customer_phone = form.querySelector('[data-ac-new-customer-phone]').value;
      payload.new_customer_organization = form.querySelector('[data-ac-new-customer-organization]').value;
    }
    var submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    request(createUrl, { method: 'POST', body: JSON.stringify(payload) })
      .then(function () {
        var dialog = form.closest('dialog');
        if (dialog) dialog.close();
        showToast('Reservation created.', 'ok');
        window.setTimeout(function () { window.location.reload(); }, 600);
      })
      .catch(function (requestError) {
        if (error) error.textContent = requestError.message || 'The reservation could not be created.';
      })
      .finally(function () { if (submit) submit.disabled = false; });
  }

  /* --------------------------------------------------------------- wiring */

  renderGrid();

  root.querySelectorAll('[data-ac-events]').forEach(function (wrap) {
    wrap.addEventListener('pointerdown', function (event) { beginCreateDrag(event, wrap.closest('[data-ac-column]')); });
  });

  document.addEventListener('pointermove', function (event) {
    if (state.drag) updateDrag(event);
    if (state.createDrag) updateCreateDrag(event);
  });
  document.addEventListener('pointerup', function (event) {
    if (state.drag) finishDrag(event);
    if (state.createDrag) finishCreateDrag();
  });
  document.addEventListener('pointercancel', function () {
    if (state.drag) { state.drag.node.classList.remove('is-dragging'); state.drag = null; }
    if (state.createDrag) {
      if (state.createDrag.ghost.parentNode) state.createDrag.ghost.parentNode.removeChild(state.createDrag.ghost);
      state.createDrag = null;
    }
  });

  var close = root.querySelector('[data-ac-close-drawer]');
  if (close) close.addEventListener('click', closeDrawer);
  var scrim = root.querySelector('[data-ac-scrim]');
  if (scrim) scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeDrawer();
  });

  var moveForm = root.querySelector('[data-ac-move-form]');
  if (moveForm) moveForm.addEventListener('submit', submitMove);
  var moveCancel = root.querySelector('[data-ac-move-cancel]');
  if (moveCancel) moveCancel.addEventListener('click', function () {
    var dialog = moveCancel.closest('dialog'); if (dialog) dialog.close();
  });

  var createForm = root.querySelector('[data-ac-create-form]');
  if (createForm) {
    createForm.addEventListener('submit', submitCreate);
    var createCancel = createForm.querySelector('[data-ac-create-cancel]');
    if (createCancel) createCancel.addEventListener('click', function () {
      var dialog = createCancel.closest('dialog'); if (dialog) dialog.close();
    });
    var customerSearch = createForm.querySelector('[data-ac-customer-search]');
    if (customerSearch) customerSearch.addEventListener('input', function () { searchCustomers(createForm, customerSearch.value); });
  }

  // Open the quick-create dialog from the toolbar button without leaving the
  // calendar. The plain link remains the no-JavaScript fallback.
  var newReservation = root.querySelector('[data-ac-new-reservation]');
  if (newReservation) {
    newReservation.addEventListener('click', function (event) {
      event.preventDefault();
      var space = root.getAttribute('data-ac-space') || (spaces[0] && spaces[0].id) || '';
      openCreateDialog({
        dateKey: root.getAttribute('data-ac-date') || dateKeyOf(Date.now()),
        spaceId: space,
        startMinute: Math.max(gridStart, 9 * 60),
        endMinute: Math.max(gridStart + 60, 10 * 60)
      });
    });
  }

  // Refresh the feed while keeping the server-rendered grid usable. A failed
  // refresh leaves the existing schedule visible.
  function refreshFeed() {
    var from = epochOf(root.getAttribute('data-ac-date'), '00:00');
    var to = from + (root.getAttribute('data-ac-view') === 'week' ? 7 : 1) * DAY_MS;
    request(eventsUrl + '?from=' + from + '&to=' + to).then(function (body) {
      if (Array.isArray(body.events)) { state.events = body.events; renderGrid(); }
    }).catch(function () { /* offline / session expiry */ });
  }
  window.setInterval(function () {
    if (document.visibilityState === 'visible') refreshFeed();
  }, 120000);
})();
