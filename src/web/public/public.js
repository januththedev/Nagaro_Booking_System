/**
 * Nagaro Space Booking — public site progressive enhancement.
 * src/web/public/public.js  (ES module, no dependencies, no build step)
 *
 * Contract: EVERY feature here is an enhancement. With JavaScript disabled the
 * public site is fully usable — the availability checker is a normal form, the
 * gallery degrades to a static list of photographs, flashes stay visible and
 * confirmation happens again on the server. Nothing here is a security
 * control: availability answers are provisional previews and the server
 * revalidates every booking request inside its write transaction.
 *
 * Data-attribute contracts (see docs/UX_GUIDE.md):
 *   [data-nav-toggle]                                  mobile menu button
 *   .site-nav                                          the navigation it toggles
 *   [data-availability-form]                           availability form
 *       [name=date] [name=start_time] [name=end_time] [name=desks]
 *       [data-space] (optional; space code, else field/URL supplied)
 *   [data-availability-result]                         output region
 *   [data-gallery-main] img                            the large image
 *   [data-gallery-thumb]                               a button per thumbnail
 *   [data-flash] with [data-dismiss]                   dismissible alert
 *   [data-confirm] on a <form>                         confirm() before submit
 *
 * House rules: no innerHTML anywhere, no server string ever becomes markup;
 * every response field is written with textContent. All DOM lookups are
 * null-safe so one page missing one widget cannot break the rest.
 */

'use strict';

/* Sri Lanka has observed UTC+05:30 with no DST since 2006; the server resolves
   the business zone through Intl and we mirror it here so wall-clock form
   values can be turned into unambiguous instants. Overridable per form or on
   <body data-tz-offset="+05:30"> should the deployment ever move. */
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

function tzOffset(form) {
  var fromForm = form && form.dataset ? trim(form.dataset.tzOffset) : '';
  var fromBody = document.body && document.body.dataset ? trim(document.body.dataset.tzOffset) : '';
  var candidate = fromForm || fromBody;
  return /^[+-]\d{2}:\d{2}$/.test(candidate) ? candidate : DEFAULT_TZ_OFFSET;
}

/** `2026-11-10` + `09:00` -> `2026-11-10T09:00:00+03:00`, else null. */
function wallClockToIso(dateValue, timeValue, offset) {
  var date = trim(dateValue);
  var time = trim(timeValue);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  var match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!match) return null;
  var hh = Number(match[1]);
  var mm = Number(match[2]);
  if (hh > 23 || mm > 59) return null;
  var seconds = match[3] ? match[3] : '00';
  return date + 'T' + match[1] + ':' + match[2] + ':' + seconds + offset;
}

/** `2026-11-10T09:00` (datetime-local) -> ISO with offset, else null. */
function localInputToIso(value, offset) {
  var match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trim(value));
  if (!match) return null;
  return wallClockToIso(match[1], match[2] + ':' + match[3] + ':' + (match[4] || '00'), offset);
}

function formatInstant(epochMs) {
  if (!Number.isFinite(epochMs)) return '';
  var date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return '';
  var formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: BUSINESS_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formatter.format(date);
}

