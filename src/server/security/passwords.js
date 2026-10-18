/**
 * Password hashing with scrypt (Node standard library).
 * Format: scrypt$N$r$p$<salt-b64url>$<hash-b64url>
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const PARAMS = { N: 16_384, r: 8, p: 1, keylen: 64 };

export function hashPassword(plain) {
  const password = String(plain ?? '');
  if (password.length < 10) {
    throw new Error('Password must be at least 10 characters long.');
  }
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, PARAMS.keylen, {
    N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: 128 * PARAMS.N * PARAMS.r * 2,
  });
  return [
    'scrypt', PARAMS.N, PARAMS.r, PARAMS.p,
    salt.toString('base64url'), derived.toString('base64url'),
  ].join('$');
}

/** Constant-time verification. Returns false for malformed hashes. */
export function verifyPassword(plain, stored) {
  try {
    const parts = String(stored ?? '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const derived = scryptSync(String(plain ?? ''), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * Number(n) * Number(r) * 2,
    });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Minimum requirements for a new staff password. */
export function passwordProblems(password) {
  const value = String(password ?? '');
  const problems = [];
  if (value.length < 10) problems.push('Use at least 10 characters.');
  if (!/[A-Za-z]/.test(value)) problems.push('Include at least one letter.');
  if (!/\d/.test(value)) problems.push('Include at least one number.');
  if (/^(password|1234567890|qwertyuiop)/i.test(value)) problems.push('Avoid common passwords.');
  return problems;
}
