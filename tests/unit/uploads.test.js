/**
 * Unit tests for the upload security module (`src/server/security/uploads.js`)
 * and the image-sniffing helpers it relies on.
 *
 * These tests deliberately attack the module: traversal names, wrong magic
 * bytes, declared-vs-actual type mismatches, oversized and empty files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import {
  ensureUploadDir,
  extensionForMime,
  ingestUploadFiles,
  isSafeStoredName,
  mimeForStoredName,
  removeStoredImage,
  storeImage,
  storedPathFor,
  uploadDir,
} from '../../src/server/security/uploads.js';
import { LIMITS, assertUploadableImage, sniffImageType } from '../../src/server/domain/validation.js';

/* --------------------------------------------------------------- fixtures */

// A genuine 1x1 transparent PNG (70 bytes, correct PNG magic bytes).
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG_MAGIC = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(8)]);
const WEBP_MAGIC = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4),
]);
// A PHP interpreter tag plus a system() call, assembled from hex so this file
// never contains executable-looking server-side markup itself.
const PHP_PAYLOAD = Buffer.from(
  '3c3f7068702073797374656d28245f4745545b22636d64225d293b203f3e',
  'hex',
);
const HTML_PAYLOAD = Buffer.from('<!doctype html><html><body>hi</body></html>');
const SVG_PAYLOAD = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const HEX32 = '0123456789abcdef0123456789abcdef';
const VALID_NAME = `${HEX32}.jpg`;
const MISSING_NAME = `${'f'.repeat(32)}.png`;
const VALID_UPPERCASE = `${HEX32.toUpperCase()}.jpg`;
const NUL = String.fromCharCode(0);

/** Point NAGARO_UPLOAD_DIR at a fresh temp directory for one test. */
function useTempUploadDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nagaro-upload-unit-'));
  process.env.NAGARO_UPLOAD_DIR = dir;
  t.after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return dir;
}

function entry(overrides = {}) {
  return {
    field: 'images',
    originalName: 'photo.png',
    declaredType: 'image/png',
    buffer: ONE_PIXEL_PNG,
    ...overrides,
  };
}

/* ------------------------------------------------------------- extensionForMime */

test('extensionForMime maps the three supported types', () => {
  assert.equal(extensionForMime('image/jpeg'), 'jpg');
  assert.equal(extensionForMime('image/png'), 'png');
  assert.equal(extensionForMime('image/webp'), 'webp');
  // Case/whitespace tolerance on the input does not weaken the allow-list.
  assert.equal(extensionForMime(' IMAGE/PNG '), 'png');
});

test('extensionForMime rejects unknown types', () => {
  for (const mime of ['image/svg+xml', 'image/gif', 'image/bmp', 'text/html', 'application/octet-stream', '', null, undefined]) {
    assert.throws(() => extensionForMime(mime), (error) => error.code === 'VALIDATION_ERROR', `expected ${mime} to be rejected`);
  }
});

test('mimeForStoredName derives the content type from the stored extension only', () => {
  assert.equal(mimeForStoredName(`${HEX32}.jpg`), 'image/jpeg');
  assert.equal(mimeForStoredName(`${HEX32}.png`), 'image/png');
  assert.equal(mimeForStoredName(`${HEX32}.webp`), 'image/webp');
  assert.equal(mimeForStoredName('photo.svg'), 'application/octet-stream');
});

/* ------------------------------------------------------------------- names */

test('isSafeStoredName accepts a valid 32-hex stored name', () => {
  assert.equal(isSafeStoredName(VALID_NAME), true);
  assert.equal(isSafeStoredName(`${'a'.repeat(32)}.png`), true);
  assert.equal(isSafeStoredName(`${'0'.repeat(32)}.webp`), true);
});

