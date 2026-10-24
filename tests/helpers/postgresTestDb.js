import { MessageChannel, Worker } from 'node:worker_threads';
import { PostgresDatabaseSync } from '../../src/server/db/postgresCompat.js';
import { applyPgMigrations } from '../../scripts/migrate-postgres.js';

/** Real PostgreSQL (WASM), real shipped SQL/constraints, production SQL adapter.
 * Does not exercise TCP, TLS, Supabase's pooler, or multi-client concurrency. */
export async function createPostgresTestDb() {
  const db = Object.create(PostgresDatabaseSync.prototype);
  const { port1, port2 } = new MessageChannel();
  db.port = port1;
  db.worker = new Worker(new URL('./postgresTestWorker.js', import.meta.url), {
    workerData: { port: port2 }, transferList: [port2],
  });
  db.dialect = 'postgres';
  try {
    await applyPgMigrations({ query: (sql, params = []) => db._query(sql, params) });
    return db;
  } catch (error) { db.close(); throw error; }
}
