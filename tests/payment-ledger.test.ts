import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

import { can } from '../src/lib/authz/permissions.ts';
import type { Role } from '../src/lib/auth/claims.ts';

/**
 * What happens when the payment ledger cannot be read.
 *
 * Audit finding D3. `capturedTotal` sums the captured payments behind an
 * invoice, and when that query errored it logged and returned 0. The caller
 * that matters, `reconcileInvoiceTotals`, wrote that 0 straight into
 * `paid_minor`.
 *
 * The consequence was not a stale number. `paid_minor` is written as an
 * absolute, so one transient error erased every receipt an invoice had ever
 * carried; `fullyPaid` came out false, so the status reverted to whatever it
 * had been before the payment and `invoice.paid` was never emitted, so the
 * milestone it gates never opened; and the operator was told "Payment
 * recorded." Nothing in the database refuses that write —
 * `invoices_paid_not_over_total` bounds the cache from above only.
 *
 * And it could not be undone from inside the application. Re-recording the
 * same reference is refused as `duplicate`; recording anything else is refused
 * as `overpayment`, because `finance.record_manual_payment` sums the real rows
 * under a lock and they are — correctly — already full. The UI insists nothing
 * is paid and every repair is refused by a database that knows better.
 *
 * All of that is application branching over a database that returns a row or
 * an error, so all of it is *executed* here with only the database stubbed —
 * the line tests/requirement-decision.test.ts draws and tests/invoice-void.ts
 * follows. There is no structural block in this file and no live section, and
 * that is deliberate: D3 has no SQL to assert over, and a PostgREST script
 * cannot make one table fail while another succeeds. A §7d that pretended
 * otherwise would be a section that cannot fail.
 */

// ── the stubs ──────────────────────────────────────────────────────────────

type Outcome<T> = { data: T | null; error: { message: string } | null };

/** A successful ledger read holding these captured amounts. */
const captured = (...amounts: number[]): Outcome<{ amount_minor: number }[]> => ({
  data: amounts.map((amount_minor) => ({ amount_minor })),
  error: null,
});

/** A ledger read that failed. Not an empty ledger — a ledger that did not answer. */
const unreadable = (): Outcome<{ amount_minor: number }[]> => ({
  data: null,
  error: { message: 'permission denied for relation payments' },
});

/**
 * The ledger reads, in the order the code takes them.
 *
 * `recordManualPayment` reads the ledger twice: once before the RPC as the
 * cheap advisory check, once inside reconcile as the authoritative recompute.
 * Scripting them separately is what lets a test fail exactly one.
 */
let ledgerScript: Outcome<{ amount_minor: number }[]>[] = [];
let invoiceOutcome: Outcome<Record<string, unknown>> = { data: null, error: null };
let rpcOutcome: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let updateOutcome: { error: { message: string } | null } = { error: null };
let role: Role = 'owner';

const seen = {
  ledgerReads: 0,
  ledgerFilters: [] as [string, unknown][][],
  updates: [] as unknown[],
  audits: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
  rpcs: [] as [string, unknown][],
};

/**
 * The ledger read: `.select().eq().eq()`, awaited directly — no `maybeSingle`.
 * `then` is what makes that work; without it the awaited value would be the
 * chain object and every planted outcome would be silently discarded.
 */
function ledgerBuilder() {
  const index = seen.ledgerReads;
  seen.ledgerReads += 1;
  seen.ledgerFilters.push([]);

  const chain = {
    select: () => chain,
    eq(column: string, value: unknown) {
      seen.ledgerFilters[index]?.push([column, value]);
      return chain;
    },
    order() {
      // Nothing in the money path reads the ledger this way. If something
      // starts to, this stub is lying about what it covers.
      throw new Error('ledger stub: unexpected .order() on finance.payments');
    },
    then: (resolve: (value: Outcome<{ amount_minor: number }[]>) => unknown) =>
      resolve(ledgerScript[index] ?? captured()),
  };
  return chain;
}

