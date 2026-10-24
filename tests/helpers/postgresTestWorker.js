import { workerData } from 'node:worker_threads';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
const db = new PGlite({ extensions: { citext, btree_gist } });
const port = workerData.port;
port.on('message', async (message) => {
  const signal = new Int32Array(message.signal);
  let packet;
  try {
    if (message.op === 'close') { await db.close(); packet = { ok: true }; }
    else {
      const result = message.params?.length
        ? await db.query(message.sql, message.params)
        : (await db.exec(message.sql)).at(-1);
      packet = { ok: true, rows: result?.rows ?? [], rowCount: result?.affectedRows ?? 0 };
    }
  } catch (error) {
    packet = { ok: false, error: { code: error.code, message: error.code === '23P01' ? 'DOUBLE_BOOKING_CONFLICT' : error.message } };
  }
  port.postMessage(packet);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
port.start();
