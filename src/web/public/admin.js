/**
 * Nagaro Space Booking — admin console progressive enhancement.
 * src/web/public/admin.js  (ES module, no dependencies, no build step)
 *
 * Everything here is an enhancement layered on top of ordinary HTML forms.
 * With JavaScript disabled the admin console still works: the sidebar is
 * always visible, the customer field is a plain text input, availability is
 * revalidated by the server on POST, and destructive actions are confirmed by
 * the server's own rules. The live checks below are *courtesy* checks that
 * make conflicts visible before submission. They never replace, weaken or
 * duplicate the server's transaction-level revalidation, and the server
 * remains the only authority on whether a booking can be made.
 *
 * Data-attribute contracts (see docs/UX_GUIDE.md):
 *   [data-sidebar-toggle]                opens the off-canvas sidebar (<900px)
 *   [data-flash] with [data-dismiss]     dismissible alert
 *   form[data-confirm]                   confirm() text before submitting
 *   [data-customer-search]               combobox input (or role="combobox")
 *   [name=customer_id]                   hidden id the picker fills
 *   [data-customer-display]              visible summary of the selection
 *   [data-customer-clear]                "clear" control
 *   [data-new-customer-fields]           inline new-customer fieldset
 *   [data-reservation-form]              booking form to watch (or the first
 *                                        form containing [name=space_id])
 *   [name=space_id] [name=start_date] [name=start_time] [name=end_time]
 *   [name=unit_count]                    live availability inputs
 *   [data-availability-result]           live-check output region
 *   [data-desk-hint]                     remaining-desk hint line
 *   .filter-bar__field select            auto-submitting filter dropdowns
 *
 * House rules: no innerHTML — every server string reaches the DOM through
 * textContent; every lookup is null-safe; each feature is independent.
 */

'use strict';

var DEBOUNCE_MS = 400;
var SEARCH_DEBOUNCE_MS = 200;
var DEFAULT_TZ_OFFSET = '+05:30';
var BUSINESS_TIME_ZONE = 'Asia/Colombo';

/* ------------------------------------------------------------------ helpers */

function one(root, selector) {
  return root && typeof root.querySelector === 'function' ? root.querySelector(selector) : null;
}

function all(root, selector) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return Array.prototype.slice.call(root.querySelectorAll(selector));
}

