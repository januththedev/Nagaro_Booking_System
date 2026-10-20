import { workerData } from 'node:worker_threads';
import pg from 'pg';
import { pgConnectionConfig } from './pgSsl.js';

// node-postgres returns int8/BIGINT values as strings to protect precision.
// Every id and epoch-millisecond timestamp in this codebase is a plain number
// (SQLite semantics), and views format those timestamps directly — so parse
// int8 back to Number at the driver boundary, where the whole application
// expects it.
pg.types.setTypeParser(20, (value) => Number(value));

const port = workerData.port;
let client = null;
let lastQueryAt = 0;
let inTransaction = false;

function createClient() {
  const next = new pg.Client({
    ...pgConnectionConfig(workerData.connectionString),
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: 'nagaro-booking',
  });
  // A warm serverless instance can lose an idle TCP socket. Query failures are
  // handled below; the listener prevents an asynchronous socket error from
  // terminating the worker before it can recycle the connection.
  next.on('error', () => {});
  return next;
}

async function closeClient() {
  const current = client;
  client = null;
  inTransaction = false;
  if (current) {
    try { await current.end(); } catch { /* stale socket */ }
  }
}

async function connectClient() {
  await closeClient();
  client = createClient();
  await client.connect();
  lastQueryAt = Date.now();
}

function withTimeout(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('PostgreSQL liveness check timed out.')), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function ensureLiveConnection({ force = false } = {}) {
  if (!client) {
    await connectClient();
    return;
  }
  if (!force && Date.now() - lastQueryAt < 15_000) return;
  try {
    await withTimeout(client.query('SELECT 1'), 3_000);
    lastQueryAt = Date.now();
  } catch {
    await connectClient();
  }
}

function isConnectionFailure(error) {
  const code = String(error?.code ?? '');
  return code.startsWith('08')
    || ['57P01', '57P02', '57P03', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(code);
}

function serialiseError(error) {
  let message = String(error?.message ?? 'PostgreSQL query failed.');
  if (error?.code === '23P01') message = 'DOUBLE_BOOKING_CONFLICT';
  if (error?.code === '23505') {
    const column = /Key \(([^)]+)\)=/.exec(String(error?.detail ?? ''))?.[1] ?? 'unique_value';
    message = `UNIQUE constraint failed: ${column}`;
  }
  if (error?.code === '23503') message = 'FOREIGN KEY constraint failed';
  if (error?.code === '23514') message = `CHECK constraint failed: ${error?.constraint ?? 'validation'}`;
  return { message, code: error?.code ?? null };
}

async function execute(message) {
  if (message.op === 'init') {
    await connectClient();
    return { ok: true };
  }
  if (message.op === 'close') {
    await closeClient();
    return { ok: true };
  }
  if (!client) throw new Error('PostgreSQL connection is not initialised.');

  const sql = String(message.sql ?? '').trim();
  const beginsTransaction = /^BEGIN\b/i.test(sql);
  await ensureLiveConnection({ force: beginsTransaction });

  let result;
  try {
    result = await client.query(sql, message.params ?? []);
  } catch (error) {
    // Retrying inside a transaction could split an atomic operation across
    // connections, so fail closed there. Outside a transaction, recycle one
    // stale serverless socket and make a single safe retry.
    if (inTransaction || !isConnectionFailure(error)) throw error;
    await connectClient();
    result = await client.query(sql, message.params ?? []);
  }
  lastQueryAt = Date.now();
  if (beginsTransaction) inTransaction = true;
  if (/^(?:COMMIT|ROLLBACK)\b/i.test(sql)) inTransaction = false;
  return {
    ok: true,
    rows: result.rows ?? [],
    rowCount: Number(result.rowCount ?? 0),
  };
}

port.on('message', async (message) => {
  const signal = new Int32Array(message.signal);
  let response;
  try {
    response = await execute(message);
  } catch (error) {
    response = { ok: false, error: serialiseError(error) };
  }
  port.postMessage(response);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0, 1);
});
port.start();