/** The invoice read: `.select().eq().maybeSingle()`. */
function invoiceReadBuilder() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => invoiceOutcome,
  };
  return chain;
}

function invoiceUpdateBuilder() {
  const chain = {
    eq: () => chain,
    then: (resolve: (value: { error: { message: string } | null }) => unknown) =>
      resolve(updateOutcome),
  };
  return chain;
}

const stubClient = {
  schema() {
    return {
      from(table: string) {
        const ledger = table === 'payments';
        return {
          select: () => (ledger ? ledgerBuilder() : invoiceReadBuilder()),
          update(patch: unknown) {
            seen.updates.push({ table, patch });
            return invoiceUpdateBuilder();
          },
        };
      },
      rpc(fn: string, args: unknown) {
        seen.rpcs.push([fn, args]);
        return {
          then: (resolve: (value: typeof rpcOutcome) => unknown) => resolve(rpcOutcome),
        };
      },
    };
  },
};

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({
      role,
      userId: '11111111-1111-4111-8111-111111111111',
      organizationId: ORGANIZATION_ID,
    }),
  },
});

mock.module('@/lib/audit', {
  exports: {
    recordAudit: async (entry: Record<string, unknown>) => {
      seen.audits.push(entry);
    },
  },
});

mock.module('@/lib/events', {
  exports: {
    emitEvent: async (event: Record<string, unknown>) => {
      seen.events.push(event);
    },
  },
});

mock.module('@/lib/db/server', { exports: { createClient: async () => stubClient } });

const INVOICE_ID = '33333333-3333-4333-8333-333333333333';
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const TOTAL_MINOR = 100_000;

const { recordManualPayment } = await import('../src/modules/finance/service.ts');

/** An issued invoice whose cached paid_minor happens to agree with the ledger. */
function issuedInvoice(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: INVOICE_ID,
      organization_id: ORGANIZATION_ID,
      client_account_id: '44444444-4444-4444-8444-444444444444',
      project_id: null,
      milestone_id: '66666666-6666-4666-8666-666666666666',
      number: 'INV-2026-0007',
      status: 'partially_paid',
      currency: 'INR',
      total_minor: TOTAL_MINOR,
      paid_minor: 40_000,
      notes: null,
      ...overrides,
    },
    error: null,
  };
}

/** What `finance.record_manual_payment` returns when the receipt landed. */
const recorded = {
  data: [
    {
      outcome: 'recorded',
      payment_id: '77777777-7777-4777-8777-777777777777',
      captured_before_minor: 40_000,
      invoice_status: 'partially_paid',
    },
  ],
  error: null,
};

const payment = { invoiceId: INVOICE_ID, amountMinor: 60_000, method: 'bank_transfer' as const, reference: 'UTR-9001' };

beforeEach(() => {
  role = 'owner';
  ledgerScript = [];
  invoiceOutcome = issuedInvoice();
  rpcOutcome = recorded;
  updateOutcome = { error: null };
  seen.ledgerReads = 0;
  seen.ledgerFilters = [];
  seen.updates = [];
  seen.audits = [];
  seen.events = [];
  seen.rpcs = [];
});

// ═══════════════════════════════════════════════════════════════════════════
// 0. The fixture is tied to the real capability model
// ═══════════════════════════════════════════════════════════════════════════