function setText(node, value) {
  if (node) node.textContent = value == null ? '' : String(value);
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function makeElement(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function debounce(fn, wait) {
  var timer = null;
  return function () {
    var args = Array.prototype.slice.call(arguments);
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(function () {
      timer = null;
      fn.apply(null, args);
    }, wait);
  };
}

function tzOffset(form) {
  var fromForm = form && form.dataset ? trim(form.dataset.tzOffset) : '';
  var fromBody = document.body && document.body.dataset ? trim(document.body.dataset.tzOffset) : '';
  var candidate = fromForm || fromBody;
  return /^[+-]\d{2}:\d{2}$/.test(candidate) ? candidate : DEFAULT_TZ_OFFSET;
}

function wallClockToIso(dateValue, timeValue, offset) {
  var date = trim(dateValue);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  var match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trim(timeValue));
  if (!match) return null;
  if (Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return date + 'T' + match[1] + ':' + match[2] + ':' + (match[3] || '00') + offset;
}

function localInputToIso(value, offset) {
  var match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trim(value));
  if (!match) return null;
  return wallClockToIso(match[1], match[2] + ':' + match[3] + ':' + (match[4] || '00'), offset);
}

function formatInstant(value) {
  var epoch = typeof value === 'number' ? value : Date.parse(trim(value));
  if (!Number.isFinite(epoch)) return trim(value);
  var date = new Date(epoch);
  if (Number.isNaN(date.getTime())) return trim(value);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: BUSINESS_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/* Screen-reader announcements for asynchronous results. */
var announcerRegion = null;

function announcer() {
  if (announcerRegion && document.body.contains(announcerRegion)) return announcerRegion;
  announcerRegion = one(document, '[data-announcer]');
  if (!announcerRegion) {
    announcerRegion = makeElement('div', 'visually-hidden');
    announcerRegion.setAttribute('role', 'status');
    announcerRegion.setAttribute('aria-live', 'polite');
    announcerRegion.setAttribute('aria-atomic', 'true');
    announcerRegion.setAttribute('data-announcer', '');
    document.body.appendChild(announcerRegion);
  }
  return announcerRegion;
}

function announce(message) {
  if (!message) return;
  setText(announcer(), message);
}

/* ------------------------------------------------------------ admin sidebar */

function initSidebar() {
  var toggle = one(document, '[data-sidebar-toggle]');
  var sidebar = one(document, '.admin-sidebar');
  if (!toggle || !sidebar) return;

  var controls = toggle.getAttribute('aria-controls');
  if (controls && !document.getElementById(controls)) sidebar.id = controls;

  function isOpen() {
    return toggle.getAttribute('aria-expanded') === 'true';
  }

  function setOpen(open, returnFocus) {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('sidebar-open', open);
    if (!open && returnFocus) toggle.focus();
  }

  setOpen(isOpen(), false);

  toggle.addEventListener('click', function () {
    setOpen(!isOpen(), false);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen()) setOpen(false, true);
  });

  document.addEventListener('click', function (event) {
    if (!isOpen()) return;
    var target = event.target;
    if (sidebar.contains(target) || toggle.contains(target)) return;
    setOpen(false, false);
  });

  window.addEventListener('resize', debounce(function () {
    if (window.innerWidth >= 900 && isOpen()) setOpen(false, false);
  }, 150));
}

/* ------------------------------------------------- dismissible flash alerts */

function initFlashDismiss() {
  all(document, '[data-dismiss]').forEach(function (button) {
    button.addEventListener('click', function () {
      var flash = button.closest('[data-flash]');
      if (flash && flash.parentNode) flash.parentNode.removeChild(flash);
    });
  });
}

/* ----------------------------------------------------- confirmation guard */

function initConfirmGuards() {
  all(document, 'form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      var message = trim(form.dataset.confirm) || 'Are you sure? This cannot be undone.';
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
  });
}

/* ---------------------------------------------------------------- combobox */

function customerLabel(item) {
  var name = trim(item.fullName) || 'Unnamed customer';
  var email = trim(item.email);
  var organization = trim(item.organization);
  var parts = [name];
  if (email) parts.push(email);
  if (organization) parts.push(organization);
  return parts.join(' — ');
}

