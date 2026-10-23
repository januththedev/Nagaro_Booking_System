/**
 * Team & access — progressive enhancement for the one-time credential panel.
 *
 * The screen works without JavaScript: the temporary password is already on
 * the page and can be selected by hand. This module only adds a copy button
 * and a short-lived confirmation on the button itself. No innerHTML is used.
 */
'use strict';

(function () {
  function copyTarget(button) {
    var selector = button.getAttribute('data-copy-target');
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function fallbackCopy(node) {
    var selection = window.getSelection ? window.getSelection() : null;
    var range = document.createRange();
    range.selectNodeContents(node);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      if (selection) selection.removeAllRanges();
    }
  }

  function announce(button, message) {
    var original = button.getAttribute('data-original-label');
    if (original === null) {
      original = button.textContent;
      button.setAttribute('data-original-label', original);
    }
    button.textContent = message;
    window.setTimeout(function () {
      button.textContent = original;
    }, 2400);
  }

  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest
      ? event.target.closest('[data-copy-target]')
      : null;
    if (!button) return;
    var node = copyTarget(button);
    if (!node) return;
    var text = node.textContent == null ? '' : String(node.textContent).trim();
    if (!text) return;

    event.preventDefault();

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () {
        announce(button, 'Copied');
      }).catch(function () {
        announce(button, fallbackCopy(node) ? 'Copied' : 'Select and copy');
      });
      return;
    }
    announce(button, fallbackCopy(node) ? 'Copied' : 'Select and copy');
  });
}());