describe('0. the roles these tests rely on', () => {
  test('owner may record payments, member may not — asserted, not assumed', () => {
    assert.equal(can('owner', 'invoice.issue'), true);
    assert.equal(can('member', 'invoice.issue'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A. The reconcile read fails — the payment is already committed
//
// This is D3's damaging path: the RPC has written the payment row, and the
// recompute that follows cannot read the ledger it is meant to recompute from.
// ═══════════════════════════════════════════════════════════════════════════

describe('A. an unreadable ledger after the payment landed', () => {
  beforeEach(() => {
    // First read succeeds (the advisory check), second fails (the recompute).
    ledgerScript = [captured(40_000), unreadable()];
  });

  test('nothing is written to the invoice — a fabricated zero never reaches paid_minor', async () => {
    await recordManualPayment(payment);

    assert.deepEqual(
      seen.updates,
      [],
      'the invoice was written from a ledger that could not be read',
    );
  });

  test('the caller is told it failed, and told which failure it was', async () => {
    const result = await recordManualPayment(payment);

    assert.equal(result.ok, false, 'an unreadable ledger was reported as a successful payment');
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    // The payment really did land; the message must not suggest otherwise.
    assert.match(result.ok === false ? result.error.message : '', /payment was recorded/i);
    // ...and the driver's own words stay out of it.
    assert.doesNotMatch(result.ok === false ? result.error.message : '', /permission denied|relation/);
  });

  test('no audit row claims a paid total nobody could read', async () => {
    await recordManualPayment(payment);

    // The old code audited after.paidMinor = 0 against before.paidMinor = 40000
    // — a permanent, immutable row contradicting itself, since audit.audit_log
    // refuses UPDATE and DELETE.
    assert.deepEqual(seen.audits, []);
  });

  test('no payment.recorded and no invoice.paid is published', async () => {
    await recordManualPayment(payment);

    assert.deepEqual(seen.events, []);
  });

  test('the payment itself was still attempted — this is a reconcile failure, not a refusal', async () => {
    await recordManualPayment(payment);

    assert.equal(seen.rpcs.length, 1);
    assert.equal(seen.rpcs[0]?.[0], 'record_manual_payment');
    assert.equal(seen.ledgerReads, 2, 'the recompute read is the one that must fail here');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The advisory read fails — before anything is committed
// ═══════════════════════════════════════════════════════════════════════════

describe('B. an unreadable ledger before the payment is attempted', () => {
  beforeEach(() => {
    ledgerScript = [unreadable()];
  });

  test('the payment is not attempted at all', async () => {
    const result = await recordManualPayment(payment);

    assert.equal(result.ok, false);
    // Refusing here is what keeps the caller out of the state section A
    // describes: money committed, cache un-updatable, no way back.
    assert.deepEqual(seen.rpcs, []);
    assert.equal(seen.ledgerReads, 1, 'the advisory read is the only one that should happen');
    assert.deepEqual(seen.updates, []);
    assert.deepEqual(seen.audits, []);
    assert.deepEqual(seen.events, []);
  });

  test('and the operator is told the truth: nothing was recorded', async () => {
    const result = await recordManualPayment(payment);

    // Narrowed first, so every assertion below is reached on a real error
    // rather than short-circuiting to a falsy left operand.
    assert.equal(result.ok, false, 'an unreadable ledger was reported as a successful payment');
    if (result.ok) return;

    // The old code called an unreadable ledger zero, which made the check
    // permissive rather than wrong — but a caller reading the answer could not
    // tell a dead database from a clean invoice.
    assert.equal(result.error.code, 'INTERNAL');
    assert.notEqual(result.error.code, 'VALIDATION');
    assert.notEqual(result.error.code, 'CONFLICT');
    // Section A's message says the payment WAS recorded. Here it was not, and
    // borrowing that sentence would send the operator hunting for money that
    // never moved.
    assert.doesNotMatch(result.error.message, /payment was recorded/i);
    assert.match(result.error.message, /could not be read/i);
    assert.doesNotMatch(result.error.message, /permission denied|relation/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Controls — these pass before and after, and say so
// ═══════════════════════════════════════════════════════════════════════════

describe('C. the ledger reads fine', () => {
  test('a payment that completes the invoice is stored, audited and published', async () => {
    ledgerScript = [captured(40_000), captured(40_000, 60_000)];

    const result = await recordManualPayment(payment);

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.paidMinor, TOTAL_MINOR);
    assert.equal(result.ok === true && result.data.fullyPaid, true);
    assert.equal(result.ok === true && result.data.status, 'paid');

    // The number that reaches the column, not just the fact that a write
    // happened — D3 is about the wrong number getting there.
    assert.equal(seen.updates.length, 1);
    const [write] = seen.updates as { table: string; patch: Record<string, unknown> }[];
    assert.ok(write, 'the invoice was never written');
    assert.equal(write.table, 'invoices');
    assert.equal(write.patch.paid_minor, TOTAL_MINOR);
    assert.equal(write.patch.status, 'paid');
    assert.equal(typeof write.patch.paid_at, 'string', 'paid is a moment, not just a flag');

    assert.equal(seen.audits.length, 1);
    assert.deepEqual(
      seen.events.map((e) => e.type),
      ['payment.recorded', 'invoice.paid'],
    );
    assert.equal(seen.ledgerReads, 2);
  });

  test('the recompute reads the captured rows for this invoice, and only those', async () => {
    ledgerScript = [captured(40_000), captured(40_000, 60_000)];

    await recordManualPayment(payment);

    // Without this, a change that dropped the status filter would sum failed
    // and refunded rows and every other assertion here would still pass.
    assert.deepEqual(seen.ledgerFilters[1], [
      ['invoice_id', INVOICE_ID],
      ['status', 'captured'],
    ]);
  });

  test('the audit records the total read under the lock, not the one read before it', async () => {
    // The two candidates are deliberately different numbers. A receipt landed
    // between this caller's advisory read and the lock, so the pre-read says
    // 30_000 and the locked read says 40_000 — and only one of those is the
    // state the payment actually applied to.
    ledgerScript = [captured(30_000), captured(40_000, 60_000)];

    await recordManualPayment(payment);

    const [audit] = seen.audits;
    assert.ok(audit, 'the payment was not audited');
    assert.deepEqual(audit.before, { paidMinor: 40_000, status: 'partially_paid' });
  });

  test('a failed WRITE is refused the same way a failed read now is', async () => {
    // This path already behaved correctly. It is asserted so the precedent
    // section A follows cannot quietly disappear under a later refactor.
    ledgerScript = [captured(40_000), captured(40_000, 60_000)];
    updateOutcome = { error: { message: 'deadlock detected' } };

    const result = await recordManualPayment(payment);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    assert.deepEqual(seen.audits, []);
    assert.deepEqual(seen.events, []);
  });

  test('an empty ledger is still a legitimate answer, and is not confused with a failure', async () => {
    // The distinction the fix exists to draw, from the other side.
    ledgerScript = [captured(), captured(60_000)];
    invoiceOutcome = issuedInvoice({ status: 'issued', paid_minor: 0 });
    rpcOutcome = {
      data: [
        {
          outcome: 'recorded',
          payment_id: '77777777-7777-4777-8777-777777777777',
          captured_before_minor: 0,
          invoice_status: 'issued',
        },
      ],
      error: null,
    };

    const result = await recordManualPayment(payment);

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.paidMinor, 60_000);
    assert.equal(result.ok === true && result.data.fullyPaid, false);

    const [write] = seen.updates as { patch: Record<string, unknown> }[];
    assert.ok(write, 'the invoice was never written');
    assert.equal(write.patch.paid_minor, 60_000);
    assert.equal(write.patch.status, 'partially_paid');
    // Not fully paid, so no moment of payment is claimed.
    assert.equal('paid_at' in write.patch, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. The stub itself
// ═══════════════════════════════════════════════════════════════════════════

describe('D. the harness is capable of showing a failure', () => {
  test('the ledger stub is consumed twice on the happy path, so a script of two is meaningful', async () => {
    ledgerScript = [captured(40_000), captured(40_000, 60_000)];

    await recordManualPayment(payment);

    // If a later refactor derives the paid total from the RPC's own
    // captured_before_minor instead of re-reading, this drops to 1 and every
    // test above starts failing for a reason unrelated to D3. This assertion
    // is what makes that one loud failure instead of five confusing ones.
    assert.equal(seen.ledgerReads, 2);
  });
});