function initCustomerPicker() {
  var input = one(document, '[data-customer-search]')
    || one(document, 'input[role="combobox"][aria-controls]');
  if (!input) return;

  var scope = input.form || document;
  var hidden = one(scope, '[name=customer_id]');
  var display = one(scope, '[data-customer-display]');
  var clearControl = one(scope, '[data-customer-clear]');
  var newFields = one(scope, '[data-new-customer-fields]');
  var newToggle = one(scope, '[data-new-customer-toggle]');
  if (!hidden) return;

  var wrapper = input.parentElement;
  if (wrapper && wrapper.classList && !wrapper.classList.contains('combobox')) {
    wrapper.classList.add('combobox');
  }

  var listId = input.getAttribute('aria-controls') || 'customer-search-listbox';
  var list = document.getElementById(listId);
  if (!list) {
    list = makeElement('ul', 'combobox__list');
    list.id = listId;
    list.setAttribute('role', 'listbox');
    (wrapper || document.body).appendChild(list);
  }
  list.setAttribute('role', 'listbox');
  list.hidden = true;

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('autocomplete', 'off');
  if (!input.id) input.id = 'customer-search';

  var results = [];        /* rendered option elements, in order */
  var activeIndex = -1;
  var byId = {};           /* id -> customer record from the server */
  var lastQuery = '';

  function optionId(index) {
    return input.id + '-option-' + index;
  }

  function setNewFieldsVisible(visible) {
    if (!newFields) return;
    /* bookingViews.js renders this block as `<details … open>` — the path that
       works without JavaScript — so "reveal" means opening the disclosure and
       we must never hide it: hiding would remove the no-JS fallback from a
       browser that has JS but has not touched the picker. */
    if (newFields.tagName === 'DETAILS') {
      if (visible) newFields.open = true;
      return;
    }
    newFields.hidden = !visible;
  }

  function newFieldsAreDetails() {
    return Boolean(newFields) && newFields.tagName === 'DETAILS';
  }

  function closeList() {
    list.hidden = true;
    activeIndex = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function setActive(index) {
    if (results.length === 0) return;
    var next = index;
    if (next < 0) next = results.length - 1;
    if (next >= results.length) next = 0;
    activeIndex = next;
    results.forEach(function (option, position) {
      var selected = position === next;
      option.classList.toggle('is-active', selected);
      option.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    input.setAttribute('aria-activedescendant', results[next].id);
    if (typeof results[next].scrollIntoView === 'function') {
      results[next].scrollIntoView({ block: 'nearest' });
    }
  }

  function openList() {
    list.hidden = false;
    /* Anchor the popup under the input rather than under the whole wrapper:
       the view's wrapper also holds the hint, the "New customer" and "Clear"
       buttons, so `top: 100%` would drop the list below all of them. */
    var anchor = input.offsetTop + input.offsetHeight + 2;
    if (Number.isFinite(anchor)) list.style.top = anchor + 'px';
    input.setAttribute('aria-expanded', 'true');
  }

  function showMessage(message) {
    clear(list);
    results = [];
    activeIndex = -1;
    var item = makeElement('li', 'combobox__option combobox__option--hint', message);
    item.setAttribute('role', 'presentation');
    item.setAttribute('aria-disabled', 'true');
    list.appendChild(item);
    openList();
  }

  function renderResults(items, query) {
    clear(list);
    results = [];
    activeIndex = -1;

    items.forEach(function (item) {
      if (!item || item.id == null) return;
      var option = makeElement('li', 'combobox__option', customerLabel(item));
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.id = optionId(results.length);
      option.dataset.customerId = String(item.id);
      byId[String(item.id)] = item;
      list.appendChild(option);
      results.push(option);
    });

    if (items.length === 0) {
      var empty = makeElement('li', 'combobox__option combobox__option--empty', 'No matching customer.');
      empty.setAttribute('role', 'presentation');
      list.appendChild(empty);
    }

    /* Creating a customer inline must always be reachable, including when the
       search matches nothing — that is exactly when it is needed. */
    var create = makeElement(
      'li',
      'combobox__option combobox__option--new',
      query ? 'New customer: use “' + query + '”' : 'New customer',
    );
    create.setAttribute('role', 'option');
    create.setAttribute('aria-selected', 'false');
    create.id = optionId(results.length);
    create.dataset.newCustomer = 'true';
    list.appendChild(create);
    results.push(create);

    openList();
  }

  function selectCustomer(item) {
    hidden.value = String(item.id);
    input.value = trim(item.fullName) || '';
    setNewFieldsVisible(false);
    if (display) {
      var email = trim(item.email);
      setText(display, email ? customerLabel(item) : (trim(item.fullName) || ''));
    }
    closeList();
    announce('Customer selected: ' + (trim(item.fullName) || String(item.id)) + '.');
  }

  function chooseNewCustomer() {
    hidden.value = '';
    setNewFieldsVisible(true);
    setText(display, 'New customer — complete the details below.');
    closeList();
    var firstField = newFields ? one(newFields, 'input:not([type=hidden]), select, textarea') : null;
    if (firstField && typeof firstField.focus === 'function') firstField.focus();
    announce('New customer fields revealed. Complete the customer details below.');
  }

  function chooseOption(option) {
    if (!option) return;
    if (option.dataset && option.dataset.newCustomer === 'true') {
      chooseNewCustomer();
      return;
    }
    var id = option.dataset ? option.dataset.customerId : '';
    var record = id ? byId[id] : null;
    if (record) selectCustomer(record);
  }

  var search = debounce(function (query) {
    if (!query) {
      closeList();
      return;
    }
    if (query === lastQuery) return;
    lastQuery = query;
    var params = new URLSearchParams();
    params.set('q', query);
    fetch('/api/admin/customers/search?' + params.toString(), {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { ok: response.ok, payload: payload };
        }, function () {
          return { ok: false, payload: null };
        });
      })
      .then(function (result) {
        if (!result.ok || !result.payload || result.payload.error) {
          showMessage('Customer search is unavailable — type the full name and the server will still match it.');
          return;
        }
        var items = Array.isArray(result.payload.items) ? result.payload.items : [];
        renderResults(items, query);
      })
      .catch(function () {
        showMessage('Customer search is unavailable — check the connection or enter the customer by hand.');
      });
  }, SEARCH_DEBOUNCE_MS);

  input.addEventListener('input', function () {
    search(trim(input.value));
  });
  input.addEventListener('focus', function () {
    if (trim(input.value)) search(trim(input.value));
  });

  input.addEventListener('keydown', function (event) {
    var key = event.key;
    if (key === 'ArrowDown') {
      if (list.hidden) {
        if (trim(input.value)) search(trim(input.value));
        return;
      }
      event.preventDefault();
      setActive(activeIndex + 1);
      return;
    }
    if (key === 'ArrowUp') {
      if (list.hidden) return;
      event.preventDefault();
      setActive(activeIndex - 1);
      return;
    }
    if (key === 'Home' && !list.hidden && results.length) {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (key === 'End' && !list.hidden && results.length) {
      event.preventDefault();
      setActive(results.length - 1);
      return;
    }
    if (key === 'Enter') {
      if (!list.hidden && activeIndex >= 0) {
        event.preventDefault();
        chooseOption(results[activeIndex]);
      }
      return;
    }
    if (key === 'Escape') {
      if (!list.hidden) {
        event.preventDefault();
        closeList();
      }
      return;
    }
    if (key === 'Tab') {
      closeList();
    }
  });

  /* mousedown, not click: selecting must win over the input's blur. */
  list.addEventListener('mousedown', function (event) {
    var option = event.target && event.target.closest ? event.target.closest('[role="option"]') : null;
    if (!option) return;
    event.preventDefault();
    if (option.dataset && option.dataset.newCustomer === 'true') {
      chooseNewCustomer();
      return;
    }
    chooseOption(option);
  });

  document.addEventListener('click', function (event) {
    if (list.hidden) return;
    if (list.contains(event.target) || input.contains(event.target)) return;
    closeList();
  });

  if (clearControl) {
    clearControl.addEventListener('click', function () {
      hidden.value = '';
      input.value = '';
      setText(display, 'Search by name, email or organisation, then pick a customer profile.');
      setNewFieldsVisible(false);
      closeList();
      input.focus();
      announce('Customer cleared.');
    });
  }

  if (newToggle) {
    newToggle.addEventListener('click', function (event) {
      event.preventDefault();
      chooseNewCustomer();
    });
  }

  /* With JavaScript on, the new-customer block is revealed on demand. It is
     hidden here — and only here, never in the HTML — so that a browser without
     JS still shows usable, submittable fields. */
  var hasExistingSelection = Boolean(trim(hidden.value));
  if (newFields) setNewFieldsVisible(false);

  if (hasExistingSelection && display && !trim(display.textContent)) {
    var prefill = byId[trim(hidden.value)];
    setText(display, prefill ? customerLabel(prefill) : 'Selected customer #' + trim(hidden.value));
  }
}

/* --------------------------------------------------- live availability check */

function collectConflicts(payload) {
  if (!payload) return [];
  var containers = [
    payload.conflicts,
    payload.details && payload.details.conflicts,
    payload.error && payload.error.details && payload.error.details.conflicts,
  ];
  for (var i = 0; i < containers.length; i += 1) {
    if (Array.isArray(containers[i]) && containers[i].length) return containers[i];
  }
  return [];
}

function conflictLine(conflict) {
  var label = trim(conflict.label)
    || trim(conflict.reservationReference)
    || trim(conflict.reference)
    || (trim(conflict.source) === 'MAINTENANCE' ? 'Maintenance block' : 'Existing booking');
  var start = conflict.startAt != null ? formatInstant(conflict.startAt) : '';
  var end = conflict.endAt != null ? formatInstant(conflict.endAt) : '';
  var window = start && end ? ' (' + start + ' → ' + end + ')' : '';
  var unit = trim(conflict.unitLabel) || trim(conflict.unitCode);
  return label + window + (unit ? ' · ' + unit : '');
}

function initLiveAvailability() {
  var form = one(document, '[data-reservation-form]') || findBookingForm();
  if (!form) return;

  var region = one(form, '[data-availability-result]') || one(document, '[data-availability-result]');
  var deskHint = one(form, '[data-desk-hint]') || one(document, '[data-desk-hint]');
  var submitButtons = all(form, 'button[type="submit"], input[type="submit"]');
  /* Without a display target there is nothing to report into: leave the form
     exactly as the server rendered it. */
  if (!region) return;
  if (!region.getAttribute('aria-live')) region.setAttribute('aria-live', 'polite');

  /* The views do not render [data-desk-hint], so create it next to the desk
     field: the remaining-desk count is part of the requested behaviour and
     must not depend on markup another agent may not have added. */
  if (!deskHint) {
    var deskField = one(form, '[name=unit_count]') || one(form, '[name=desks]');
    var host = deskField && deskField.closest ? (deskField.closest('.form-field') || deskField.parentElement) : null;
    if (host) {
      deskHint = makeElement('p', 'hint desk-hint', '');
      deskHint.setAttribute('data-desk-hint', '');
      deskHint.setAttribute('aria-live', 'polite');
      host.appendChild(deskHint);
    }
  }

  var watched = [
    '[name=space_id]', '[name=space]', '[name=start_date]', '[name=date]',
    '[name=start_time]', '[name=end_time]', '[name=start_at]', '[name=end_at]',
    '[name=unit_count]', '[name=desks]',
  ].map(function (selector) {
    return one(form, selector);
  }).filter(Boolean);

  if (watched.length === 0) return;

  function setSubmitBlocked(blocked, reason) {
    form.dataset.availabilityState = blocked ? 'busy' : 'free';
    submitButtons.forEach(function (button) {
      if (blocked) {
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
        button.setAttribute('data-blocked-reason', reason || '');
      } else {
        button.disabled = false;
        button.removeAttribute('aria-disabled');
        button.removeAttribute('data-blocked-reason');
      }
    });
  }

  function renderRegion(state) {
    clear(region);
    region.classList.remove('availability-result--ok', 'availability-result--busy');
    if (state.kind === 'ok') region.classList.add('availability-result--ok');
    if (state.kind === 'busy') region.classList.add('availability-result--busy');
    if (state.headline) region.appendChild(makeElement('p', 'availability-result__headline', state.headline));
    if (state.conflicts && state.conflicts.length) {
      var list = makeElement('ul', 'problem-list');
      state.conflicts.forEach(function (conflict) {
        list.appendChild(makeElement('li', null, conflictLine(conflict)));
      });
      region.appendChild(list);
    }
    if (state.note) region.appendChild(makeElement('p', 'hint', state.note));
  }

  function readWindow() {
    var offset = tzOffset(form);
    var dateField = one(form, '[name=start_date]') || one(form, '[name=date]');
    var startField = one(form, '[name=start_time]');
    var endField = one(form, '[name=end_time]');
    var start = null;
    var end = null;

    if (dateField && startField && endField) {
      start = wallClockToIso(dateField.value, startField.value, offset);
      end = wallClockToIso(dateField.value, endField.value, offset);
    } else {
      var startAt = one(form, '[name=start_at]');
      var endAt = one(form, '[name=end_at]');
      start = startAt ? localInputToIso(startAt.value, offset) : null;
      end = endAt ? localInputToIso(endAt.value, offset) : null;
    }
    return { start: start, end: end };
  }

  function readSpace() {
    var field = one(form, '[name=space_id]') || one(form, '[name=space]');
    if (field && trim(field.value)) return trim(field.value);
    return trim(form.dataset.space);
  }

  function readDesks() {
    var field = one(form, '[name=unit_count]') || one(form, '[name=desks]');
    var value = field ? parseInt(field.value, 10) : 1;
    if (!Number.isFinite(value) || value < 1) return 1;
    return value;
  }

  function updateDeskHint(payload) {
    if (!deskHint) return;
    var freeUnits = payload && Number.isFinite(payload.freeUnits) ? payload.freeUnits : null;
    var totalUnits = payload && Number.isFinite(payload.totalUnits) ? payload.totalUnits : null;
    if (freeUnits === null) {
      setText(deskHint, '');
      deskHint.classList.remove('desk-hint--busy');
      return;
    }
    var message = totalUnits === null
      ? freeUnits + ' desk' + (freeUnits === 1 ? '' : 's') + ' free for this period.'
      : freeUnits + ' of ' + totalUnits + ' desks free for this period.';
    setText(deskHint, message);
    deskHint.classList.toggle('desk-hint--busy', freeUnits === 0);
  }

  var checking = false;

  function checkAvailability() {
    var space = readSpace();
    var window_ = readWindow();
    var desks = readDesks();

    if (!space || !window_.start || !window_.end) {
      form.dataset.availabilityState = 'unknown';
      clear(region);
      region.classList.remove('availability-result--ok', 'availability-result--busy');
      setSubmitBlocked(false);
      if (deskHint) setText(deskHint, '');
      return;
    }
    if (Date.parse(window_.end) <= Date.parse(window_.start)) {
      form.dataset.availabilityState = 'busy';
      renderRegion({
        kind: 'busy',
        headline: 'The end time must be after the start time.',
        note: 'Correct the times to re-check availability.',
      });
      setSubmitBlocked(true, 'end time before start time');
      announce('Submission blocked: the end time must be after the start time.');
      return;
    }
    if (checking) return;
    checking = true;

    var params = new URLSearchParams();
    params.set('space', space);
    params.set('start', window_.start);
    params.set('end', window_.end);
    params.set('desks', String(desks));

    fetch('/api/admin/availability?' + params.toString(), {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { ok: response.ok, payload: payload };
        }, function () {
          return { ok: false, payload: null };
        });
      })
      .then(function (result) {
        checking = false;
        var payload = result.payload || {};
        var conflicts = collectConflicts(payload);
        var isAvailable = payload.isAvailable === true || payload.canFulfil === true;

        if (result.ok && !payload.error && isAvailable && conflicts.length === 0) {
          form.dataset.availabilityState = 'free';
          setSubmitBlocked(false);
          updateDeskHint(payload);
          renderRegion({
            kind: 'ok',
            headline: 'Free for the selected period. The server revalidation still decides on submit.',
            note: 'Counts are a preview; the booking transaction re-checks the calendar before it commits.',
          });
          announce('Availability check passed: the selected period is free.');
          return;
        }

        var headline = payload.error && typeof payload.error.message === 'string'
          ? payload.error.message
          : 'Not available for the selected period.';
        renderRegion({
          kind: 'busy',
          headline: headline,
          conflicts: conflicts,
          note: 'Submission is blocked until the conflict is resolved. Adjust the space, time or desk count.',
        });
        updateDeskHint(payload);
        setSubmitBlocked(true, 'availability conflict');
        announce('Submission blocked: ' + headline
          + (conflicts.length ? ' Blocking entries: ' + conflicts.map(conflictLine).join('; ') + '.' : ''));
      })
      .catch(function () {
        checking = false;
        /* A failed *courtesy* check must not block the form: the server will
           revalidate anyway, so let the operator submit and let the server
           decide. Blocking here would turn a network blip into a dead end. */
        form.dataset.availabilityState = 'unknown';
        setSubmitBlocked(false);
        renderRegion({
          kind: 'unknown',
          headline: 'Availability could not be re-checked (network problem).',
          note: 'You can still submit — the server re-checks the calendar inside the booking transaction.',
        });
        announce('Availability check failed because of a network problem. You can still submit; the server will re-check.');
      });
  }

  var debouncedCheck = debounce(checkAvailability, DEBOUNCE_MS);

  watched.forEach(function (field) {
    field.addEventListener('change', function () {
      form.dataset.availabilityState = 'unknown';
      debouncedCheck();
    });
    if (field.tagName === 'INPUT' && (field.type === 'text' || field.type === 'number')) {
      field.addEventListener('input', function () {
        debouncedCheck();
      });
    }
  });

  if (!form.dataset.availabilityState) form.dataset.availabilityState = 'unknown';

  /* Double-submit guard. Registered after the confirm guards so a cancelled
     confirmation has already set defaultPrevented and never disables anything. */
  form.addEventListener('submit', function (event) {
    if (event.defaultPrevented) return;

    if (form.dataset.availabilityState === 'busy') {
      event.preventDefault();
      announce('Submission blocked: the selected period conflicts with an existing entry. Resolve the conflict first.');
      if (typeof region.scrollIntoView === 'function') region.scrollIntoView({ block: 'nearest' });
      if (typeof region.focus === 'function') region.focus();
      return;
    }
    if (form.dataset.submitting === 'true') {
      event.preventDefault();
      return;
    }
    form.dataset.submitting = 'true';
    form.setAttribute('aria-busy', 'true');

    /* A disabled submit button is not submitted, so preserve its name/value
       (used by multi-action forms) in a hidden field first. */
    var submitter = event.submitter || document.activeElement;
    if (submitter && submitter.getAttribute && submitter.getAttribute('name') && form.contains(submitter)) {
      var shadow = document.createElement('input');
      shadow.type = 'hidden';
      shadow.name = submitter.getAttribute('name');
      shadow.value = submitter.value != null ? submitter.value : '1';
      shadow.setAttribute('data-submit-shadow', 'true');
      form.appendChild(shadow);
    }
    submitButtons.forEach(function (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    });
    announce('Submitting…');
  });
}

