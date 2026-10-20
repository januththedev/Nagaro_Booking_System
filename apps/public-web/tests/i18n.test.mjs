/**
 * Dictionary integrity: the three public languages must stay in lock-step.
 *
 * - identical key trees (en is the source of truth);
 * - no empty or placeholder-only strings;
 * - the same {interpolation} variables per key, so a Sinhala or Tamil string
 *   can never lose a value the component passes in;
 * - locale resolution: explicit choice wins, then Accept-Language, then en.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BCP47,
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_LABELS,
  dictionaries,
  format,
  getDictionary,
  isLocale,
  localeFromAcceptLanguage,
  resolveLocale,
} from "../lib/i18n.ts";

function walk(node, path, visit) {
  if (typeof node === "string") {
    visit(node, path);
    return;
  }
  for (const [key, child] of Object.entries(node)) walk(child, [...path, key], visit);
}

function keyPaths(node, prefix = []) {
  const paths = [];
  walk(node, prefix, (_value, path) => paths.push(path.join(".")));
  return paths.sort();
}

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const en = dictionaries.en;

test("every locale defines exactly the same keys as English", () => {
  const expected = keyPaths(en);
  for (const locale of LOCALES) {
    assert.deepEqual(keyPaths(dictionaries[locale]), expected, `${locale} dictionary diverges from the English key set`);
  }
});

test("every translation is non-empty and carries the same placeholders as English", () => {
  const english = new Map();
  walk(en, [], (value, path) => english.set(path.join("."), value));

  for (const locale of LOCALES) {
    walk(dictionaries[locale], [], (value, path) => {
      const key = path.join(".");
      assert.ok(value.trim().length > 0, `${locale}.${key} is empty`);
      assert.equal(value.includes("TODO") || value.includes("PLACEHOLDER"), false, `${locale}.${key} still contains a placeholder marker`);
      if (locale === DEFAULT_LOCALE) return;
      assert.deepEqual(placeholders(value), placeholders(english.get(key) ?? ""), `${locale}.${key} must interpolate the same variables as English`);
    });
  }
});

test("locale metadata covers every locale", () => {
  for (const locale of LOCALES) {
    assert.ok(LOCALE_LABELS[locale], `${locale} needs a language label`);
    assert.match(BCP47[locale], /^[a-z]{2}-LK$/, `${locale} needs a Sri Lankan BCP-47 tag`);
    assert.equal(getDictionary(locale).meta.title.length > 0, true);
  }
  assert.equal(getDictionary("xx"), getDictionary(DEFAULT_LOCALE), "unknown locales fall back to English");
});

test("locale resolution prefers the explicit choice, then the browser, then English", () => {
  assert.equal(resolveLocale("si", "en-GB,en;q=0.9"), "si", "a saved choice wins");
  assert.equal(resolveLocale(null, "si-LK,si;q=0.9,en;q=0.8"), "si");
  assert.equal(resolveLocale(null, "ta-IN,ta;q=0.9"), "ta");
  assert.equal(resolveLocale(undefined, "fr-FR,fr;q=0.9"), DEFAULT_LOCALE);
  assert.equal(resolveLocale(undefined, null), DEFAULT_LOCALE);
  assert.equal(resolveLocale("klingon", "ta"), "ta", "an invalid cookie never blocks detection");
  assert.equal(localeFromAcceptLanguage("en-US,en;q=0.9"), "en");
  assert.equal(isLocale("en"), true);
  assert.equal(isLocale("EN"), false);
  assert.equal(isLocale(42), false);
});

test("format interpolates known variables and leaves unknown ones intact", () => {
  assert.equal(format("Showing {shown} of {total}", { shown: 1, total: 5 }), "Showing 1 of 5");
  assert.equal(format("Hello {name}", {}), "Hello {name}");
  assert.equal(format("no variables", { a: 1 }), "no variables");
});
