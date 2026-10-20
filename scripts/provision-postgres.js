/**
 * Provision a production Supabase database from a trusted machine.
 *
 * This deliberately does not run during a Vercel build: migrations and the
 * initial catalogue are an explicit release operation and must not race across
 * concurrent builds. DIRECT_URL is preferred; DATABASE_URL is the fallback.
 */
import pg from 'pg';
import { pgConnectionConfig } from '../src/server/db/pgSsl.js';
import { applyPgMigrations, pgConnectionString } from './migrate-postgres.js';

const connectionString = pgConnectionString();
if (!connectionString) {
  console.error('Set DIRECT_URL (preferred) or DATABASE_URL before provisioning Supabase.');
  process.exit(2);
}

const client = new pg.Client({
  ...pgConnectionConfig(connectionString),
  connectionTimeoutMillis: 15_000,
  application_name: 'nagaro-provision',
});

try {
  await client.connect();
  const applied = await applyPgMigrations(client);
  console.log(applied.length > 0 ? `Applied ${applied.length} PostgreSQL migration(s).` : 'No pending PostgreSQL migrations.');
} catch (error) {
  console.error(`Supabase provisioning failed during migration: ${error.message}`);
  process.exit(1);
} finally {
  try { await client.end(); } catch { /* connection never opened or already closed */ }
}

// The synchronous application adapter reads DATABASE_URL. For this trusted,
// one-off command it should use the same direct/session connection as the
// migration phase rather than the serverless transaction pooler.
process.env.DATABASE_URL = connectionString;

const { getDb, closeDb } = await import('../src/server/db/connection.js');
const { ensureFirstAdmin } = await import('../src/server/services/adminUserService.js');
const { provisionProductionCatalogue } = await import('../src/server/db/provisionCatalogue.js');

try {
  const db = getDb();
  let admin = db.prepare(`
    SELECT id, email, display_name, role
      FROM admin_user
     WHERE COALESCE(is_system, 0) = 0 AND role = 'ADMIN' AND is_active = 1
     ORDER BY id
     LIMIT 1
  `).get();

  if (!admin) {
    const email = String(process.env.NAGARO_BOOTSTRAP_ADMIN_EMAIL ?? '').trim();
    const password = String(process.env.NAGARO_BOOTSTRAP_ADMIN_PASSWORD ?? '');
    const displayName = String(process.env.NAGARO_BOOTSTRAP_ADMIN_NAME ?? 'Nagaro Administrator').trim();
    if (!email || !password) {
      throw new Error(
        'The database has no administrator. Set NAGARO_BOOTSTRAP_ADMIN_EMAIL and '
        + 'NAGARO_BOOTSTRAP_ADMIN_PASSWORD for this one provisioning run.',
      );
    }
    ensureFirstAdmin(db, { email, password, displayName });
    admin = db.prepare(`
      SELECT id, email, display_name, role
        FROM admin_user
       WHERE COALESCE(is_system, 0) = 0 AND role = 'ADMIN' AND is_active = 1
       ORDER BY id
       LIMIT 1
    `).get();
  }

  const actor = {
    id: Number(admin.id),
    label: `${admin.display_name} (${admin.role})`,
    role: admin.role,
  };
  const { before, after, catalogue } = provisionProductionCatalogue(db, { actor });
  console.log(before > 0
    ? `Catalogue already present (${after} spaces); no duplicate spaces were created.`
    : `Provisioned ${catalogue.length} published spaces with verified TRACE editorial covers.`);
} catch (error) {
  console.error(`Supabase provisioning failed during catalogue setup: ${error.message}`);
  process.exitCode = 1;
} finally {
  closeDb();
}