function findBookingForm() {
  var forms = all(document, 'form');
  for (var i = 0; i < forms.length; i += 1) {
    var hasSpace = one(forms[i], '[name=space_id]');
    var hasTime = one(forms[i], '[name=start_time]') || one(forms[i], '[name=start_at]');
    if (hasSpace && hasTime) return forms[i];
  }
  return null;
}

/* ------------------------------------------------------- filter auto-submit */

function initFilterAutoSubmit() {
  var selects = all(document, '.filter-bar__field select')
    .concat(all(document, '[data-auto-submit] select'));

  selects.forEach(function (select) {
    select.addEventListener('change', function () {
      var form = select.form;
      if (!form) return;
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    });
  });
}

/* -------------------------------------------- keyboard-scrollable tables */

function initScrollableTables() {
  function refresh() {
    all(document, '.table-wrap').forEach(function (wrap) {
      var scrolls = wrap.scrollWidth > wrap.clientWidth + 4;
      if (scrolls) {
        if (!wrap.hasAttribute('tabindex')) wrap.setAttribute('tabindex', '0');
        if (!wrap.hasAttribute('role')) wrap.setAttribute('role', 'region');
        if (!wrap.getAttribute('aria-label')) wrap.setAttribute('aria-label', 'Scrollable table');
      } else {
        wrap.removeAttribute('tabindex');
        if (wrap.getAttribute('role') === 'region') wrap.removeAttribute('role');
      }
    });
  }
  refresh();
  window.addEventListener('resize', debounce(refresh, 200));
}

