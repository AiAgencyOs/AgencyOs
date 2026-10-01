import assert from 'node:assert/strict';
import { test } from 'node:test';

import { duplicateCounts } from '@/lib/admin/duplicate-clients';
import { groupRepeats } from '@/lib/admin/notification-groups';
import { conditionToParam, parseConditions } from '@/lib/admin/search-conditions';

const OWNER = '3f1c2a9e-0000-4000-8000-000000000001';

test('four failed deliveries collapse into one lead row, two approvals with one title stay two', () => {
  const rows = [
    { key: 'delivery-4', category: 'delivery', title: 'Failed client delivery' },
    { key: 'approval-1', category: 'approval', title: 'Quotation approval' },
    { key: 'delivery-3', category: 'delivery', title: 'Failed client delivery' },
    { key: 'approval-2', category: 'approval', title: 'Quotation approval' },
    { key: 'delivery-2', category: 'delivery', title: 'Failed client delivery' },
    { key: 'delivery-1', category: 'delivery', title: 'Failed client delivery' },
  ];
  const groups = groupRepeats(rows);
  assert.equal(groups.length, 3);
  const deliveries = groups.find((g) => g.lead.category === 'delivery');
  assert.equal(deliveries?.lead.key, 'delivery-4', 'the newest (first listed) leads');
  assert.equal(deliveries?.repeats.length, 3);
  assert.deepEqual(groups.filter((g) => g.lead.category === 'approval').map((g) => g.repeats.length), [0, 0]);
});

test('filter-builder conditions parse, stack, and drop what is malformed', () => {
  const parsed = parseConditions([
    'status:is:qualified',
    'status:not:lost',
    `owner:is:${OWNER}`,
    'created:after:2026-09-01',
    'created:after:yesterday',
    'owner:is:not-a-uuid',
    'status:after:x',
    'colour:is:red',
    'status:is:',
  ]);
  assert.deepEqual(parsed.map(conditionToParam), ['status:is:qualified', 'status:not:lost', `owner:is:${OWNER}`, 'created:after:2026-09-01']);
  assert.deepEqual(parseConditions(undefined), []);
  assert.equal(parseConditions('status:is:a:b')[0]?.value, 'a:b', 'a value may contain the separator');
  assert.equal(parseConditions(Array.from({ length: 20 }, () => 'status:is:x')).length, 8, 'at most eight conditions');
});

test('clients sharing a name or billing email flag each other, nobody flags themselves', () => {
  const counts = duplicateCounts([
    { id: 'a', name: 'Northwind Retail', billingEmail: null },
    { id: 'b', name: '  northwind   retail ', billingEmail: 'ap@nw.test' },
    { id: 'c', name: 'Different Name', billingEmail: 'AP@nw.test' },
    { id: 'd', name: 'Unrelated', billingEmail: null },
  ]);
  assert.equal(counts.get('a'), 1);
  assert.equal(counts.get('b'), 2);
  assert.equal(counts.get('c'), 1);
  assert.equal(counts.get('d'), 0);
});
