import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const many = (sql, ...p) => db.prepare(sql).all(...p);

console.log('spaces:');
for (const r of many('SELECT code, name, category, status, capacity FROM space ORDER BY code')) {
  const units = one('SELECT COUNT(*) c FROM resource_unit WHERE space_id = (SELECT id FROM space WHERE code=?) AND is_active=1', r.code).c;
  const imgs = one('SELECT COUNT(*) c FROM space_image WHERE space_id = (SELECT id FROM space WHERE code=?)', r.code).c;
  console.log(`  ${r.code.padEnd(12)} ${r.category.padEnd(14)} ${r.status.padEnd(10)} cap=${String(r.capacity).padEnd(4)} units=${units} images=${imgs}  ${r.name}`);
}
console.log('rates:', JSON.stringify(many('SELECT s.code, r.unit, r.amount_cents FROM space_rate r JOIN space s ON s.id=r.space_id ORDER BY s.code, r.amount_cents').map(x => `${x.code}:${x.unit}=${x.amount_cents}`)));
console.log('customers:', one('SELECT COUNT(*) c FROM customer').c);
console.log('reservations:');
for (const r of many('SELECT reference, status, start_at, end_at, unit_count, total_cents FROM reservation ORDER BY id')) {
  const occ = one("SELECT COUNT(*) c FROM occupancy WHERE reservation_id=(SELECT id FROM reservation WHERE reference=?) AND status='ACTIVE'", r.reference).c;
  console.log(`  ${r.reference} ${r.status.padEnd(10)} units=${r.unit_count} activeOcc=${occ} total=${r.total_cents}`);
}
console.log('occupancy totals:', one("SELECT COUNT(*) c FROM occupancy").c, 'active:', one("SELECT COUNT(*) c FROM occupancy WHERE status='ACTIVE'").c);
console.log('maintenance:', JSON.stringify(many('SELECT id, reason, status FROM maintenance_block')));
console.log('inquiries:', JSON.stringify(many('SELECT reference, status, email_status FROM inquiry')));
console.log('admin users:', JSON.stringify(many('SELECT email, role, is_active FROM admin_user')));
console.log('audit rows:', one('SELECT COUNT(*) c FROM audit_log').c);
console.log('triggers:', many("SELECT name FROM sqlite_master WHERE type='trigger'").map(r => r.name).join(', '));
console.log('fk_check:', many('PRAGMA foreign_key_check').length, 'problems');
console.log('integrity:', one('PRAGMA integrity_check').integrity_check);
console.log('\noverlap guard check (any pair of ACTIVE overlapping rows on same unit):');
const overlaps = many(`
  SELECT o1.id AS a, o2.id AS b, o1.resource_unit_id AS unit
    FROM occupancy o1 JOIN occupancy o2
      ON o1.resource_unit_id = o2.resource_unit_id AND o1.id < o2.id
   WHERE o1.status='ACTIVE' AND o2.status='ACTIVE'
     AND o1.start_at < o2.end_at AND o1.end_at > o2.start_at`);
console.log('  overlapping ACTIVE pairs:', overlaps.length === 0 ? 'NONE (correct)' : JSON.stringify(overlaps));
db.close();