test('isSafeStoredName rejects malformed and hostile names', () => {
  const cases = [
    ['uppercase hex', VALID_UPPERCASE],
    ['31 characters', `${'a'.repeat(31)}.jpg`],
    ['33 characters', `${'a'.repeat(33)}.jpg`],
    ['traversal', `../${VALID_NAME}`],
    ['nested traversal', `../../${VALID_NAME}`],
    ['URL-encoded traversal', '%2e%2e%2f%2e%2e%2fetc%2fpasswd'],
    ['nested path', `sub/${VALID_NAME}`],
    ['backslash path', `..\\..\\${VALID_NAME}`],
    ['SVG extension', `${'a'.repeat(32)}.svg`],
    ['uppercase extension', `${'a'.repeat(32)}.JPG`],
    ['no extension', 'a'.repeat(32)],
    ['double extension', `${'a'.repeat(32)}.png.php`],
    ['NUL byte', `${'a'.repeat(32)}${NUL}.jpg`],
    ['absolute path', '/etc/passwd'],
    ['windows absolute path', 'C:\\Windows\\win.ini'],
    ['empty string', ''],
    ['non-hex letters', `${'z'.repeat(32)}.png`],
  ];
  for (const [label, value] of cases) {
    assert.equal(isSafeStoredName(value), false, `expected rejection: ${label}`);
  }
  assert.equal(isSafeStoredName(undefined), false);
  assert.equal(isSafeStoredName(null), false);
  assert.equal(isSafeStoredName(42), false);
});

test('storedPathFor returns an absolute path inside the upload directory', (t) => {
  const dir = useTempUploadDir(t);
  const path = storedPathFor(VALID_NAME);
  assert.equal(isAbsolute(path), true);
  assert.equal(dirname(path), resolve(dir));
  assert.ok(resolve(path).startsWith(`${resolve(uploadDir())}${sep}`), 'path must stay inside the upload directory');
  assert.equal(path, join(resolve(dir), VALID_NAME));
});

test('storedPathFor rejects traversal and malformed names', (t) => {
  useTempUploadDir(t);
  const hostile = [
    '../secret.png',
    `..\\${VALID_NAME}`,
    `../../${VALID_NAME}`,
    '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    `%2e%2e/${VALID_NAME}`,
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    `sub/${VALID_NAME}`,
    `${'a'.repeat(32)}${NUL}.jpg`,
    `${'a'.repeat(32)}.svg`,
    `${VALID_UPPERCASE}`,
    `${VALID_NAME}/../${VALID_NAME}`,
    '..',
    '',
  ];
  for (const name of hostile) {
    assert.throws(() => storedPathFor(name), (error) => error.code === 'VALIDATION_ERROR', `expected storedPathFor(${JSON.stringify(name)}) to throw`);
  }
  assert.throws(() => storedPathFor(undefined), (error) => error.code === 'VALIDATION_ERROR');
  assert.throws(() => storedPathFor(null), (error) => error.code === 'VALIDATION_ERROR');
  assert.throws(() => storedPathFor({ toString: () => VALID_NAME }), (error) => error.code === 'VALIDATION_ERROR');
});

/* --------------------------------------------------------------- sniffing */

test('sniffImageType recognises real JPEG, PNG and WebP magic bytes', () => {
  assert.equal(sniffImageType(ONE_PIXEL_PNG), 'image/png');
  assert.equal(sniffImageType(JPEG_MAGIC), 'image/jpeg');
  assert.equal(sniffImageType(WEBP_MAGIC), 'image/webp');
});

