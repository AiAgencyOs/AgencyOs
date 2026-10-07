// P1-BLUEPRINT-018: the quotation version comparison is a pure function of two versions.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareProposals, type DiffProposal } from '../src/modules/sales/proposal-diff.ts';

const base: DiffProposal = {
  version: 1,
  title: 'Website',
  status: 'superseded',
  currency: 'INR',
  subtotal_minor: 100000,
  discount_minor: 0,
  tax_minor: 18000,
  total_minor: 118000,
  valid_until: '2026-12-31',
  plan_label: null,
  body: 'v1 wording',
  items: [
    { description: 'Design', quantity: 1, unit_price_minor: 60000, amount_minor: 60000 },
    { description: 'Build', quantity: 1, unit_price_minor: 40000, amount_minor: 40000 },
  ],
};

test('two identical versions are identical, not "changed"', () => {
  const r = compareProposals(base, { ...base, version: 2 });
  assert.equal(r.identical, true);
  assert.deepEqual(r.fields, []);
  assert.deepEqual(r.items, []);
});

test('money is compared in minor units and reported per field', () => {
  const r = compareProposals(base, { ...base, version: 2, discount_minor: 5000, total_minor: 113000, subtotal_minor: 95000 });
  assert.deepEqual(r.fields.map((f) => f.field).sort(), ['discount_minor', 'subtotal_minor', 'total_minor']);
  const total = r.fields.find((f) => f.field === 'total_minor');
  assert.deepEqual([total?.from, total?.to, total?.kind], [118000, 113000, 'money']);
});

test('a re-ordered or re-spaced line is not removed-and-added', () => {
  const r = compareProposals(base, { ...base, version: 2, items: [{ ...base.items[1]!, description: '  build ' }, base.items[0]!] });
  assert.deepEqual(r.items, []);
});

test('added, removed and changed lines are told apart, with what changed', () => {
  const r = compareProposals(base, {
    ...base,
    version: 2,
    items: [
      { description: 'Design', quantity: 2, unit_price_minor: 60000, amount_minor: 120000 },
      { description: 'Hosting', quantity: 1, unit_price_minor: 12000, amount_minor: 12000 },
    ],
  });
  const byType = (t: string) => r.items.filter((i) => i.type === t);
  assert.equal(byType('removed').length, 1);
  assert.equal(byType('removed')[0]?.description, 'Build');
  assert.equal(byType('added')[0]?.description, 'Hosting');
  const changed = byType('changed')[0];
  assert.ok(changed && changed.type === 'changed');
  assert.deepEqual(changed.what, ['quantity', 'amount']);
});

test('duplicate descriptions are matched in order', () => {
  const one = { description: 'Support', quantity: 1, unit_price_minor: 1000, amount_minor: 1000 };
  const r = compareProposals({ ...base, items: [one, one] }, { ...base, version: 2, items: [one] });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]?.type, 'removed');
});

test('a currency change is flagged so a reader does not compare 1000 INR to 1000 USD', () => {
  const r = compareProposals(base, { ...base, version: 2, currency: 'USD' });
  assert.equal(r.currencyChanged, true);
});
