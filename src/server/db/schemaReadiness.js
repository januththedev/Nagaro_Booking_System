/** Detect an outdated production schema before sign-in creates an unusable session.
 * Migrations remain an explicit release operation; request traffic never runs DDL. */
export function assertPostgresSchemaReady(db) {
  if (db.dialect !== 'postgres') return;
  const required = {
    admin_user: ['is_super_admin', 'deleted_at', 'deleted_by', 'purge_after', 'must_change_password'],
    notification: ['admin_user_id', 'read_at', 'dedupe_key'],
    push_subscription: ['admin_user_id', 'endpoint'],
    payment_obligation: ['advance_paid_cents'],
    payment_attempt: ['advance_cents'],
  };
  const columns = db.prepare(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('admin_user','notification','push_subscription','payment_obligation','payment_attempt')`).all();
  const present = new Set(columns.map((row) => `${row.table_name}.${row.column_name}`));
  const missing = Object.entries(required).flatMap(([table, names]) => names.filter((name) => !present.has(`${table}.${name}`)).map((name) => `${table}.${name}`));
  if (missing.length) {
    const error = new Error('Database schema is out of date. Run npm run migrate:postgres using the production DIRECT_URL before deploying this release. Missing: ' + missing.join(', ') + '.');
    error.code = 'SCHEMA_OUTDATED';
    throw error;
  }
}