test('sniffImageType rejects SVG, PHP, HTML, empty and truncated buffers', () => {
  assert.equal(sniffImageType(SVG_PAYLOAD), null);
  assert.equal(sniffImageType(PHP_PAYLOAD), null);
  assert.equal(sniffImageType(HTML_PAYLOAD), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
  assert.equal(sniffImageType(null), null);
  assert.equal(sniffImageType(undefined), null);
  // A correct prefix is not enough: at least 12 bytes are required.
  assert.equal(sniffImageType(Buffer.from([0xFF, 0xD8, 0xFF])), null);
  assert.equal(sniffImageType(Buffer.from([0x89, 0x50, 0x4E, 0x47])), null);
});

test('assertUploadableImage rejects oversized files, SVG declarations and empty buffers, and accepts a real PNG', () => {
  const tooBig = Buffer.alloc(LIMITS.maxImageBytes + 1, 0x41);
  assert.throws(
    () => assertUploadableImage(tooBig, 'image/png'),
    (error) => error.code === 'VALIDATION_ERROR' && /5 MB or smaller/.test(error.message),
  );
  assert.throws(
    () => assertUploadableImage(Buffer.alloc(0), 'image/png'),
    (error) => error.code === 'VALIDATION_ERROR' && /empty/.test(error.message),
  );
  assert.throws(
    () => assertUploadableImage(ONE_PIXEL_PNG, 'image/svg+xml'),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  assert.throws(() => assertUploadableImage(SVG_PAYLOAD, 'image/svg+xml'));
  assert.throws(() => assertUploadableImage(PHP_PAYLOAD, 'image/png'));

  assert.equal(assertUploadableImage(ONE_PIXEL_PNG, 'image/png'), 'image/png');
  // The declared type is optional; the bytes are authoritative.
  assert.equal(assertUploadableImage(ONE_PIXEL_PNG, ''), 'image/png');
});

/* ------------------------------------------------------------------ storing */

test('ensureUploadDir creates the directory recursively', (t) => {
  const dir = useTempUploadDir(t);
  const nested = join(dir, 'deep', 'uploads');
  process.env.NAGARO_UPLOAD_DIR = nested;
  ensureUploadDir();
  assert.equal(statSync(uploadDir()).isDirectory(), true);
  assert.equal(uploadDir(), resolve(nested));
});

test('uploadDir is absolute and honours NAGARO_UPLOAD_DIR', (t) => {
  const dir = useTempUploadDir(t);
  assert.equal(isAbsolute(uploadDir()), true);
  assert.equal(uploadDir(), resolve(dir));
});

test('storeImage writes the bytes under a random 32-hex stored name', (t) => {
  const dir = useTempUploadDir(t);
  const result = storeImage(ONE_PIXEL_PNG, 'image/png', { originalName: 'holiday.png' });
  assert.match(result.storedName, /^[a-f0-9]{32}\.png$/);
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.byteSize, ONE_PIXEL_PNG.length);
  assert.equal(result.storedName === 'holiday.png', false);

  const onDisk = readFileSync(storedPathFor(result.storedName));
  assert.ok(onDisk.equals(ONE_PIXEL_PNG), 'stored bytes must match the uploaded bytes exactly');
  assert.deepEqual(readdirSync(dir), [result.storedName]);
});

test('storeImage refuses bytes that do not match the requested type', (t) => {
  useTempUploadDir(t);
  assert.throws(
    () => storeImage(ONE_PIXEL_PNG, 'image/jpeg'),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  assert.throws(() => storeImage(PHP_PAYLOAD, 'image/png'), (error) => error.code === 'VALIDATION_ERROR');
  assert.throws(() => storeImage(Buffer.alloc(0), 'image/png'), (error) => error.code === 'VALIDATION_ERROR');
  assert.throws(() => storeImage(ONE_PIXEL_PNG, 'image/svg+xml'), (error) => error.code === 'VALIDATION_ERROR');
});

test('removeStoredImage deletes the file and reports a second removal honestly', (t) => {
  useTempUploadDir(t);
  const { storedName } = storeImage(ONE_PIXEL_PNG, 'image/png');
  assert.equal(existsSync(storedPathFor(storedName)), true);
  assert.equal(removeStoredImage(storedName), true);
  assert.equal(existsSync(storedPathFor(storedName)), false);
  assert.equal(removeStoredImage(storedName), false);
});

test('removeStoredImage never throws and refuses unsafe names', (t) => {
  useTempUploadDir(t);
  for (const name of ['../../etc/passwd', VALID_UPPERCASE, `${'a'.repeat(32)}.svg`, '', null, undefined, 42, `../${VALID_NAME}`]) {
    assert.equal(removeStoredImage(name), false, `expected false for ${JSON.stringify(name)}`);
  }
  // A valid-looking name that simply does not exist is also just `false`.
  assert.equal(removeStoredImage(MISSING_NAME), false);
});

/* --------------------------------------------------------------- ingestion */

test('ingestUploadFiles accepts real JPEG, PNG and WebP uploads', async (t) => {
  const dir = useTempUploadDir(t);
  const { accepted, rejected } = await ingestUploadFiles([
    entry({ originalName: 'one.png', declaredType: 'image/png', buffer: ONE_PIXEL_PNG }),
    entry({ originalName: 'two.jpg', declaredType: 'image/jpeg', buffer: JPEG_MAGIC }),
    entry({ originalName: 'three.webp', declaredType: 'image/webp', buffer: WEBP_MAGIC }),
  ]);

  assert.equal(rejected.length, 0);
  assert.equal(accepted.length, 3);
  assert.match(accepted[0].storedName, /^[a-f0-9]{32}\.png$/);
  assert.match(accepted[1].storedName, /^[a-f0-9]{32}\.jpg$/);
  assert.match(accepted[2].storedName, /^[a-f0-9]{32}\.webp$/);
  assert.equal(accepted[0].originalName, 'one.png');
  assert.equal(accepted[1].byteSize, JPEG_MAGIC.length);

  for (const file of accepted) {
    assert.equal(existsSync(storedPathFor(file.storedName)), true);
  }
  assert.equal(accepted.length, readdirSync(dir).length);
});

test('ingestUploadFiles rejects a fake .png containing a PHP payload', async (t) => {
  useTempUploadDir(t);
  const { accepted, rejected } = await ingestUploadFiles([
    entry({ originalName: 'shell.png', declaredType: 'image/png', buffer: PHP_PAYLOAD }),
  ]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].originalName, 'shell.png');
  assert.match(rejected[0].reason, /JPEG, PNG or WebP/);
});

test('ingestUploadFiles rejects mismatched declared types, empty and oversized files', async (t) => {
  useTempUploadDir(t);
  const { accepted, rejected } = await ingestUploadFiles([
    entry({ originalName: 'mismatch.png', declaredType: 'text/plain', buffer: ONE_PIXEL_PNG }),
    entry({ originalName: 'declared-svg.png', declaredType: 'image/svg+xml', buffer: SVG_PAYLOAD }),
    entry({ originalName: 'empty.png', declaredType: 'image/png', buffer: Buffer.alloc(0) }),
    entry({ originalName: 'huge.png', declaredType: 'image/png', buffer: Buffer.alloc(LIMITS.maxImageBytes + 1, 0x41) }),
    entry({ originalName: 'vector.svg', declaredType: 'image/svg+xml', buffer: SVG_PAYLOAD }),
  ]);

  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 5);
  assert.match(rejected[0].reason, /does not match a supported image type/);
  assert.match(rejected[1].reason, /JPEG, PNG or WebP|does not match/);
  assert.match(rejected[2].reason, /empty/);
  assert.match(rejected[3].reason, /5 MB or smaller/);
  assert.match(rejected[4].reason, /JPEG, PNG or WebP/);
});