function makeElement(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

/* ------------------------------------------------------- mobile navigation */

function initNavToggle() {
  var toggle = one(document, '[data-nav-toggle]');
  var nav = one(document, '.site-nav');
  if (!toggle || !nav) return;

  /* layout.js writes aria-controls="public-nav" but the <nav> carries no id.
     Give it one so the relationship is real for assistive technology. */
  var controls = toggle.getAttribute('aria-controls');
  if (controls && !document.getElementById(controls)) nav.id = controls;

  function setOpen(open) {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('nav-open', open);
  }

  setOpen(toggle.getAttribute('aria-expanded') === 'true');

  toggle.addEventListener('click', function () {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });
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

/* -------------------------------------------------------- confirm() guard */

function initConfirmGuards() {
  all(document, 'form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      var message = trim(form.dataset.confirm) || 'Are you sure?';
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
  });
}

/* ------------------------------------------------------ availability checker */

function availabilityForm() {
  return one(document, '[data-availability-form]');
}

function resultRegion(form) {
  return one(form, '[data-availability-result]') || one(document, '[data-availability-result]');
}

function readDeskCount(form) {
  var field = one(form, '[name=desks]') || one(form, '[name=desk_count]');
  var value = field ? parseInt(field.value, 10) : NaN;
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(value, 500);
}

function readAvailabilityQuery(form) {
  var offset = tzOffset(form);
  var dateField = one(form, '[name=date]');
  var startField = one(form, '[name=start_time]');
  var endField = one(form, '[name=end_time]');

  var start = null;
  var end = null;

  if (dateField && startField && endField) {
    start = wallClockToIso(dateField.value, startField.value, offset);
    end = wallClockToIso(dateField.value, endField.value, offset);
  } else {
    var startAt = one(form, '[name=start_at]') || one(form, '[name=start]');
    var endAt = one(form, '[name=end_at]') || one(form, '[name=end]');
    start = startAt ? localInputToIso(startAt.value, offset) : null;
    end = endAt ? localInputToIso(endAt.value, offset) : null;
  }

  if (!start || !end) return null;
  if (new Date(end).getTime() <= new Date(start).getTime()) {
    return { invalidRange: true, start: start, end: end };
  }
  return { start: start, end: end, desks: readDeskCount(form) };
}

function spaceCodeFor(form) {
  var explicit = trim(form.dataset.space);
  if (explicit) return explicit;
  var field = one(form, '[name=space]') || one(form, '[name=space_code]') || one(form, '[name=code]');
  if (field && trim(field.value)) return trim(field.value);
  var onPage = one(document, '[data-space-code]');
  if (onPage) {
    var fromAttr = trim(onPage.getAttribute('data-space-code'));
    if (fromAttr) return fromAttr;
  }
  var match = /\/spaces\/([^/?#]+)/.exec(window.location.pathname || '');
  return match ? decodeURIComponent(match[1]) : '';
}

function renderAvailability(region, state) {
  if (!region) return;
  region.classList.remove('availability-result--ok', 'availability-result--busy');
  if (state.kind === 'ok') region.classList.add('availability-result--ok');
  if (state.kind === 'busy') region.classList.add('availability-result--busy');

  while (region.firstChild) region.removeChild(region.firstChild);

  if (state.headline) region.appendChild(makeElement('p', 'availability-result__headline', state.headline));
  (state.details || []).forEach(function (line) {
    region.appendChild(makeElement('p', 'availability-result__detail', line));
  });
  if (state.caveat) region.appendChild(makeElement('p', 'hint availability-result__caveat', state.caveat));
}

function describeBlockedPeriods(blocked) {
  if (!Array.isArray(blocked) || blocked.length === 0) return '';
  var booked = blocked.filter(function (period) {
    return trim(period && period.kind) !== 'MAINTENANCE';
  }).length;
  var maintenance = blocked.length - booked;
  var parts = [];
  if (booked > 0) parts.push(booked === 1 ? '1 reservation' : booked + ' reservations');
  if (maintenance > 0) parts.push(maintenance === 1 ? '1 maintenance block' : maintenance + ' maintenance blocks');
  if (parts.length === 0) return '';
  return 'Already in the calendar for this period: ' + parts.join(' and ') + '.';
}

function availabilityCaveat() {
  return 'Provisional only — this check does not hold the space. A booking is confirmed only once Nagaro staff confirm it.';
}

function renderAvailabilityFromPayload(region, payload) {
  var isAvailable = payload && (payload.isAvailable === true || payload.canFulfil === true);
  var freeUnits = payload && Number.isFinite(payload.freeUnits) ? payload.freeUnits : null;
  var totalUnits = payload && Number.isFinite(payload.totalUnits) ? payload.totalUnits : null;
  var requested = payload && Number.isFinite(payload.requestedUnits) ? payload.requestedUnits : null;

  var headline;
  if (isAvailable) {
    headline = 'Available for the selected period.';
    if (freeUnits !== null && totalUnits !== null) {
      headline = 'Available — ' + freeUnits + ' of ' + totalUnits + ' desks free for the selected period.';
    }
  } else {
    headline = 'Not available for the selected period.';
    if (freeUnits !== null && requested !== null && requested > 1) {
      headline = 'Not available — only ' + freeUnits + ' of ' + requested + ' requested desks are free.';
    } else if (freeUnits !== null && freeUnits > 0) {
      headline = 'Not available — ' + freeUnits + ' desk' + (freeUnits === 1 ? '' : 's') + ' still free, but not enough for this request.';
    } else if (freeUnits === 0) {
      headline = 'Not available — the space is fully booked for the selected period.';
    }
  }

  var details = [];
  var label = payload && trim(payload.label);
  if (label && label !== headline) details.push(label);
  var blockedLine = describeBlockedPeriods(payload && payload.blockedPeriods);
  if (blockedLine) details.push(blockedLine);

  renderAvailability(region, {
    kind: isAvailable ? 'ok' : 'busy',
    headline: headline,
    details: details,
    caveat: availabilityCaveat(),
  });
}

function renderAvailabilityError(region, message) {
  renderAvailability(region, {
    kind: 'error',
    headline: 'Availability could not be checked.',
    details: [message],
    caveat: 'You can still send a booking request — Nagaro staff will check the calendar by hand before confirming.',
  });
}

function requestAvailability(form, region, options) {
  var query = readAvailabilityQuery(form);
  var code = spaceCodeFor(form);
  var loadingState = options && options.silent ? null : { kind: 'loading' };

  if (!code) {
    renderAvailabilityError(region, 'This page does not identify a space to check.');
    return null;
  }
  if (!query) {
    if (!(options && options.silent)) {
      renderAvailabilityError(region, 'Choose a date with a start and end time (for example 09:00 to 11:00).');
    }
    return null;
  }
  if (query.invalidRange) {
    renderAvailabilityError(region, 'The end time must be after the start time.');
    return null;
  }

  if (loadingState) {
    renderAvailability(region, { kind: 'loading', headline: 'Checking availability…', details: [], caveat: '' });
  }

  var params = new URLSearchParams();
  params.set('space', code);
  params.set('start', query.start);
  params.set('end', query.end);
  params.set('desks', String(query.desks));

  return fetch('/api/public/availability?' + params.toString(), {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  })
    .then(function (response) {
      return response.json().then(function (payload) {
        return { status: response.status, payload: payload };
      }, function () {
        return { status: response.status, payload: null };
      });
    })
    .then(function (result) {
      var payload = result.payload || {};
      if (result.status >= 200 && result.status < 300 && payload && payload.error == null) {
        renderAvailabilityFromPayload(region, payload);
        return payload;
      }
      var serverMessage = payload && payload.error && typeof payload.error.message === 'string'
        ? payload.error.message
        : 'The availability service replied with an unexpected response.';
      renderAvailabilityError(region, serverMessage);
      return null;
    })
    .catch(function () {
      renderAvailabilityError(
        region,
        'This browser could not reach the server. Check your connection and try again, or call Nagaro reception.',
      );
      return null;
    });
}

function initAvailabilityChecker() {
  var form = availabilityForm();
  if (!form) return;
  var region = resultRegion(form);
  if (!region) return;

  form.addEventListener('submit', function (event) {
    if (!form.dataset || form.dataset.enhanced !== 'true') return;
    event.preventDefault();
    requestAvailability(form, region, {});
  });

  form.dataset.enhanced = 'true';
  if (!region.getAttribute('aria-live')) region.setAttribute('aria-live', 'polite');

  /* Prefill from ?date=&start=&end=&desks= supplied by the space detail page. */
  var params = new URLSearchParams(window.location.search || '');
  var prefill = {
    date: params.get('date'),
    start: params.get('start') || params.get('start_time'),
    end: params.get('end') || params.get('end_time'),
    desks: params.get('desks'),
  };
  var prefilled = 0;
  [
    ['[name=date]', prefill.date, /^\d{4}-\d{2}-\d{2}$/],
    ['[name=start_time]', prefill.start, /^\d{1,2}:\d{2}$/],
    ['[name=end_time]', prefill.end, /^\d{1,2}:\d{2}$/],
    ['[name=desks]', prefill.desks, /^\d{1,4}$/],
  ].forEach(function (pair) {
    var field = one(form, pair[0]);
    var incoming = trim(pair[1]);
    if (!field || !incoming || !pair[2].test(incoming)) return;
    if (trim(field.value)) return;
    field.value = incoming;
    prefilled += 1;
  });

  /* If the whole window arrived in the URL, answer immediately — the visitor
     asked a question by clicking a link, and the answer is already known. */
  if (prefilled >= 3 && readAvailabilityQuery(form)) {
    requestAvailability(form, region, { silent: true });
  }
}

/* ----------------------------------------------------------------- gallery */

function thumbnailImage(thumb) {
  if (!thumb) return null;
  return thumb.querySelector('img');
}

function initGallery() {
  var main = one(document, '[data-gallery-main]');
  var thumbs = all(document, '[data-gallery-thumb]');
  if (!main || thumbs.length === 0) return;

  function activate(thumb, moveFocus) {
    var image = thumbnailImage(thumb);
    var src = trim(thumb.dataset.src) || (image ? image.getAttribute('src') : '');
    var alt = trim(thumb.dataset.alt);
    if (!alt && image) alt = image.getAttribute('alt') || '';
    if (!src) return;

    main.setAttribute('src', src);
    if (alt) main.setAttribute('alt', alt);
    main.dataset.galleryActive = 'true';

    thumbs.forEach(function (other) {
      var selected = other === thumb;
      other.setAttribute('aria-current', selected ? 'true' : 'false');
      other.classList.toggle('is-active', selected);
    });
    if (moveFocus) thumb.focus();
  }

  function select(thumb) {
    activate(thumb, false);
  }

  thumbs.forEach(function (thumb) {
    /* The view should render real <button>s. If a non-interactive container
       slipped through, make it operable rather than leaving a dead image. */
    var tag = thumb.tagName ? thumb.tagName.toLowerCase() : '';
    if (tag !== 'button' && tag !== 'a') {
      thumb.setAttribute('role', 'button');
      if (!thumb.hasAttribute('tabindex')) thumb.setAttribute('tabindex', '0');
    }

    thumb.addEventListener('click', function () {
      select(thumb);
    });
    thumb.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      if (tag === 'button' || tag === 'a') return;
      event.preventDefault();
      select(thumb);
    });
  });

  var current = thumbs.filter(function (thumb) {
    return thumb.getAttribute('aria-current') === 'true';
  })[0];
  if (current) select(current);
}

/* -------------------------------------------------------------------- boot */

function boot() {
  /* Each feature is initialised independently and bails out when its markup
     is absent, so a page missing a widget cannot break its neighbours. */
  initNavToggle();
  initFlashDismiss();
  initConfirmGuards();
  initAvailabilityChecker();
  initGallery();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
