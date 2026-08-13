import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

import type { Role } from '../src/lib/auth/claims.ts';

/**
 * What every finance write does when the invoice cannot be read.
 *
 * Audit finding D6. `loadInvoice` logged and returned `null` when its query
 * errored, and all three writes in finance/service.ts turned that null into
 * `NOT_FOUND` — "Invoice not found." So a database that did not answer was
 * reported to the operator as a fact about the world: the invoice does not
 * exist. It does exist. Nobody could read it.
 *
 * That is the same substitution D3 removed from the payment ledger, one read
 * along, and it is the read that gates every write in the module — issuing,
 * recording a payment, and voiding all begin with it.
 *
 * Why it mattered more than a wrong word. `NOT_FOUND` reads as terminal: an
 * operator told the invoice does not exist stops looking, and a caller that
 * retries on `INTERNAL` will not retry on `NOT_FOUND`. The invoice was there
 * the whole time.
 *
 * `NOT_FOUND` still means the row is genuinely absent — and it still means a
 * row RLS does not admit, deliberately, because telling a caller that a row
 * they may not see nonetheless exists is a leak.
 *
 * Executed, with only the database stubbed. There is no SQL to assert over
 * here and no live section: a PostgREST script cannot make finance.invoices
 * fail for one caller while the rest of the run keeps working.
 */

type ReadOutcome = { data: Record<string, unknown> | null; error: { message: string } | null };

let readOutcome: ReadOutcome = { data: null, error: null };
let rpcOutcome: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let role: Role = 'owner';

const seen = { rpcs: [] as string[], updates: [] as unknown[], audits: 0 };

function readBuilder() {
  const chain = {
    select: (_c?: unknown, options?: { head?: boolean }) =>
      options?.head ? { eq: async () => ({ count: 1, error: null }) } : chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => readOutcome,
    then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
  };
  return chain;
}

const stubClient = {
  schema() {
    return {
      from() {
        return {
          select: () => readBuilder(),
          update(patch: unknown) {
            seen.updates.push(patch);
            return { eq: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }) };
          },
        };
      },
      rpc(fn: string) {
        seen.rpcs.push(fn);
        return { then: (resolve: (v: unknown) => unknown) => resolve(rpcOutcome) };
      },
    };
  },
};

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({
      role,
      userId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
    }),
  },
});
mock.module('@/lib/audit', { exports: { recordAudit: async () => { seen.audits += 1; } } });
mock.module('@/lib/db/server', { exports: { createClient: async () => stubClient } });

const INVOICE_ID = '33333333-3333-4333-8333-333333333333';

const { issueInvoice, recordManualPayment, voidInvoice } = await import(
  '../src/modules/finance/service.ts'
);

/** Every write in the module, and the smallest valid input for each. */
const WRITES = [
  ['issueInvoice', () => issueInvoice({ invoiceId: INVOICE_ID })],
  [
    'recordManualPayment',
    () =>
      recordManualPayment({
        invoiceId: INVOICE_ID,
        amountMinor: 1_000,
        method: 'bank_transfer' as const,
        reference: 'UTR-1',
      }),
  ],
  ['voidInvoice', () => voidInvoice({ invoiceId: INVOICE_ID, reason: 'raised in error' })],
] as const;

beforeEach(() => {
  role = 'owner';
  readOutcome = { data: null, error: null };
  rpcOutcome = { data: null, error: null };
  seen.rpcs = [];
  seen.updates = [];
  seen.audits = 0;
});

describe('A. the invoice cannot be read', () => {
  for (const [name, call] of WRITES) {
    test(`${name} reports the failure, not a missing invoice`, async () => {
      readOutcome = { data: null, error: { message: 'could not connect to server' } };

      const result = await call();

      assert.equal(result.ok, false);
      if (result.ok) return;

      assert.equal(
        result.error.code,
        'INTERNAL',
        'a database that did not answer was reported as an invoice that does not exist',
      );
      assert.notEqual(result.error.code, 'NOT_FOUND');
      // The driver's own words stay out of it.
      assert.doesNotMatch(result.error.message, /could not connect|relation|server/);
    });

    test(`${name} touches nothing when the read fails`, async () => {
      readOutcome = { data: null, error: { message: 'could not connect to server' } };

      await call();

      assert.deepEqual(seen.rpcs, []);
      assert.deepEqual(seen.updates, []);
      assert.equal(seen.audits, 0);
    });
  }
});

describe('B. the invoice is genuinely absent', () => {
  for (const [name, call] of WRITES) {
    test(`${name} still answers NOT_FOUND — the distinction cuts both ways`, async () => {
      // No row, and no error. This is the answer NOT_FOUND is for, and it is
      // also what RLS returns for a row this caller may not see: the same
      // answer on purpose, because confirming a hidden row exists is a leak.
      readOutcome = { data: null, error: null };

      const result = await call();

      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.error.code, 'NOT_FOUND');
      assert.deepEqual(seen.rpcs, []);
    });
  }
});
