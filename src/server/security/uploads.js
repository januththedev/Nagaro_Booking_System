/**
 * Uploaded-photograph storage.
 *
 * This module is the only place where untrusted binary data crosses the
 * system boundary, so every rule here is defensive:
 *
 *   - the MIME type is decided by magic bytes (`sniffImageType`), never by the
 *     client-supplied filename or Content-Type;
 *   - SVG is rejected outright (script execution risk);
 *   - a stored name is 32 random hex characters plus an extension derived from
 *     the sniffed MIME, so a client filename can never influence a path;
 *   - files are created with the `wx` flag (never silently overwriting) and
 *     mode 0o640 inside a mode 0o750 directory;
 *   - `storedPathFor` re-validates the name and proves the resolved path is
 *     still directly inside `uploadDir()`.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { assertUploadableImage, LIMITS, sniffImageType } from '../domain/validation.js';
import { AppError, validationError } from '../domain/errors.js';

/** A stored name is exactly: 32 lowercase hex characters + `.` + jpg|png|webp. */
const STORED_NAME_RE = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

const DEFAULT_SUBDIR = ['storage', 'uploads'];

const EXTENSION_BY_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

const MIME_BY_EXTENSION = Object.freeze({
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
});

/* ------------------------------------------------------------------- paths */

/**
 * Absolute storage root. Configurable through `NAGARO_UPLOAD_DIR`; defaults to
 * `<cwd>/storage/uploads`, which is deliberately outside the web root.
 */
export function uploadDir() {
  const configured = process.env.NAGARO_UPLOAD_DIR;
  if (typeof configured === 'string' && configured.trim() !== '') {
    return resolve(configured.trim());
  }
  return resolve(process.cwd(), ...DEFAULT_SUBDIR);
}

/** Create the storage root. Idempotent, restricted permissions where supported. */
export function ensureUploadDir() {
  const dir = uploadDir();
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  // Windows ignores POSIX modes on create; tighten best-effort elsewhere.
  try { chmodSync(dir, 0o750); } catch { /* unsupported platform */ }
  return dir;
}

/**
 * Is `name` a well-formed stored name?
 *
 * The character class and the anchored length make this a strict allow-list:
 * uppercase hex, `..`, slashes, backslashes, percent escapes, NUL bytes,
 * extensions other than jpg/png/webp and non-string values all fail.
 */
export function isSafeStoredName(name) {
  return typeof name === 'string' && STORED_NAME_RE.test(name);
}

/**
 * Resolve a stored name to an absolute path, proving containment.
 *
 * The single most important function in this module: even though
 * `isSafeStoredName` already excludes traversal characters, this function
 * re-checks the resolved result against `uploadDir()` so that a future change
 * to the name pattern cannot turn into a path-traversal bug.
 */
export function storedPathFor(storedName) {
  if (typeof storedName !== 'string' || storedName.length === 0) {
    throw validationError('Invalid media name.');
  }
  // Defence in depth: these can never occur in a valid name, but reject them
  // explicitly so the guarantee does not depend on the regular expression.
  if (storedName.includes('\u0000')
    || storedName.includes('/')
    || storedName.includes('\\')
    || storedName.includes('..')) {
    throw validationError('Invalid media name.');
  }
  if (!isSafeStoredName(storedName)) {
    throw validationError('Invalid media name.');
  }

  const dir = resolve(uploadDir());
  const full = resolve(dir, storedName);
  const rel = relative(dir, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw validationError('Invalid media path.');
  }
  if (dirname(full) !== dir) {
    throw validationError('Invalid media path.');
  }
  return full;
}

/* ------------------------------------------------------------------ mime */

/** `image/jpeg -> jpg`, `image/png -> png`, `image/webp -> webp`. Throws otherwise. */
export function extensionForMime(mime) {
  const key = String(mime ?? '').trim().toLowerCase();
  const ext = EXTENSION_BY_MIME[key];
  if (!ext) throw validationError('Unsupported image type.');
  return ext;
}

