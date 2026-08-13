import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { can } from '../src/lib/authz/permissions.ts';
import type { Role } from '../src/lib/auth/claims.ts';

/**
 * G-007 and G-006 — received is not verified.
 *
 * ADM-04, in the Admin's words: a client saying "I paid" is a claim. Somebody
 * records it; the owner or an ops admin confirms it against the bank, and only
 * then is it money. **Only verified money unlocks the next milestone.**
 *
 * Until this, recording did all of it at once — the ledger row, the invoice
 * total, the status, and `invoice.paid`, which opens the next milestone. So a
 * client's claim, typed in by whoever was reading WhatsApp, moved delivery
 * forward on its own.
 *
 * What is asserted here:
 *
 *   A. recording can no longer produce `paid` or `invoice.paid`
 *   B. confirming is what does, under the invoice's lock
 *   C. the two numbers, and why the overpayment ceiling still counts recorded
 *      money rather than confirmed money
 *   D. the caller's four answers
 *   E. who may confirm
 *
 * The end-to-end proof — an invoice that stays unpaid through a full set of
 * recorded receipts and becomes paid on confirmation — is
 * verify-milestone-invoicing.mjs §7f, against real Postgres.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const migration = read('../supabase/migrations/20260813120015_payment_verified.sql');

/** The SQL with comment lines removed, so a comment cannot satisfy an assertion. */
const executable = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

const fn = (signature: string) => {
  const start = executable.indexOf(signature);
  assert.ok(start >= 0, `${signature} is not in the migration`);
  const end = executable.indexOf('$$;', start);
  return executable.slice(start, end);
};

const record = fn('create or replace function finance.record_manual_payment');
const verify = fn('create or replace function finance.verify_payment');

// ═══════════════════════════════════════════════════════════════════════════
// A. Recording is a claim being written down
// ═══════════════════════════════════════════════════════════════════════════

