import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * Owner decision 8 of 2026-10-01: the client-facing invoice PDF's "Paid /
 * Balance due" uses VERIFIED payments only. The real service runs here with the
 * database, the session and the renderer stubbed; what is asserted is the
 * amount handed to the renderer as `paidMinor`, and that the client's name is
 * read through the name-only door (decision 7), not from core.client_accounts.
 */

const ORG = '22222222-2222-4222-8222-222222222222';
const INVOICE = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';

let invoiceRow: Record<string, unknown>;
const rendered: Record<string, unknown>[] = [];
const rpcs: { fn: string; args: unknown }[] = [];
const coreReads: string[] = [];

const done = <T,>(v: T) => ({ then: (r: (x: T) => unknown) => r(v) });

const stub = {
  schema(name: string) {
    return {
      from(table: string) {
        if (name === 'core') coreReads.push(table);
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          order: () => done({ data: [{ description: 'Build', quantity: 1, unit_price_minor: 500000, amount_minor: 500000, tax_rate_bp: 0 }], error: null }),
          limit: () => chain,
          maybeSingle: async () =>
            table === 'invoices'
              ? { data: invoiceRow, error: null }
              : table === 'organizations'
                ? { data: { name: 'Demo Agency', timezone: 'Asia/Kolkata', settings: {} }, error: null }
                : { data: null, error: null },
        };
        return chain;
      },
      rpc(fn: string, args: unknown) {
        rpcs.push({ fn, args });
        return done({ data: [{ id: CLIENT, name: 'Northwind Retail' }], error: null });
      },
    };
  },
};

mock.module('@/lib/auth/session', { exports: { requireInternal: async () => ({ role: 'finance', userId: 'u', organizationId: ORG }) } });
mock.module('@/lib/db/server', { exports: { createClient: async () => stub } });
mock.module('@/modules/finance/queries', { exports: { listPaymentAccounts: async () => [], readInvoiceBillingProfile: async () => null } });
mock.module('@/lib/pdf/invoice', {
  exports: {
    renderInvoicePdf: async (input: Record<string, unknown>) => {
      rendered.push(input);
      return { bytes: new Uint8Array([1]) };
    },
    invoicePdfFilename: () => 'invoice.pdf',
  },
});
mock.module('@/lib/pdf/quotation', { exports: { quotationContactLine: () => null } });

const { invoicePdfForInvoice } = await import('../src/modules/finance/pdf-service.ts');

const invoice = (over: Record<string, unknown>) => ({
  id: INVOICE, number: 'INV-2026-0001', status: 'partially_paid', currency: 'INR', subtotal_minor: 500000, tax_minor: 0, total_minor: 500000,
  paid_minor: 500000, verified_minor: 250000, issued_at: '2026-09-29T00:00:00Z', due_at: null, paid_at: null, created_at: '2026-09-29T00:00:00Z',
  notes: null, client_account_id: CLIENT, project_id: null, milestone_id: null, ...over,
});

beforeEach(() => {
  rendered.length = 0;
  rpcs.length = 0;
  coreReads.length = 0;
});

describe('the client-facing invoice PDF', () => {
  test('"Paid" is what was verified, not what was recorded', async () => {
    invoiceRow = invoice({});
    const r = await invoicePdfForInvoice(INVOICE);
    assert.equal(r.ok, true);
    assert.equal(rendered[0]!.paidMinor, 250000, 'recorded 5,000.00 but only 2,500.00 verified');
    assert.equal(rendered[0]!.totalMinor, 500000);
  });

  test('money recorded but not verified at all prints no Paid line', async () => {
    invoiceRow = invoice({ paid_minor: 299996, verified_minor: 0, total_minor: 299999 });
    await invoicePdfForInvoice(INVOICE);
    assert.equal(rendered[0]!.paidMinor, 0);
  });

  test('a verified total can never print above the invoice total', async () => {
    invoiceRow = invoice({ verified_minor: 900000 });
    await invoicePdfForInvoice(INVOICE);
    assert.equal(rendered[0]!.paidMinor, 500000);
  });

  test('the client’s name comes through the name-only door, never from core.client_accounts', async () => {
    invoiceRow = invoice({});
    await invoicePdfForInvoice(INVOICE);
    assert.deepEqual(rpcs, [{ fn: 'client_names', args: { p_ids: [CLIENT] } }]);
    assert.equal(coreReads.includes('client_accounts'), false);
    assert.equal((rendered[0]!.billedTo as { clientName: string }).clientName, 'Northwind Retail');
  });
});