/** Content-Type for a *stored* name. Derived from the extension only. */
export function mimeForStoredName(storedName) {
  const ext = String(storedName ?? '').slice(String(storedName ?? '').lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/* ------------------------------------------------------------------ writes */

/**
 * Store one already-validated image buffer.
 *
 * Returns `{ storedName, byteSize, mimeType }`. The caller decides the
 * content type by sniffing first; this function re-verifies that the bytes
 * still match that type so an extension/content mismatch cannot slip through.
 * Opens with `wx` so a collision cannot overwrite an existing photograph and
 * retries with a fresh random name on `EEXIST`.
 */
export function storeImage(buffer, sniffedMime, { originalName = null } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw validationError('The uploaded image is empty.');
  }
  if (buffer.length > LIMITS.maxImageBytes) {
    throw validationError(`Images must be ${Math.floor(LIMITS.maxImageBytes / (1024 * 1024))} MB or smaller.`);
  }
  const ext = extensionForMime(sniffedMime);
  const actual = sniffImageType(buffer);
  if (actual !== sniffedMime) {
    throw validationError('The uploaded file content does not match a supported image type.');
  }

  ensureUploadDir();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const storedName = `${randomBytes(16).toString('hex')}.${ext}`;
    const absolutePath = storedPathFor(storedName); // containment proved here
    let handle = null;
    try {
      handle = openSync(absolutePath, 'wx', 0o640);
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      throw error;
    }
    try {
      let offset = 0;
      while (offset < buffer.length) {
        offset += writeSync(handle, buffer, offset, buffer.length - offset, offset);
      }
    } catch (error) {
      try { closeSync(handle); } catch { /* already closed */ }
      handle = null;
      // Do not leave a partial file behind.
      try { unlinkSync(absolutePath); } catch { /* ignore */ }
      throw error;
    } finally {
      if (handle !== null) {
        try { closeSync(handle); } catch { /* ignore */ }
      }
    }
    return { storedName, byteSize: buffer.length, mimeType: sniffedMime };
  }
  throw new Error('Could not allocate a unique storage name for the upload.');
}

/**
 * Delete a stored file. Rejects unsafe names, returns `false` for anything
 * that is unsafe, missing or not a regular file, and never throws.
 */
export function removeStoredImage(storedName) {
  try {
    if (!isSafeStoredName(storedName)) return false;
    const absolutePath = storedPathFor(storedName);
    let stat = null;
    try { stat = statSync(absolutePath); } catch { return false; }
    if (!stat.isFile()) return false;
    unlinkSync(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- ingestion */

/**
 * Turn the `__files` array produced by `parseMultipartBody` into accepted
 * photographs (written to disk) and rejected entries with a friendly reason.
 *
 * `files` = `[{ field, originalName, declaredType, buffer }]`.
 * Returns `{ accepted: [{ storedName, byteSize, mimeType, originalName }],
 *            rejected: [{ originalName, reason }] }`.
 */
export async function ingestUploadFiles(files, { maxFiles = LIMITS.maxImagesPerSpace } = {}) {
  const list = Array.isArray(files) ? files : [];
  const limit = Number.isInteger(maxFiles) && maxFiles >= 0 ? maxFiles : LIMITS.maxImagesPerSpace;
  const accepted = [];
  const rejected = [];
  let processed = 0;

  for (const entry of list) {
    const originalName = sanitizeOriginalName(entry?.originalName);
    if (processed >= limit) {
      rejected.push({ originalName, reason: `Only ${limit} photographs can be uploaded at once.` });
      continue;
    }
    processed += 1;

    if (!entry || !Buffer.isBuffer(entry.buffer)) {
      rejected.push({ originalName, reason: 'The file could not be read. Try choosing it again.' });
      continue;
    }

    try {
      // Magic bytes decide the type; the declared Content-Type only has to be
      // consistent with what the bytes actually are.
      const sniffed = assertUploadableImage(entry.buffer, entry.declaredType ?? '', { field: 'image' });
      const stored = storeImage(entry.buffer, sniffed, { originalName });
      accepted.push({ ...stored, originalName });
    } catch (error) {
      rejected.push({ originalName, reason: uploadProblem(error) });
    }
  }

  return { accepted, rejected };
}

function uploadProblem(error) {
  // Only application-authored validation text is safe to show. Raw filesystem
  // errors contain absolute paths, so they are never surfaced.
  if (error instanceof AppError && typeof error.message === 'string' && error.message.trim() !== '') {
    return error.message;
  }
  return 'The file could not be stored.';
}

/** The client filename is recorded for display only - never used in a path. */
export function sanitizeOriginalName(raw) {
  let name = String(raw ?? '').replace(/\u0000/g, '');
  // Drop any directory component, including legacy `C:\fakepath\...` values.
  name = name.split(/[\\/]/).pop() ?? '';
  // Control characters have no place in a displayed name.
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name === '') name = 'upload';
  if (name.length > LIMITS.maxNameLength) name = name.slice(0, LIMITS.maxNameLength);
  return name;
}
