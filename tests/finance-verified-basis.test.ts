import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  basisDisagreements,
  financeBasis,
  principalCurrency,
  receivedByProject,
  verifiedByMonth,
  type BasisInvoice,
  type BasisPayment,
} from '../src/modules/finance/verified-basis.ts';

/**
 * The books the seed carried: ₹21,000 "received" on invoices' paid amount,
 * ₹7,500 actually verified. One basis: the verified amount.
 */
const inv = (over: Partial<BasisInvoice> & { id: string }): BasisInvoice => ({
  status: 'issued',
  currency: 'INR',
  total_minor: 100_000,
  paid_minor: 0,
  verified_minor: 0,
  project_id: null,
  ...over,
});

const pay = (over: Partial<BasisPayment> & { invoiceId: string }): BasisPayment => ({
  currency: 'INR',
  amount_minor: 100,
  status: 'captured',
  captured_at: '2026-09-10T10:00:00Z',
  verified_at: '2026-09-11T10:00:00Z',
  ...over,
});

describe('financeBasis — every total on the verified basis', () => {
  const invoices = [
    inv({ id: 'a', status: 'paid', total_minor: 500_000, paid_minor: 500_000, verified_minor: 500_000, project_id: 'p1' }),
    inv({ id: 'b', status: 'partially_paid', total_minor: 500_000, paid_minor: 500_000, verified_minor: 250_000, project_id: 'p1' }),
    inv({ id: 'c', status: 'partially_paid', total_minor: 600_000, paid_minor: 600_000, verified_minor: 0 }),
    inv({ id: 'd', status: 'overdue', total_minor: 1_000_000, project_id: 'p2' }),
    inv({ id: 'e', status: 'void', total_minor: 999_999, paid_minor: 0 }),
    inv({ id: 'f', status: 'draft', total_minor: 700_000 }),
  ];
  const basis = financeBasis({ invoices, expenses: [{ currency: 'INR', amountMinor: 480_000 }], currency: 'INR' });

  test('received counts verified money only, not the recorded amount', () => {
    assert.equal(basis.receivedMinor, 750_000);
  });

  test('money recorded but not verified is reported beside the figure, never inside it', () => {
    assert.equal(basis.awaitingVerificationMinor, 250_000 + 600_000);
  });

  test('outstanding is invoiced less received; drafts and voids are not bills', () => {
    assert.equal(basis.invoicedMinor, 500_000 + 500_000 + 600_000 + 1_000_000);
    assert.equal(basis.outstandingMinor, basis.invoicedMinor - 750_000);
  });

  test('net is received less expenses, and margin is net over received', () => {
    assert.equal(basis.netMinor, 750_000 - 480_000);
    assert.equal(basis.marginPercent, 36);
  });

  test('collection rate and overdue follow the same basis', () => {
    assert.equal(basis.collectionPercent, Math.round((750_000 / 2_600_000) * 100));
    assert.equal(basis.overdueInvoiceCount, 1);
    assert.equal(basis.overdueMinor, 1_000_000);
    assert.equal(basis.pendingInvoiceCount, 3);
  });

  test('another currency is never summed into the principal one', () => {
    const mixed = [...invoices, inv({ id: 'usd', currency: 'USD', total_minor: 9_000_000, verified_minor: 9_000_000, status: 'paid' })];
    assert.equal(financeBasis({ invoices: mixed, expenses: [], currency: 'INR' }).receivedMinor, 750_000);
    assert.equal(principalCurrency(mixed), 'USD');
  });

  test('nothing invoiced means no rate, not a zero rate', () => {
    const empty = financeBasis({ invoices: [], expenses: [], currency: 'INR' });
    assert.equal(empty.collectionPercent, null);
    assert.equal(empty.marginPercent, null);
  });
});

describe('where the verified money went', () => {
  test('by project, with unassigned invoices pooled rather than lost', () => {
    const invoices = [
      inv({ id: 'a', status: 'paid', total_minor: 500_000, verified_minor: 500_000, project_id: 'p1' }),
      inv({ id: 'b', status: 'paid', total_minor: 200_000, verified_minor: 200_000 }),
      inv({ id: 'c', status: 'issued', total_minor: 900_000, verified_minor: 0, project_id: 'p2' }),
    ];
    const by = receivedByProject(invoices, 'INR');
    assert.equal(by.get('p1'), 500_000);
    assert.equal(by.get(null), 200_000);
    assert.equal(by.has('p2'), false);
  });

  test('by month from the day somebody verified, never from when it was captured', () => {
    const payments = [
      pay({ invoiceId: 'a', amount_minor: 300, captured_at: '2026-08-30T10:00:00Z', verified_at: '2026-09-02T10:00:00Z' }),
      pay({ invoiceId: 'a', amount_minor: 200, verified_at: null }),
      pay({ invoiceId: 'a', amount_minor: 50, status: 'refunded' }),
    ];
    const by = verifiedByMonth(payments, 'INR', (iso) => iso.slice(0, 7));
    assert.deepEqual([...by.entries()], [['2026-09', 300]]);
  });
});

describe('basisDisagreements — a stored amount no payment backs is named', () => {
  test('a paid amount with no payment row, and a verified amount above its payments', () => {
    const invoices = [
      inv({ id: 'ok', status: 'paid', paid_minor: 100, verified_minor: 100 }),
      inv({ id: 'ghost', status: 'partially_paid', paid_minor: 299_996 }),
      inv({ id: 'inflated', status: 'partially_paid', paid_minor: 500, verified_minor: 500 }),
      inv({ id: 'void', status: 'void', paid_minor: 5 }),
    ];
    const payments = [pay({ invoiceId: 'ok', amount_minor: 100 }), pay({ invoiceId: 'inflated', amount_minor: 200 })];
    const found = basisDisagreements(invoices, payments);
    assert.deepEqual(found.map((d) => [d.invoiceId, d.kind]).sort(), [
      ['ghost', 'paid_without_payment'],
      ['inflated', 'verified_without_payment'],
    ]);
  });
});
