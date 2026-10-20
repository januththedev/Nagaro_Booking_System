/**
 * Vercel serverless entry point.
 *
 * Vercel Node.js functions provide standard (req, res) objects, so the
 * existing application router is reused unchanged: one lazy singleton per
 * function instance, then `app.handle(req, res)` exactly like index.js.
 *
 * Database policy (never silent):
 *   - DATABASE_URL set      -> connect to persistent Supabase PostgreSQL using
 *     the compatibility adapter and require the migrated schema.
 *   - DATABASE_URL unset    -> refuse to boot UNLESS the operator explicitly
 *     opts into an ephemeral throwaway SQLite file with
 *     NAGARO_ALLOW_EPHEMERAL_SQLITE=1 (preview/demo only: nothing persists).
 *
 * No secret value is ever written to logs or responses.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let cached = null;

function fail(res, status, message) {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  res.end(JSON.stringify({ ok: false, error: { code: 'CONFIGURATION_ERROR', message } }));
}

export function resetServerlessAppForTests() {
  cached = null;
}

async function buildApp() {
  if (cached) return cached;
  const { loadConfig } = await import('../src/server/config.js');
  const config = loadConfig();

  if (config.isVercel && !config.allowEphemeralSqlite && !config.databaseUrl) {
    throw new Error(
      'No persistent database is configured. Set DATABASE_URL (Supabase PostgreSQL) or '
      + 'explicitly opt into an ephemeral demo database with NAGARO_ALLOW_EPHEMERAL_SQLITE=1.',
    );
  }

  const { getDb } = await import('../src/server/db/connection.js');
  const { applyMigrations } = await import('../src/server/db/migrate.js');
  const { createApp } = await import('../src/server/app.js');
  const { ensureUploadDir } = await import('../src/server/security/uploads.js');
  const { blobEnabled } = await import('../src/server/security/blobStorage.js');
  const { purgeExpiredSessions } = await import('../src/server/security/sessions.js');
  const { reconcileCompletedReservations } = await import('../src/server/services/bookingService.js');
  const { ensureFirstAdmin } = await import('../src/server/services/adminUserService.js');

  if (config.isVercel && !config.databaseUrl) {
    // Serverless filesystems are ephemeral: keep throwaway state in /tmp and
    // say so loudly in the function logs (never a secret, just the mode).
    console.log('[nagaro] ephemeral preview mode: SQLite and uploads live in the instance temp directory and do not persist.');
    process.env.NAGARO_DB_PATH ??= join(tmpdir(), 'nagaro-preview.db');
    process.env.NAGARO_UPLOAD_DIR ??= join(tmpdir(), 'nagaro-preview-uploads');
  }

  const db = getDb();
  if (db.dialect === 'postgres') {
    const schema = db.prepare("SELECT to_regclass('public.space') AS space_table").get();
    if (!schema?.space_table) {
      throw new Error('Supabase is reachable but not migrated. Run npm run migrate:postgres with DIRECT_URL first.');
    }
    const guard = db.prepare(`
      SELECT COUNT(*) AS c
        FROM pg_constraint
       WHERE conname = 'occupancy_no_overlap' AND contype = 'x'
    `).get();
    if (Number(guard?.c ?? 0) < 1) {
      throw new Error('Refusing to serve: the PostgreSQL occupancy overlap constraint is missing.');
    }
  } else {
    applyMigrations(db);
    const fkProblems = db.prepare('PRAGMA foreign_key_check').all();
    if (fkProblems.length > 0) throw new Error(`Refusing to serve: ${fkProblems.length} foreign-key violation(s).`);
    const triggers = db.prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_occupancy_no_overlap%'",
    ).get().c;
    if (Number(triggers) < 2) throw new Error('Refusing to serve: occupancy overlap triggers are missing.');
  }

  if (!blobEnabled()) ensureUploadDir();
  purgeExpiredSessions(db);
  reconcileCompletedReservations(db);

  if (config.bootstrapAdmin.email && config.bootstrapAdmin.password) {
    const result = ensureFirstAdmin(db, {
      email: config.bootstrapAdmin.email,
      password: config.bootstrapAdmin.password,
      displayName: config.bootstrapAdmin.name,
    });
    if (result.created) console.log('[nagaro] created first administrator (see NAGARO_BOOTSTRAP_ADMIN_EMAIL).');
  }

  cached = createApp({ db, config });
  return cached;
}

export default async function handler(req, res) {
  let app;
  try {
    app = await buildApp();
  } catch (error) {
    // Boot/configuration failures only: buildApp throws authored, secret-free
    // messages (see the guards above), so the message itself is safe to show.
    console.error('[nagaro] function boot failed:', error?.message ?? error);
    if (!res.headersSent && !res.writableEnded) {
      fail(res, 500, String(error?.message ?? 'The application is not configured correctly.'));
    } else {
      try { res.destroy(); } catch { /* ignore */ }
    }
    return;
  }
  try {
    const originalUrl = req.headers?.['x-nagaro-original-url'];
    if (typeof originalUrl === 'string' && /^\/[A-Za-z0-9_?&=/%+.,:@~-]*$/.test(originalUrl)) {
      req.url = originalUrl;
    }
    await app.handle(req, res);
  } catch (error) {
    console.error('[nagaro] request failed:', error?.message ?? error);
    if (!res.headersSent && !res.writableEnded) {
      fail(res, 500, 'Something went wrong on our side. The operation was not completed.');
    } else {
      try { res.destroy(); } catch { /* ignore */ }
    }
  }
}
