import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

import { can } from '../src/lib/authz/permissions.ts';
import type { Role } from '../src/lib/auth/claims.ts';

/**
 * What happens when the payment ledger cannot be read.
 *
 * REVISED BY G-008. When this file was written the invoice total was written
 * by reconcileInvoiceTotals, a second statement that ran after the payment
 * RPC had released its lock — so there were two ledger reads, and the
 * dangerous one was the second. G-008 moved the total into the same statement
 * as the payment insert, under the same lock, and that second read no longer
 * exists.
 *
 * The section that tested it has been rewritten rather than deleted. The
 * property it protected still matters and still holds: a payment must never
 * leave the invoice showing a total nobody computed. It is simply enforced by
 * construction now instead of by a branch, so what is asserted below is that
 * the caller reports the total the locked write produced and refuses when the
 * function does not supply one.
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
 * One now: the cheap advisory check before the RPC. The authoritative sum is
 * taken inside the function, under the lock, and comes back in its result.
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

/**
 * What `finance.record_manual_payment` returns when the receipt landed.
 *
 * `paid_after_minor` and `status_after` are what the function wrote to the
 * invoice inside its own transaction — not a second opinion the caller formed
 * afterwards, which is the whole of G-008. `unlocked_milestone_id` joined them
 * with D17, for the same reason one step along: the function publishes
 * `invoice.paid` in that transaction, so the milestone the event named is the
 * function's answer rather than one the caller looked up after the lock went.
 */
const recorded = {
  data: [
    {
      outcome: 'recorded',
      payment_id: '77777777-7777-4777-8777-777777777777',
      captured_before_minor: 40_000,
      invoice_status: 'partially_paid',
      paid_after_minor: 100_000,
      status_after: 'paid',
      unlocked_milestone_id: '88888888-8888-4888-8888-888888888888',
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
// A. The total comes from the write that made it
//
// This section used to plant a failure on a second ledger read and assert
// that reconcile wrote nothing. There is no second read now — G-008 moved the
// total into the payment's own statement — so what is asserted is the
// property that replaced the branch: the caller reports what the locked write
// produced, and refuses if the function does not tell it.
// ═══════════════════════════════════════════════════════════════════════════

describe('A. the total the locked write produced', () => {
  beforeEach(() => {
    ledgerScript = [captured(40_000)];
  });

  test('the invoice total is never written from the application', async () => {
    await recordManualPayment(payment);

    // The whole of G-008. paid_minor is set inside the same statement that
    // inserted the payment; a second UPDATE from here could only run after
    // that lock was released, which is what let two reconciles disagree.
    assert.deepEqual(
      seen.updates,
      [],
      'the invoice total was written outside the lock that made it true',
    );
  });

  test('the caller reports the total the function wrote, not one it derived', async () => {
    const result = await recordManualPayment(payment);

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.paidMinor, 100_000);
    assert.equal(result.ok === true && result.data.status, 'paid');
    assert.equal(result.ok === true && result.data.fullyPaid, true);
    // One read: the advisory one. The authoritative sum came back in the row.
    assert.equal(seen.ledgerReads, 1);
  });

  test('a recorded payment with no total is an error, not a guess', async () => {
    // Should be unreachable — the function returns both on the recorded path.
    // If it ever stops, the caller must not invent them.
    rpcOutcome = {
      data: [
        {
          outcome: 'recorded',
          payment_id: '77777777-7777-4777-8777-777777777777',
          captured_before_minor: 40_000,
          invoice_status: 'partially_paid',
          paid_after_minor: null,
          status_after: null,
        },
      ],
      error: null,
    };

    const result = await recordManualPayment(payment);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    assert.deepEqual(seen.audits, []);
    assert.deepEqual(seen.events, []);
  });

  test('a partial payment is reported as partial, from the same source', async () => {
    rpcOutcome = {
      data: [
        {
          outcome: 'recorded',
          payment_id: '77777777-7777-4777-8777-777777777777',
          captured_before_minor: 0,
          invoice_status: 'issued',
          paid_after_minor: 60_000,
          status_after: 'partially_paid',
          unlocked_milestone_id: null,
        },
      ],
      error: null,
    };

    const result = await recordManualPayment(payment);

    assert.equal(result.ok === true && result.data.paidMinor, 60_000);
    assert.equal(result.ok === true && result.data.fullyPaid, false);
    // Not fully paid, so no milestone is named — and the function said so
    // rather than the caller deciding after the fact (D17).
    assert.equal(result.ok === true && result.data.unlockedMilestoneId, null);
    assert.deepEqual(seen.events, []);
  });
});

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

// ════════════════════════════════════════════════════════════════════════════
// C. Controls — these hold before and after, and say so
// ════════════════════════════════════════════════════════════════════════════

describe('C. the ledger reads fine', () => {
  beforeEach(() => {
    ledgerScript = [captured(40_000)];
  });

  test('a payment that completes the invoice is audited here and published there', async () => {
    const result = await recordManualPayment(payment);

    assert.equal(result.ok, true);
    assert.equal(seen.audits.length, 1);
    // `payment.recorded` and `invoice.paid` used to be asserted here. Audit
    // finding D17 moved both into finance.record_manual_payment, so they
    // commit with the money rather than in a later transaction that could fail
    // on its own and strand a paid milestone. An emit surviving here would be
    // a second copy of each event, and a second `invoice.paid` is a second
    // unlock job.
    assert.deepEqual(seen.events, []);
  });

  test('the advisory read asks for the captured rows of this invoice, and only those', async () => {
    await recordManualPayment(payment);

    // Without this, dropping the status filter would sum failed and refunded
    // rows and every other assertion here would still pass.
    assert.deepEqual(seen.ledgerFilters[0], [
      ['invoice_id', INVOICE_ID],
      ['status', 'captured'],
    ]);
  });

  test('the audit records the total read under the lock as the before state', async () => {
    await recordManualPayment(payment);

    const [audit] = seen.audits;
    assert.ok(audit, 'the payment was not audited');
    assert.deepEqual(audit.before, { paidMinor: 40_000, status: 'partially_paid' });
  });

  test('an empty ledger is still a legitimate answer, and is not confused with a failure', async () => {
    // The distinction D3 restored, from the other side.
    ledgerScript = [captured()];
    invoiceOutcome = issuedInvoice({ status: 'issued', paid_minor: 0 });
    rpcOutcome = {
      data: [
        {
          outcome: 'recorded',
          payment_id: '77777777-7777-4777-8777-777777777777',
          captured_before_minor: 0,
          invoice_status: 'issued',
          paid_after_minor: 60_000,
          status_after: 'partially_paid',
          unlocked_milestone_id: null,
        },
      ],
      error: null,
    };

    const result = await recordManualPayment(payment);

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.paidMinor, 60_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D. The stub itself
// ════════════════════════════════════════════════════════════════════════════

describe('D. the harness is capable of showing a failure', () => {
  test('the ledger is read exactly once, so section B plants the read that matters', async () => {
    ledgerScript = [captured(40_000)];

    await recordManualPayment(payment);

    // If a refactor reintroduces a second read — an application-side
    // recompute, say — this fails loudly rather than section B quietly
    // planting the wrong one.
    assert.equal(seen.ledgerReads, 1);
  });
});
