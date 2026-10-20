/**
 * Synchronous compatibility facade over PostgreSQL.
 *
 * The application deliberately keeps its proven synchronous service layer.
 * Network I/O runs in a dedicated worker; the request thread waits for each
 * result, preserving the existing transaction and overlap semantics while the
 * database itself is Supabase PostgreSQL.
 */
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';

const INSERT_ID_TABLES = new Set([
  'admin_user', 'admin_session', 'audit_log', 'space', 'space_rate',
  'space_image', 'resource_unit', 'customer', 'reservation', 'occupancy',
  'maintenance_block', 'inquiry', 'booking_request', 'booking_hold_claim',
  'payment_obligation', 'payment_attempt', 'payment_event', 'ai_booking_draft',
  'assistant_knowledge',
]);

function replacePlaceholders(sql) {
  let index = 0;
  let quoted = false;
  let output = '';
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "'") {
      output += char;
      if (quoted && sql[i + 1] === "'") {
        output += sql[i + 1];
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === '?' && !quoted) {
      index += 1;
      output += `$${index}`;
    } else {
      output += char;
    }
  }
  return output;
}

export function postgresSql(sql, { returningId = false } = {}) {
  let value = String(sql).trim().replace(/;\s*$/, '');
  const caseInsensitive = /COLLATE\s+NOCASE/i.test(value);
  if (caseInsensitive) value = value.replace(/\bLIKE\b/gi, 'ILIKE');
  value = value.replace(/\s+COLLATE\s+NOCASE/gi, '');
  value = value.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO');
  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(String(sql)) && !/\bON\s+CONFLICT\b/i.test(value)) {
    value += ' ON CONFLICT DO NOTHING';
  }
  value = value.replace(
    /SUM\(MAX\(0,\s*MIN\(o\.end_at,\s*\?\)\s*-\s*MAX\(o\.start_at,\s*\?\)\)\)/gi,
    'SUM(GREATEST(0, LEAST(o.end_at, ?) - GREATEST(o.start_at, ?)))',
  );

  if (returningId && /^INSERT\s+INTO\s+([a-z_]+)/i.test(value) && !/\bRETURNING\b/i.test(value)) {
    const table = /^INSERT\s+INTO\s+([a-z_]+)/i.exec(value)?.[1]?.toLowerCase();
    if (table && INSERT_ID_TABLES.has(table)) value += ' RETURNING id';
  }
  // SQLite's BEGIN IMMEDIATE serialises writers before any guarded read. The
  // closest PostgreSQL contract is a serializable transaction: concurrent
  // booking/admin decisions cannot both commit after reading the same state.
  if (/^BEGIN\s+IMMEDIATE$/i.test(value)) value = 'BEGIN ISOLATION LEVEL SERIALIZABLE';
  return replacePlaceholders(value);
}

class PostgresStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
  }

  all(...params) {
    return this.database._query(postgresSql(this.sql), params).rows;
  }

  get(...params) {
    return this.database._query(postgresSql(this.sql), params).rows[0];
  }

  run(...params) {
    const response = this.database._query(postgresSql(this.sql, { returningId: true }), params);
    return {
      changes: response.rowCount,
      lastInsertRowid: response.rows[0]?.id ?? 0,
    };
  }
}

export class PostgresDatabaseSync {
  constructor(connectionString) {
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(new URL('./postgresWorker.js', import.meta.url), {
      workerData: { connectionString, port: port2 },
      transferList: [port2],
    });
    this.dialect = 'postgres';
    try {
      this._call({ op: 'init' }, 20_000);
    } catch {
      this.port.close();
      void this.worker.terminate();
      throw new Error('Could not connect to the configured PostgreSQL database.');
    }
  }

  _call(message, timeout = 30_000) {
    const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const view = new Int32Array(signal);
    this.port.postMessage({ ...message, signal });
    const wait = Atomics.wait(view, 0, 0, timeout);
    if (wait === 'timed-out') throw new Error('PostgreSQL operation timed out.');
    const packet = receiveMessageOnPort(this.port)?.message;
    if (!packet) throw new Error('PostgreSQL worker returned no result.');
    if (!packet.ok) {
      const error = new Error(packet.error?.message ?? 'PostgreSQL operation failed.');
      if (packet.error?.code) error.code = packet.error.code;
      throw error;
    }
    return packet;
  }

  _query(sql, params = []) {
    return this._call({ op: 'query', sql, params });
  }

  prepare(sql) {
    return new PostgresStatement(this, sql);
  }

  exec(sql) {
    this._query(postgresSql(sql));
  }

  close() {
    try { this._call({ op: 'close' }, 10_000); } catch { /* already closed */ }
    this.port.close();
    void this.worker.terminate();
  }
}