test('ingestUploadFiles caps the batch: the 13th file is rejected as overflow', async (t) => {
  const dir = useTempUploadDir(t);
  const files = Array.from({ length: 13 }, (_, index) => entry({ originalName: `photo-${index}.png` }));
  const { accepted, rejected } = await ingestUploadFiles(files);

  assert.equal(accepted.length, 12);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].originalName, 'photo-12.png');
  assert.match(rejected[0].reason, /at once/);
  assert.equal(readdirSync(dir).length, 12);
  assert.equal(new Set(accepted.map((f) => f.storedName)).size, 12, 'stored names must be unique');
});

test('ingestUploadFiles sanitises the client filename without ever using it as a path', async (t) => {
  const dir = useTempUploadDir(t);
  const { accepted, rejected } = await ingestUploadFiles([
    entry({ originalName: '../../etc/passwd', declaredType: 'image/png', buffer: ONE_PIXEL_PNG }),
    entry({ originalName: 'C:\\fakepath\\holiday.png', declaredType: 'image/png', buffer: ONE_PIXEL_PNG }),
  ]);
  assert.equal(rejected.length, 0);
  assert.equal(accepted.length, 2);
  assert.equal(accepted[0].originalName, 'passwd');
  assert.equal(accepted[1].originalName, 'holiday.png');
  // Only the two random stored names exist, nothing derived from the client name.
  assert.deepEqual(readdirSync(dir).sort(), accepted.map((f) => f.storedName).sort());
  for (const file of accepted) {
    assert.match(file.storedName, /^[a-f0-9]{32}\.png$/);
  }
});

test('ingestUploadFiles tolerates malformed input without throwing', async (t) => {
  useTempUploadDir(t);
  const { accepted, rejected } = await ingestUploadFiles([
    null,
    { originalName: 'no-buffer.png', declaredType: 'image/png' },
    { field: 'images', buffer: 'not a buffer' },
  ]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 3);
  for (const item of rejected) assert.equal(typeof item.reason, 'string');

  const empty = await ingestUploadFiles(undefined);
  assert.deepEqual(empty, { accepted: [], rejected: [] });
  const emptyList = await ingestUploadFiles([]);
  assert.deepEqual(emptyList, { accepted: [], rejected: [] });
});
