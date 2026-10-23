/**
 * Database-backed fixed-window rate limiting.
 *
 * Stored in SQLite rather than process memory so the limit holds across
 * multiple application processes and survives restarts.
 */
import { rateLimited } from '../domain/errors.js';
import { hashIp } from './sessions.js';

/**
 * Increment a counter and return the new count within the current window.
 * Runs in its own short transaction so concurrent submissions cannot each see
 * a stale count.
 */
export function hit(db, bucketKey, { windowMs = 60_000, now = Date.now() } = {}) {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  db.exec('BEGIN IMMEDIATE');
  try {
    // The target column is qualified deliberately: PostgreSQL rejects an
    // unqualified `count = count + 1` here (42702, ambiguous between the
    // existing row and the `excluded` proposal), while SQLite accepts both.
    db.prepare(`INSERT INTO rate_limit_counter (bucket_key, window_start, count) VALUES (?,?,1)
                ON CONFLICT(bucket_key, window_start) DO UPDATE SET count = rate_limit_counter.count + 1`)
      .run(bucketKey, windowStart);
    const row = db.prepare('SELECT count FROM rate_limit_counter WHERE bucket_key = ? AND window_start = ?')
      .get(bucketKey, windowStart);
    db.prepare('DELETE FROM rate_limit_counter WHERE window_start < ?').run(now - 24 * 3600 * 1000);
    db.exec('COMMIT');
    return { count: row.count, windowStart, windowMs };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

/** Increment and throw 429 when the limit is exceeded. */
export function enforce(db, bucketKey, { limit, windowMs = 60_000, now = Date.now(), message = null } = {}) {
  const result = hit(db, bucketKey, { windowMs, now });
  if (result.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((result.windowStart + windowMs - now) / 1000));
    const error = rateLimited(message ?? `Too many requests. Please try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`);
    error.details = { retryAfterSeconds: retryAfter };
    throw error;
  }
  return result;
}

export function ipBucket(scope, ip) {
  return `${scope}:ip:${hashIp(String(ip ?? 'unknown'))}`;
}

export function emailBucket(scope, email) {
  return `${scope}:email:${String(email ?? '').trim().toLowerCase()}`;
}

/** Per-IP and per-email combined check, used by sign-in and inquiries. */
export function enforcePublicInquiryLimits(db, { ip, email, now = Date.now() }) {
  enforce(db, ipBucket('inquiry', ip), {
    limit: 8, windowMs: 15 * 60_000, now,
    message: 'Too many booking requests from this connection. Please try again shortly.',
  });
  enforce(db, emailBucket('inquiry', email), {
    limit: 5, windowMs: 60 * 60_000, now,
    message: 'Too many booking requests for this email address. Please try again later.',
  });
}

/** Anonymous read protection for cache-miss-heavy public data endpoints. */
export function enforcePublicReadLimit(db, {
  ip, scope = 'public-read', limit = 120, windowMs = 60_000, now = Date.now(),
} = {}) {
  return enforce(db, ipBucket(scope, ip), {
    limit,
    windowMs,
    now,
    message: 'Too many availability checks from this connection. Please try again shortly.',
  });
}

export function enforceLoginLimits(db, { ip, email, now = Date.now() }) {
  enforce(db, ipBucket('login', ip), {
    limit: 30, windowMs: 15 * 60_000, now,
    message: 'Too many sign-in attempts. Please wait a few minutes.',
  });
  if (email) {
    enforce(db, emailBucket('login', email), {
      limit: 12, windowMs: 15 * 60_000, now,
      message: 'Too many sign-in attempts for this account. Please wait a few minutes.',
    });
  }
}

export function enforceAdminMutationLimit(db, { actorId, now = Date.now() }) {
  enforce(db, `admin-mutation:user:${actorId}`, {
    limit: 600, windowMs: 60_000, now,
    message: 'Too many operations in a short period. Please slow down.',
  });
}
