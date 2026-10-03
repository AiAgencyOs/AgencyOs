import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  invoicesInPeriod,
  profitAndLoss,
  resolveTaxPeriod,
  splitByMode,
  taxRegisterCsv,
} from '../src/modules/finance/tax-report.ts';

// The GST & tax screen (SCR-056) splits the register by the billing mode a
// person CONFIRMED, never by whether tax_minor happens to be non-zero, and its
// CSV carries exactly the rows on screen. These are the arithmetic's promises.

const today = new Date('2026-09-29T00:00:00Z');

const inv = (over: Partial<Parameters<typeof splitByMode>[0][number]>) => ({
  id: 'i', number: 'INV-1', status: 'issued', currency: 'INR',
  subtotalMinor: 100_00, taxMinor: 18_00, totalMinor: 118_00, paidMinor: 0,
  issuedAt: '2026-09-10T00:00:00Z', projectId: null, billingMode: null as 'gst' | 'non_gst' | null, gstin: null,
  ...over,
});

describe('resolveTaxPeriod', () => {
  test('a month, a quarter, an Indian financial year and a range each become a half-open window', () => {
    assert.deepEqual(resolveTaxPeriod('2026-09', today), { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z', label: 'September 2026' });
    assert.deepEqual(resolveTaxPeriod('2026-Q3', today), { from: '2026-07-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z', label: 'Q3 2026' });
    assert.deepEqual(resolveTaxPeriod('FY2026', today), { from: '2026-04-01T00:00:00.000Z', to: '2027-04-01T00:00:00.000Z', label: 'FY 2026–27' });
    assert.equal(resolveTaxPeriod('2026-09-01..2026-09-15', today).to, '2026-09-16T00:00:00.000Z');
  });

  test('anything unparseable falls back to all time and says so', () => {
    for (const raw of [undefined, '', 'all', 'last-week', '2026-13', '2026-Q5']) {
      assert.deepEqual(resolveTaxPeriod(raw, today), { from: null, to: null, label: 'All time' });
    }
  });

  test('an invoice without an issue date is outside every bounded period but inside all time', () => {
    const rows = [inv({ id: 'a', issuedAt: null }), inv({ id: 'b' })];
    assert.deepEqual(invoicesInPeriod(rows, resolveTaxPeriod('2026-09', today)).map((r) => r.id), ['b']);
    assert.equal(invoicesInPeriod(rows, resolveTaxPeriod('all', today)).length, 2);
  });
});

describe('splitByMode', () => {
  test('splits by the confirmed mode, and a project with no confirmed mode is "unconfirmed" even when tax is zero', () => {
    const [split] = splitByMode([
      inv({ id: 'g', billingMode: 'gst' }),
      inv({ id: 'n', billingMode: 'non_gst', taxMinor: 0, totalMinor: 100_00 }),
      inv({ id: 'u', billingMode: null, taxMinor: 0, totalMinor: 100_00 }),
    ]);
    assert.ok(split);
    assert.equal(split.gst.count, 1);
    assert.equal(split.nonGst.count, 1);
    assert.equal(split.unconfirmed.count, 1);
    assert.equal(split.all.tax, 18_00);
    assert.equal(split.all.total, 318_00);
  });

  test('never mixes currencies', () => {
    const splits = splitByMode([inv({ id: 'a' }), inv({ id: 'b', currency: 'USD' })]);
    assert.deepEqual(splits.map((s) => [s.currency, s.all.count]), [['INR', 1], ['USD', 1]]);
  });
});

describe('profitAndLoss', () => {
  test('net is received minus expenses on a cash basis — invoiced is shown but not counted as income', () => {
    const [pnl] = profitAndLoss(
      [inv({ totalMinor: 1000_00 })],
      [{ id: 'r', number: 'RCPT-1', invoiceId: 'i', amountMinor: 400_00, currency: 'INR', issuedAt: '2026-09-11T00:00:00Z' }],
      [
        { id: 'e1', projectId: null, category: 'software', vendor: null, description: 'x', currency: 'INR', amountMinor: 50_00, incurredOn: '2026-09-12', createdAt: '' },
        { id: 'e2', projectId: null, category: 'software', vendor: null, description: 'y', currency: 'INR', amountMinor: 25_00, incurredOn: '2026-09-12', createdAt: '' },
      ],
    );
    assert.ok(pnl);
    assert.equal(pnl.invoiced, 1000_00);
    assert.equal(pnl.received, 400_00);
    assert.equal(pnl.expenses, 75_00);
    assert.equal(pnl.net, 325_00);
    assert.deepEqual(pnl.expensesByCategory, [{ category: 'software', amount: 75_00 }]);
  });
});

describe('taxRegisterCsv', () => {
  test('one header, one row per invoice, major units, and a comma in a number is quoted', () => {
    const csv = taxRegisterCsv([inv({ number: 'INV, odd', billingMode: 'gst', gstin: '29ABCDE1234F1ZW', paidMinor: 118_00 })]);
    const lines = csv.trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], 'Invoice,Status,Issued,Billing mode,GSTIN,Currency,Subtotal,Tax,Total,Verified paid');
    assert.equal(lines[1], '"INV, odd",issued,2026-09-10,GST,29ABCDE1234F1ZW,INR,100.00,18.00,118.00,118.00');
  });
});