/* ------------------------------------------------- scroll reveal + submit */

function initReveal() {
  var nodes = all(document, '[data-reveal]');
  if (!nodes.length) return;
  document.documentElement.classList.add('js-reveal');
  if (!('IntersectionObserver' in window)) {
    nodes.forEach(function (node) { node.classList.add('is-visible'); });
    return;
  }
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    nodes.forEach(function (node) { node.classList.add('is-visible'); });
    return;
  }
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
  nodes.forEach(function (node) { observer.observe(node); });
}

function initSubmitOnce() {
  all(document, 'form[data-submit-once]').forEach(function (form) {
    /* data-confirm forms ask first; disabling there would freeze the form
       when the operator answers "cancel", so the confirm guard owns them. */
    if (form.hasAttribute('data-confirm')) return;
    form.addEventListener('submit', function () {
      window.setTimeout(function () {
        if (form.dataset.submitted === 'true') return;
        form.dataset.submitted = 'true';
        all(form, 'button[type="submit"]').forEach(function (button) {
          button.setAttribute('aria-busy', 'true');
          button.disabled = true;
          if (!button.dataset.label) button.dataset.label = button.textContent;
          setText(button, 'Saving…');
        });
      }, 0);
    });
  });
}

/* -------------------------------------------------------------------- boot */

function boot() {
  announcer();
  initSidebar();
  initFlashDismiss();
  initConfirmGuards();     /* runs before the submit guards by design */
  initCustomerPicker();
  initLiveAvailability();
  initFilterAutoSubmit();
  initScrollableTables();
  initReveal();
  initSubmitOnce();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
