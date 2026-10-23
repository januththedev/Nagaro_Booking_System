import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, closeTestDb } from '../helpers/testDb.js';
import { seedScenario } from '../helpers/concurrencyHelpers.js';
import { searchAdmin } from '../../src/server/services/adminSearchService.js';

test('global search finds spaces, customers and short-query safety', () => {
  const db = createTestDb();
  try {
    seedScenario(db);
    const bySpace = searchAdmin(db, { query: 'RACE-ROOM' });
    assert.equal(bySpace.groups[0].kind, 'spaces');
    assert.ok(bySpace.groups[0].items.some((item) => item.title === 'Race Room'));

    const byCustomer = searchAdmin(db, { query: 'Marta' });
    const customerGroup = byCustomer.groups.find((group) => group.kind === 'customers');
    assert.ok(customerGroup);
    assert.ok(customerGroup.items.some((item) => /Marta/i.test(item.title)));
    assert.ok(!JSON.stringify(byCustomer).includes('password'), 'search never returns password material');

    const short = searchAdmin(db, { query: 'M' });
    assert.equal(short.total, 0);
    assert.deepEqual(short.groups, []);
  } finally {
    closeTestDb(db);
  }
});