describe('A. recording money no longer settles an invoice', () => {
  test("'paid' is gone from the status the recording path can produce", () => {
    const branch = record.slice(record.indexOf('v_new := case'), record.indexOf('update finance.invoices'));
    assert.doesNotMatch(branch, /'paid'/, 'recording can reach paid again');
    assert.match(branch, /when v_after > 0 then 'partially_paid'/);
  });

  test('and it does not stamp paid_at, because it has not settled anything', () => {
    const update = record.slice(record.indexOf('update finance.invoices'), record.indexOf('core.record_audit'));
    assert.doesNotMatch(update, /paid_at/);
  });

  test('and publishes no invoice.paid', () => {
    // The event that opens the next milestone. This is the finding.
    assert.doesNotMatch(record, /'invoice\.paid'/);
  });

  test('but still publishes payment.recorded, because the money was recorded', () => {
    assert.match(record, /'payment\.recorded'/);
  });

  test('and every refusal it always made is still there', () => {
    // The function D1, D4, D8, G-008, G-079 and D17 landed in. Carried forward
    // from its own latest definition rather than regenerated — the D16 lesson.
    for (const outcome of ['not_found', 'not_payable', 'non_positive', 'overpayment', 'duplicate']) {
      assert.match(record, new RegExp(`'${outcome}'`), `${outcome} was lost in the rewrite`);
    }
    assert.match(record, /for update/, 'the row lock was lost in the rewrite');
    assert.match(record, /core\.record_audit/, 'the audit row was lost in the rewrite');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Confirming is what settles it
// ═══════════════════════════════════════════════════════════════════════════

describe('B. finance.verify_payment', () => {
  test('decides under the invoice row lock', () => {
    // A status read before the lock is one another request can change before
    // the write lands — the shape D1, D2, D4 and D20 all were.
    assert.match(verify, /from finance\.invoices i\s*\n\s*where i\.id = v_invoice\s*\n\s*for update/);
  });

  test('is where the invoice becomes paid', () => {
    assert.match(verify, /when v_after >= v_total then 'paid'/);
    assert.match(verify, /set verified_minor = v_after/);
  });

  test('and where the milestone unlock is published', () => {
    assert.match(verify, /'invoice\.paid'/);
    assert.match(verify, /finance\.next_unlocked_milestone/);
  });

  test('publishing it after the write, so the milestone named is the right one', () => {
    // next_unlocked_milestone answers "the first priced milestone with no paid
    // invoice", which is the milestone being paid for right now until the
    // UPDATE above is visible.
    const update = verify.indexOf('set verified_minor = v_after');
    const derive = verify.indexOf('finance.next_unlocked_milestone');
    assert.ok(update > 0 && derive > update, 'the unlock is derived before the write it depends on');
  });

  test('confirming twice is answered, and writes no second history', () => {
    const already = verify.indexOf("'already_verified'");
    const audit = verify.indexOf('core.record_audit');
    assert.ok(already > 0 && already < audit, 'the second confirmation reaches the audit write');
  });

  test('money that was never captured is not money to confirm', () => {
    assert.match(verify, /if v_pay_status <> 'captured' then/);
  });

  test('the verified total is floored at zero', () => {
    // The refund ceiling is checked against received money, so refunding more
    // than has been confirmed is legal — and makes the verified sum negative.
    // A negative cache would trip invoices_verified_not_over_paid mid-write.
    assert.match(verify, /greatest\(v_before \+ v_amount, 0\)/);
  });

  test('and it audits inside its own transaction (G-079)', () => {
    assert.match(verify, /perform core\.record_audit\(/);
    assert.match(verify, /'payment\.verified'/);
  });

  test('is SECURITY INVOKER and unreachable by anon', () => {
    assert.match(executable, /revoke all on function finance\.verify_payment\(uuid, uuid\) from public, anon;/);
    assert.match(verify, /security invoker/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Two numbers, and which one each rule uses
// ═══════════════════════════════════════════════════════════════════════════

describe('C. recorded and confirmed are different numbers', () => {
  test('verified_minor can never exceed paid_minor', () => {
    assert.match(executable, /check \(verified_minor <= paid_minor\)/);
  });

  test('the overpayment ceiling still counts recorded money', () => {
    // Otherwise ten unconfirmed receipts could be recorded against one
    // invoice, because none of them would count yet. What may not exceed the
    // invoice is what has been claimed.
    assert.match(record, /v_captured \+ p_amount_minor > v_total/);
  });

  test('net_verified_minor counts only confirmed receipts', () => {
    const helper = fn('create or replace function finance.net_verified_minor');
    assert.match(helper, /p\.verified_at is not null/);
    assert.match(helper, /p\.status = 'captured'/);
  });

  test('and subtracts refunds, like its sibling', () => {
    const helper = fn('create or replace function finance.net_verified_minor');
    assert.match(helper, /from finance\.refunds r/);
  });

  test('a confirmation names somebody', () => {
    // A row saying money was confirmed but not by whom is the small lie the
    // audit table exists to prevent.
    assert.match(executable, /verified_at is null or verified_by is not null/);
  });

  test('and history recorded before the rule existed is not rewritten as unverified', () => {
    // Everything recorded before this migration was recorded when recording
    // *was* confirming. Marking it unverified would claim a distinction
    // nobody was offered, and would un-pay every existing invoice.
    assert.match(executable, /update finance\.invoices set verified_minor = paid_minor where paid_minor > 0;/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. The caller
// ═══════════════════════════════════════════════════════════════════════════

const PAYMENT_ID = '55555555-5555-4555-8555-555555555555';

let role: Role = 'owner';
let rpcOutcome: { data: unknown; error: { message: string } | null } = { data: null, error: null };
const seen = { rpcs: [] as [string, unknown][] };

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({
      role,
      userId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
    }),
  },
});

mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema() {
        return {
          rpc(name: string, args: unknown) {
            seen.rpcs.push([name, args]);
            return { then: (resolve: (v: typeof rpcOutcome) => unknown) => resolve(rpcOutcome) };
          },
        };
      },
    }),
  },
});

const { verifyPayment } = await import('../src/modules/finance/service.ts');

beforeEach(() => {
  role = 'owner';
  rpcOutcome = { data: null, error: null };
  seen.rpcs = [];
});

describe('D. verifyPayment answers each outcome differently', () => {
  test('a confirmation reports what the invoice now holds', async () => {
    rpcOutcome = {
      data: [
        {
          outcome: 'verified',
          invoice_id: 'inv-1',
          verified_after_minor: 100_000,
          status_after: 'paid',
          unlocked_milestone_id: 'ms-2',
        },
      ],
      error: null,
    };

    const result = await verifyPayment({ paymentId: PAYMENT_ID });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.fullyPaid, true);
    assert.equal(result.data.unlockedMilestoneId, 'ms-2');
    assert.equal(result.data.changed, true);
  });

  test('and it passes the confirming user, so the row names somebody', async () => {
    rpcOutcome = {
      data: [{ outcome: 'verified', invoice_id: 'inv-1', verified_after_minor: 1, status_after: 'partially_paid', unlocked_milestone_id: null }],
      error: null,
    };

    await verifyPayment({ paymentId: PAYMENT_ID });

    assert.deepEqual(seen.rpcs, [
      ['verify_payment', { p_payment_id: PAYMENT_ID, p_verified_by: '11111111-1111-4111-8111-111111111111' }],
    ]);
  });

  test('a second confirmation succeeds but says nothing changed', async () => {
    // Two people reading the same bank statement should not fight.
    rpcOutcome = {
      data: [{ outcome: 'already_verified', invoice_id: 'inv-1', verified_after_minor: 100_000, status_after: 'paid', unlocked_milestone_id: null }],
      error: null,
    };

    const result = await verifyPayment({ paymentId: PAYMENT_ID });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.changed, false);
    assert.equal(result.data.fullyPaid, true);
  });

  test('a payment that was never captured is a conflict', async () => {
    rpcOutcome = {
      data: [{ outcome: 'not_captured', invoice_id: 'inv-1', verified_after_minor: 0, status_after: 'issued', unlocked_milestone_id: null }],
      error: null,
    };

    const result = await verifyPayment({ paymentId: PAYMENT_ID });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'CONFLICT');
  });

  test('a payment that is not there is NOT_FOUND', async () => {
    rpcOutcome = {
      data: [{ outcome: 'not_found', invoice_id: null, verified_after_minor: null, status_after: null, unlocked_milestone_id: null }],
      error: null,
    };

    const result = await verifyPayment({ paymentId: PAYMENT_ID });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'NOT_FOUND');
  });

  test('a failed call is an error, not a quietly unconfirmed payment', async () => {
    rpcOutcome = { data: null, error: { message: 'could not connect to server' } };

    const result = await verifyPayment({ paymentId: PAYMENT_ID });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
    assert.doesNotMatch(result.error.message, /could not connect|relation|server/);
  });

  test('an empty response is a failed read, not a confirmation — G-054', async () => {
    rpcOutcome = { data: [], error: null };

    const result = await verifyPayment({ paymentId: PAYMENT_ID });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
  });

  test('an outcome nobody recognises is an error', async () => {
    rpcOutcome = { data: [{ outcome: 'banana' }], error: null };

    const result = await verifyPayment({ paymentId: PAYMENT_ID });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Who may confirm
// ═══════════════════════════════════════════════════════════════════════════

describe('E. the capability', () => {
  test('owner and ops admin, exactly as ADM-04 names', () => {
    assert.equal(can('owner', 'invoice.issue'), true);
    assert.equal(can('ops_admin', 'invoice.issue'), true);
    for (const r of ['delivery_lead', 'member', 'contractor', 'client_admin', 'client_member'] as const) {
      assert.equal(can(r, 'invoice.issue'), false, `${r} may confirm payments`);
    }
  });

  test('and a role without it is refused before the database', async () => {
    role = 'delivery_lead';

    const result = await verifyPayment({ paymentId: PAYMENT_ID });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'FORBIDDEN');
    assert.deepEqual(seen.rpcs, []);
  });

  test('it reuses invoice.issue rather than inventing a capability', () => {
    // The set is identical to the one that already records payments, and
    // finance's own rule is that a new capability mapping to an identical role
    // set adds vocabulary without adding control.
    const service = read('../src/modules/finance/service.ts');
    const body = service.slice(service.indexOf('export async function verifyPayment'));
    assert.match(body.slice(0, 800), /can\(context\.role, 'invoice\.issue'\)/);
  });
});
