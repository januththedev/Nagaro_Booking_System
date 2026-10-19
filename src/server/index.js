/**
 * Process bootstrap.
 *
 * Order matters: migrations run before anything reads the database, the
 * database is integrity-checked on boot, and the first administrator is
 * provisioned from the environment only when no administrator exists yet.
 */
import { createServer } from 'node:http';
import { getDb, databasePath, closeDb } from './db/connection.js';
import { applyMigrations } from './db/migrate.js';
import { loadConfig, describeConfig } from './config.js';
import { createApp } from './app.js';
import { createPublicFrontendProxy } from './http/publicFrontendProxy.js';
import { ensureUploadDir } from './security/uploads.js';
import { purgeExpiredSessions } from './security/sessions.js';
import { ensureFirstAdmin } from './services/adminUserService.js';
import { reconcileCompletedReservations } from './services/bookingService.js';
import { mailerConfig } from './mail/mailer.js';
import { maybeSeedDemoData } from './db/seed.js';

const config = loadConfig();
const db = getDb();

const applied = applyMigrations(db);
if (applied.length > 0) {
  console.log(`[db] applied migrations: ${applied.join(', ')}`);
}

// Integrity gate: refuse to serve from a damaged database.
const fkProblems = db.prepare('PRAGMA foreign_key_check').all();
if (fkProblems.length > 0) {
  console.error(`[db] FATAL: ${fkProblems.length} foreign-key violations found in ${databasePath()}`);
  process.exit(1);
}
const integrity = db.prepare('PRAGMA integrity_check').get();
if (integrity && integrity.integrity_check !== 'ok') {
  console.error(`[db] FATAL: integrity_check returned ${integrity.integrity_check}`);
  process.exit(1);
}

// The anti-overlap triggers are the double-booking guarantee. Fail loudly if
// they are ever missing rather than silently accepting overlapping bookings.
const triggers = db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_occupancy_no_overlap%'",
).all().map((r) => r.name);
if (triggers.length < 2) {
  console.error(`[db] FATAL: expected 2 occupancy overlap triggers, found ${triggers.length}. Booking integrity cannot be guaranteed.`);
  process.exit(1);
}

ensureUploadDir();
purgeExpiredSessions(db);
const completed = reconcileCompletedReservations(db);
if (completed > 0) console.log(`[db] marked ${completed} past reservation(s) as completed`);

if (config.bootstrapAdmin.email && config.bootstrapAdmin.password) {
  const result = ensureFirstAdmin(db, {
    email: config.bootstrapAdmin.email,
    password: config.bootstrapAdmin.password,
    displayName: config.bootstrapAdmin.name,
  });
  if (result.created) console.log(`[auth] created first administrator ${config.bootstrapAdmin.email}`);
}

if (config.demoSeed) {
  maybeSeedDemoData(db);
}

const app = createApp({ db, config });
const publicFrontend = createPublicFrontendProxy({
  listener: { host: config.host, port: config.port },
});
const server = createServer((req, res) => {
  // A single failing request must never take the process down.
  const request = publicFrontend.shouldProxy(req)
    ? publicFrontend.handle(req, res)
    : app.handle(req, res);
  Promise.resolve(request).catch((error) => {
    console.error('[fatal-request]', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    }
  });
});

// Next's development runtime uses a WebSocket for refresh updates. Keeping the
// upgrade on this listener preserves the same-origin contract during local QA.
if (publicFrontend.config.mode === 'next') {
  server.on('upgrade', (req, socket, head) => {
    publicFrontend.handleUpgrade(req, socket, head);
  });
}

server.keepAliveTimeout = 15_000;
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

server.listen(config.port, config.host, () => {
  const mail = mailerConfig();
  console.log('Nagaro Space Booking System');
  console.log(`             ${describeConfig(config)}`);
  console.log(`             email status: ${mail.configured ? 'SMTP configured' : 'NOT configured'}`);
  console.log(`             booking integrity: ${triggers.length} anti-overlap trigger(s) active`);
  console.log(`             public frontend: ${publicFrontend.config.mode}${
    publicFrontend.config.mode === 'next' ? ` (${publicFrontend.config.origin.origin})` : ''
  }`);
  console.log(`\n  Ready at ${config.baseUrl}\n`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] shutting down`);
  server.close(() => {
    try { closeDb(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (error) => {
  console.error('[uncaughtException]', error);
  shutdown('uncaughtException');
});

export { server, app, config, db };
