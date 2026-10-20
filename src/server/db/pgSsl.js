/**
 * TLS handling for node-postgres against Supabase.
 *
 * Current node-postgres releases treat `sslmode=require` as an alias of
 * `verify-full`, but the Supabase connection pooler presents a certificate
 * chain (Amazon RDS CA) that Node's bundled trust store does not carry in
 * full — the handshake fails with "self-signed certificate in certificate
 * chain" before any query runs, on a laptop and on Vercel alike. Supabase's
 * own serverless guidance for these poolers is to encrypt the connection and
 * skip chain verification.
 *
 * Policy:
 *   - no `sslmode` / `disable` / `allow` / `prefer` -> no explicit TLS options;
 *   - `verify-ca` / `verify-full`                   -> full chain verification
 *     (for operators who terminate TLS elsewhere and supply a CA);
 *   - anything else (`require`, …)                  -> encrypted without chain
 *     verification, the documented Supabase pooler setting.
 *
 * The connection is always encrypted; only certificate *chain* verification is
 * relaxed, and only where the operator has not asked for strict verification.
 *
 * Note on `pgConnectionConfig`: node-postgres merges `sslmode` from the
 * connection string *after* an explicit `ssl` object, so the URL's strict
 * alias silently wins and the handshake still fails. The helper strips the
 * query parameter and passes the decision explicitly instead.
 */

export function pgSslOptions(connectionString = '') {
  const url = String(connectionString ?? '');
  const mode = /\bsslmode=([a-z-]+)/i.exec(url)?.[1]?.toLowerCase() ?? null;
  if (!mode || mode === 'disable' || mode === 'allow' || mode === 'prefer') return undefined;
  if (mode === 'verify-full' || mode === 'verify-ca') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

export function pgConnectionConfig(connectionString = '') {
  const raw = String(connectionString ?? '');
  const normalized = raw
    .replace(/\?sslmode=[a-z-]+&?/i, '?')
    .replace(/[?&]sslmode=[a-z-]+/i, '')
    .replace(/\?$/, '');
  return { connectionString: normalized, ssl: pgSslOptions(raw) };
}
