import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { composeLines } from '../src/modules/finance/invoice-composer.ts';
import { invoiceReviewChecklist, maskAccountNumber, taxBreakdown } from '../src/modules/finance/invoice-presentation.ts';
import { crossCheckClaim, filterQueue } from '../src/modules/finance/claim-queue.ts';
import { filterPayments, parsePaymentFilter } from '../src/modules/finance/payment-filters.ts';
import { filterExpenses, projectProfitability } from '../src/modules/finance/project-profitability.ts';
import { formatInvoiceNumber, invoicePrefixFrom, nextInvoiceNumber, parseInvoiceSequence } from '../src/modules/finance/schema.ts';
import { numberingFrom } from '../src/modules/finance/numbering.ts';

describe('the composer arithmetic', () => {
  test('amounts are exact paise and tax follows the rate', () => {
    const r = composeLines([{ description: 'Hosting', quantity: '1.5', unitPrice: '1,000.10' }], 1800);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.lines[0]!.amountMinor, 150015);
    assert.equal(r.totals.taxMinor, Math.floor((150015 * 1800) / 10000));
    assert.equal(r.totals.totalMinor, r.totals.subtotalMinor + r.totals.taxMinor);
  });
  test('bad text is refused with the line named, never coerced', () => {
    const r = composeLines([{ description: '', quantity: '0', unitPrice: '1.005' }], 0);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors.length, 3);
  });
});

describe('how an invoice is shown', () => {
  test('the account number keeps four characters', () => {
    assert.equal(maskAccountNumber('50100234567890'), '••••••••7890');
    assert.equal(maskAccountNumber('1234'), '••••');
  });
  test('GST splits into CGST and SGST in the same state, IGST across states, and says why when it cannot', () => {
    const same = taxBreakdown({ mode: 'gst', subtotalMinor: 100000, taxMinor: 18001, supplierStateCode: '29', placeOfSupplyCode: '29' });
    assert.deepEqual(same.rows.map((r) => r.amountMinor), [9000, 9001]);
    const other = taxBreakdown({ mode: 'gst', subtotalMinor: 100000, taxMinor: 18000, supplierStateCode: '29', placeOfSupplyCode: '27' });
    assert.equal(other.rows[0]!.label, 'IGST @ 18%');
    assert.match(taxBreakdown({ mode: 'gst', subtotalMinor: 100, taxMinor: 18, supplierStateCode: null, placeOfSupplyCode: '27' }).reason, /cannot be split/);
    assert.match(taxBreakdown({ mode: 'non_gst', subtotalMinor: 100, taxMinor: 0, supplierStateCode: '29', placeOfSupplyCode: '27' }).reason, /without GST/);
    assert.match(taxBreakdown({ mode: null, subtotalMinor: 100, taxMinor: 0, supplierStateCode: null, placeOfSupplyCode: null }).reason, /not confirmed/);
  });
  test('the review flags a draft with no due date and a wrong tax', () => {
    const c = invoiceReviewChecklist({ lineCount: 1, totalMinor: 100, subtotalMinor: 100, taxMinor: 0, mode: 'gst', billingComplete: true, dueOn: null, payIntoAccounts: 1, gstRateBp: 1800 });
    assert.deepEqual(c.filter((x) => !x.ok).map((x) => x.key), ['tax', 'due']);
  });
});

describe('numbering is the owner\'s', () => {
  test('a prefix changes the series and restarts it', () => {
    assert.equal(formatInvoiceNumber(2026, 7, 'AG'), 'AG-2026-0007');
    assert.equal(parseInvoiceSequence('INV-2026-0009', 2026, 'AG'), 0);
    assert.equal(nextInvoiceNumber(2026, 0, 0, 'AG'), 'AG-2026-0001');
    assert.equal(nextInvoiceNumber(2026, 7), 'INV-2026-0008');
  });
  test('a malformed stored prefix falls back, never prints', () => {
    assert.equal(invoicePrefixFrom('no-dash'), 'INV');
    assert.equal(invoicePrefixFrom(' ag '), 'AG');
    assert.deepEqual(numberingFrom({ invoice_terms_days: '14', invoice_terms_note: ' Net 14 ' }), { prefix: 'INV', termsDays: 14, termsNote: 'Net 14' });
    assert.equal(numberingFrom({ invoice_terms_days: '999' }).termsDays, null);
  });
});

describe('registers filter the same rows the export writes', () => {
  const p = (over: object) => ({ id: 'p', provider: 'manual', provider_payment_id: 'manual:x', amount_minor: 1, currency: 'INR', status: 'captured', captured_at: '2026-09-10T00:00:00Z', verified_at: null, invoiceId: 'i', invoiceNumber: 'N', clientName: 'Northwind', ...over });
  test('by verification, date and client', () => {
    const rows = [p({ id: 'a', verified_at: '2026-09-11T00:00:00Z' }), p({ id: 'b' }), p({ id: 'c', clientName: 'Other', captured_at: '2026-08-01T00:00:00Z' })];
    const ids = (f: object) => filterPayments(rows as never, parsePaymentFilter(f as never)).map((r) => r.id);
    assert.deepEqual(ids({ verification: 'verified' }), ['a']);
    assert.deepEqual(ids({ verification: 'unverified', from: '2026-09-01' }), ['b']);
    assert.deepEqual(ids({ client: 'other' }), ['c']);
  });
  test('expenses by category, overhead and dates', () => {
    const rows = [{ category: 'ai', projectId: null, vendor: 'Anthropic', incurredOn: '2026-09-01' }, { category: 'tooling', projectId: 'x', vendor: null, incurredOn: '2026-07-01' }];
    assert.equal(filterExpenses(rows, { project: 'none' }).length, 1);
    assert.equal(filterExpenses(rows, { from: '2026-08-01' })[0]!.category, 'ai');
    assert.equal(filterExpenses(rows, { vendor: 'anthro', category: 'ai' }).length, 1);
  });
  test('the claim queue searches by amount in rupees and cross-checks the bank', () => {
    const claims = [{ id: '1', status: 'pending_verification', amountMinor: 1500000, reference: 'UTR99', payerName: null, invoiceNumber: 'INV-1', clientName: 'Acme', projectName: null }];
    assert.equal(filterQueue(claims, { q: '15,000' }).length, 1);
    assert.equal(filterQueue(claims, { q: 'zzz' }).length, 0);
    const line = { id: 'l', statementDate: '2026-09-01', description: 'NEFT UTR99 ACME', reference: null, amountMinor: 1500000, status: 'pending' };
    assert.equal(crossCheckClaim({ reference: 'UTR99', amountMinor: 1500000 }, [line]).kind, 'reference_and_amount');
    assert.equal(crossCheckClaim({ reference: null, amountMinor: 5 }, [line]).kind, 'none');
  });
});

describe('one margin per project, on verified revenue', () => {
  test('margin = verified − expenses − AI − time', () => {
    const [row] = projectProfitability({
      projects: [{ id: 'p', name: 'P', currency: 'INR' }],
      invoices: [{ id: 'i', status: 'partially_paid', currency: 'INR', total_minor: 1000, paid_minor: 1000, verified_minor: 400, project_id: 'p' }],
      costs: new Map([['p', { expensesMinor: 100, aiCostMinor: 50, timeCostMinor: 25, uncostedHours: 0 }]]),
    });
    assert.equal(row!.margin.paidMinor, 400);
    assert.equal(row!.margin.marginMinor, 225);
  });
});
