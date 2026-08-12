import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { can } from '../src/lib/authz/permissions.ts';
import type { Role } from '../src/lib/auth/claims.ts';
import { INVOICE_TRANSITIONS, type InvoiceStatus } from '../src/modules/finance/schema.ts';

/**
 * Withdrawing an invoice, executed.
 *
 * Audit finding D2. `voidInvoice` read the invoice, refused if `paid_minor`
 * was above zero, and then wrote `status = 'void'` with the invoice's id as its
 * only predicate. A payment committing between the read and the write was
 * neither seen by the check nor excluded by the write, so the invoice ended
 * void while holding captured money — and because
 * `invoices_milestone_live_key` excludes void rows, the milestone the client
 * had just paid for became billable again.
 *
 * The decision now happens inside `finance.void_invoice`, under a lock on the
 * invoice, against the payment rows rather than the cached sum of them. That
 * splits the property into two halves, and they are tested in two different
 * ways on purpose:
 *
 *   the branching — which of five answers the caller gets, what is written,
 *   and what is audited — is application code, so it is *executed* here with
 *   only the database stubbed. This is the line tests/requirement-decision.ts
 *   draws, for the reason its header gives: a regex over a function body
 *   cannot fail when the function stops doing what the text says.
 *
 *   the lock cannot be executed from here at all — a stub has no transactions
 *   to interleave — so its presence and its position before the sum it
 *   protects are asserted structurally at the bottom of this file, as D1's
 *   were. Unlike D1's, the lock is *also* caught live:
 *   scripts/verify-milestone-invoicing.mjs §7c check Q fails when FOR UPDATE
 *   is deleted, because there a void races a payment rather than racing
 *   another copy of itself. The structural block is the cheap guard that runs
 *   in `npm run check`; §7c is the one that proves it.
 *
 * Deliberately not simulated: RLS, the real lock, and the interleaving itself.
 * A fake that reimplements those would prove only that the fake agrees with
 * itself. They belong to scripts/verify-milestone-invoicing.mjs §7c.
 */

// ── the stubs ──────────────────────────────────────────────────────────────

type ReadOutcome = { data: Record<string, unknown> | null; error: { message: string } | null };
type RpcOutcome = { data: unknown; error: { message: string } | null };

/** What the stubbed database answers, per test. */
let readOutcome: ReadOutcome = { data: null, error: null };
let rpcOutcome: RpcOutcome = { data: null, error: null };
/**
 * What a bare `.update()` would answer.
 *
 * Nothing in the fixed function calls it. It is left reachable and successful
 * so that the pre-fix implementation — which voided with an unguarded UPDATE —
 * runs to completion against this stub and fails these tests on its *answers*
 * rather than on a missing stub method.
 */
let updateOutcome: { error: { message: string } | null } = { error: null };
let role: Role = 'owner';

const seen = {
  clientsOpened: 0,
  schemas: [] as string[],
  tables: [] as string[],
  updates: [] as unknown[],
  updateFilters: [] as [string, unknown][],
  readFilters: [] as [string, unknown][],
  rpcs: [] as [string, unknown][],
  audits: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
};

/**
 * A recorder shaped like the query builder, not a reimplementation of one.
 *
 * `then` is what makes it usable: both the RPC call and the old unguarded
 * UPDATE are awaited directly rather than terminated with `.maybeSingle()`, so
 * a recorder without it would swallow whatever the test planted and every
 * assertion would pass against every implementation.
 */
function readBuilder() {
  const chain = {
    select: () => chain,
    eq(column: string, value: unknown) {
      seen.readFilters.push([column, value]);
      return chain;
    },
    maybeSingle: async () => readOutcome,
  };
  return chain;
}

function updateBuilder() {
  const chain = {
    eq(column: string, value: unknown) {
      seen.updateFilters.push([column, value]);
      return chain;
    },
    then: (resolve: (value: { error: { message: string } | null }) => unknown) =>
      resolve(updateOutcome),
  };
  return chain;
}

const stubClient = {
  schema(name: string) {
    seen.schemas.push(name);
    return {
      from(table: string) {
        seen.tables.push(table);
        return {
          select: () => readBuilder(),
          update(patch: unknown) {
            seen.updates.push(patch);
            return updateBuilder();
          },
        };
      },
      rpc(fn: string, args: unknown) {
        seen.rpcs.push([fn, args]);
        return {
          then: (resolve: (value: RpcOutcome) => unknown) => resolve(rpcOutcome),
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

mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => {
      seen.clientsOpened += 1;
      return stubClient;
    },
  },
});

const INVOICE_ID = '33333333-3333-4333-8333-333333333333';
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';

// Imported after the mocks are registered, so the real module resolves to them.
const { voidInvoice } = await import('../src/modules/finance/service.ts');

/** An invoice the pre-lock checks let through: issued, nothing paid. */
function issuedInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    organization_id: ORGANIZATION_ID,
    client_account_id: '44444444-4444-4444-8444-444444444444',
    project_id: '55555555-5555-4555-8555-555555555555',
    milestone_id: '66666666-6666-4666-8666-666666666666',
    number: 'INV-2026-0007',
    status: 'issued',
    currency: 'INR',
    total_minor: 100_000,
    paid_minor: 0,
    notes: null,
    ...overrides,
  };
}

/** What `finance.void_invoice` returns, as PostgREST delivers it. */
function settles(
  outcome: string,
  invoiceStatus: string | null = 'issued',
  capturedMinor: number | null = null,
) {
  return {
    data: [{ outcome, invoice_status: invoiceStatus, captured_minor: capturedMinor }],
    error: null,
  };
}

beforeEach(() => {
  role = 'owner';
  readOutcome = { data: null, error: null };
  rpcOutcome = { data: null, error: null };
  updateOutcome = { error: null };
  seen.clientsOpened = 0;
  seen.schemas = [];
  seen.tables = [];
  seen.updates = [];
  seen.updateFilters = [];
  seen.readFilters = [];
  seen.rpcs = [];
  seen.audits = [];
  seen.events = [];
});

// ═══════════════════════════════════════════════════════════════════════════
// The fixtures are tied to the real capability model
// ═══════════════════════════════════════════════════════════════════════════

describe('0. the roles these tests rely on', () => {
  test('owner may void, member may not — asserted, not assumed', () => {
    assert.equal(can('owner', 'invoice.issue'), true);
    assert.equal(can('member', 'invoice.issue'), false);
  });

  test('the statuses a void may leave are exactly the ones the SQL restates', () => {
    const voidable = (Object.keys(INVOICE_TRANSITIONS) as InvoiceStatus[]).filter((status) =>
      INVOICE_TRANSITIONS[status].includes('void'),
    );
    assert.deepEqual(voidable.slice().sort(), [
      'draft',
      'issued',
      'overdue',
      'partially_paid',
      'pending_approval',
    ]);
    // 'paid' is the one that is missing, and it is missing on purpose.
    assert.equal(INVOICE_TRANSITIONS.paid.includes('void'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A. A void that must not land
//
// Every test here plants an answer from the locked read and asserts what the
// real function did with it. Against the pre-fix implementation the plant is
// never consulted — it wrote unconditionally — so each of these fails.
// ═══════════════════════════════════════════════════════════════════════════

describe('A. a void that must not land', () => {
  test('a role without invoice.issue is refused before the database is opened', async () => {
    role = 'member';
    readOutcome = { data: issuedInvoice(), error: null };

    const result = await voidInvoice({ invoiceId: INVOICE_ID, reason: 'wrong plan' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'FORBIDDEN');
    assert.equal(seen.clientsOpened, 0);
    assert.deepEqual(seen.rpcs, []);
    assert.deepEqual(seen.audits, []);
  });

  test('a payment that landed under the lock refuses the void', async () => {
    // The state D2 produces: the invoice the caller read said nothing was
    // paid, and by the time the lock was taken a receipt had been recorded.
    readOutcome = { data: issuedInvoice(), error: null };
    rpcOutcome = settles('has_payments', 'partially_paid', 40_000);

    const result = await voidInvoice({ invoiceId: INVOICE_ID, reason: 'client changed scope' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    assert.match(
      result.ok === false ? result.error.message : '',
      /payments recorded against it/,
    );
  });

  test('and it writes nothing, audits nothing, and emits nothing', async () => {
    readOutcome = { data: issuedInvoice(), error: null };
    rpcOutcome = settles('has_payments', 'partially_paid', 40_000);

    await voidInvoice({ invoiceId: INVOICE_ID, reason: 'client changed scope' });

    // An invoice.voided audit row is immutable and its event is unretractable.
    // Neither may describe a void that did not happen.
    assert.deepEqual(seen.audits, []);
    assert.deepEqual(seen.events, []);
    assert.deepEqual(seen.updates, []);
  });

  test('a stale cached paid_minor still refuses before the lock is reached', async () => {
    // The cheap answer for the caller that is alone. It is kept, but it is no
    // longer the only guard — which is the point of the test above.
    readOutcome = { data: issuedInvoice({ paid_minor: 40_000 }), error: null };

    const result = await voidInvoice({ invoiceId: INVOICE_ID, reason: 'raised in error' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    assert.deepEqual(seen.rpcs, []);
  });

  test('an invoice that cannot be voided is refused with the status the lock saw', async () => {
    readOutcome = { data: issuedInvoice(), error: null };
    rpcOutcome = settles('not_voidable', 'paid');

    const result = await voidInvoice({ invoiceId: INVOICE_ID, reason: 'raised in error' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    // 'paid', not the 'issued' the caller read a moment earlier.
    assert.match(result.ok === false ? result.error.message : '', /is paid cannot be voided/);
    assert.deepEqual(seen.audits, []);
  });

  test('an invoice that vanished under the lock is NOT_FOUND, not a silent success', async () => {
    readOutcome = { data: issuedInvoice(), error: null };
    rpcOutcome = settles('not_found', null);

    const result = await voidInvoice({ invoiceId: INVOICE_ID, reason: 'raised in error' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_FOUND');
    assert.deepEqual(seen.events, []);
  });

  test('a driver failure is reported, never swallowed into a success', async () => {
    readOutcome = { data: issuedInvoice(), error: null };
    rpcOutcome = { data: null, error: { message: 'permission denied for table invoices' } };

    const result = await voidInvoice({ invoiceId: INVOICE_ID, reason: 'raised in error' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    // The driver's own words do not reach the operator.
    assert.doesNotMatch(
      result.ok === false ? result.error.message : '',
      /permission denied|relation|invoices/,
    );
    assert.deepEqual(seen.audits, []);
  });

  test('an outcome nobody recognises is an error, not a void', async () => {
    readOutcome = { data: issuedInvoice(), error: null };
    rpcOutcome = settles('banana', 'issued');

    const result = await voidInvoice({ invoiceId: INVOICE_ID, reason: 'raised in error' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    assert.deepEqual(seen.audits, []);
    assert.deepEqual(seen.events, []);
  });

  test('an empty response is an error, not a void', async () => {
    readOutcome = { data: issuedInvoice(), error: null };
    rpcOutcome = { data: [], error: null };

    const result = await voidInvoice({ invoiceId: INVOICE_ID, reason: 'raised in error' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    assert.deepEqual(seen.audits, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The void that does land
// ═══════════════════════════════════════════════════════════════════════════

describe('B. a void that lands', () => {
  test('it goes through the serialised function, not a bare update', async () => {
    readOutcome = { data: issuedInvoice(), error: null };
    rpcOutcome = settles('voided', 'issued', 0);

    const result = await voidInvoice({ invoiceId: INVOICE_ID, reason: 'duplicate of INV-2026-0006' });

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.status, 'void');
    assert.deepEqual(seen.rpcs, [
      ['void_invoice', { p_invoice_id: INVOICE_ID, p_note: 'Voided: duplicate of INV-2026-0006' }],
    ]);
    // The unguarded write is what the finding was about. It is gone.
    assert.deepEqual(seen.updates, []);
    assert.deepEqual(seen.updateFilters, []);
  });

  test('the reason travels as the note; the concatenation is left to the locked row', async () => {
    readOutcome = { data: issuedInvoice({ notes: 'raised early at the client request' }), error: null };
    rpcOutcome = settles('voided', 'issued', 0);

    await voidInvoice({ invoiceId: INVOICE_ID, reason: 'wrong milestone' });

    const [call] = seen.rpcs;
    assert.ok(call, 'the serialised function was never called');
    const { p_note: note } = call[1] as { p_note: string };

    assert.equal(note, 'Voided: wrong milestone');
    // The existing note is not sent back in. Appending to a copy read before
    // the lock is how a concurrent note gets silently dropped.
    assert.doesNotMatch(note, /raised early/);
  });

  test('the audit records the status the lock saw, not the one read before it', async () => {
    // The invoice fell overdue between the caller's read and the lock.
    readOutcome = { data: issuedInvoice({ status: 'issued' }), error: null };
    rpcOutcome = settles('voided', 'overdue', 0);

    await voidInvoice({ invoiceId: INVOICE_ID, reason: 'raised in error' });

    assert.equal(seen.audits.length, 1);
    const [audit] = seen.audits;
    assert.ok(audit, 'the void was not audited');

    assert.deepEqual(audit.before, { status: 'overdue' });
    assert.deepEqual(audit.after, { status: 'void', reason: 'raised in error' });
    assert.equal(audit.action, 'invoice.voided');
    assert.equal(audit.organizationId, ORGANIZATION_ID);
  });

  test('the service publishes nothing itself — the function already did (D17)', async () => {
    readOutcome = { data: issuedInvoice(), error: null };
    rpcOutcome = settles('voided', 'issued', 0);

    await voidInvoice({ invoiceId: INVOICE_ID, reason: 'raised in error' });

    // This used to assert one `invoice.voided` here, with its payload. Both
    // moved into finance.void_invoice, so the event and the status it
    // describes are one commit. An emit surviving here would be a duplicate.
    //
    // The payload contract — including that `reason` is the same text the note
    // is appended from — is asserted against the migration in
    // tests/outbox-transactional.test.ts.
    assert.deepEqual(seen.events, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Asking twice
// ═══════════════════════════════════════════════════════════════════════════

describe('C. voiding something already void', () => {
  test('the answer comes from the lock, not from the caller stale copy', async () => {
    // This used to short-circuit on the pre-lock read and return ok without
    // asking the database at all (audit D7). An invoice issued a moment
    // earlier by somebody else was therefore reported as successfully voided.
    readOutcome = { data: issuedInvoice({ status: 'void' }), error: null };
    rpcOutcome = settles('already_void', 'void');

    const result = await voidInvoice({ invoiceId: INVOICE_ID, reason: 'raised in error' });

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.status, 'void');
    assert.equal(seen.rpcs.length, 1, 'an already-void invoice was answered without asking');
    // Nothing changed, so nothing is recorded or announced a second time.
    assert.deepEqual(seen.audits, []);
    assert.deepEqual(seen.events, []);
  });

  test('an invoice issued between the read and the lock is refused, not reported as voided', async () => {
    // The case the short-circuit got wrong. 'issued' is voidable, so this is
    // not about the transition table — it is about which read decides.
    readOutcome = { data: issuedInvoice({ status: 'void' }), error: null };
    rpcOutcome = settles('has_payments', 'partially_paid', 40_000);

    const result = await voidInvoice({ invoiceId: INVOICE_ID, reason: 'raised in error' });

    assert.equal(result.ok, false, 'an invoice holding money was reported as voided');
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    assert.deepEqual(seen.events, []);
  });

  test('a void that landed while this caller was reading is the same answer', async () => {
    readOutcome = { data: issuedInvoice(), error: null };
    rpcOutcome = settles('already_void', 'void');

    const result = await voidInvoice({ invoiceId: INVOICE_ID, reason: 'raised in error' });

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.status, 'void');
    // The other caller's void is the one that happened. This one records
    // nothing, because nothing about the invoice changed.
    assert.deepEqual(seen.audits, []);
    assert.deepEqual(seen.events, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Input
// ═══════════════════════════════════════════════════════════════════════════

describe('D. the request itself', () => {
  test('a void needs a stated reason, and the database is never opened without one', async () => {
    const result = await voidInvoice({ invoiceId: INVOICE_ID, reason: '  ' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VALIDATION');
    assert.equal(seen.clientsOpened, 0);
  });

  test('an invoice the reader cannot see is NOT_FOUND', async () => {
    readOutcome = { data: null, error: null };

    const result = await voidInvoice({ invoiceId: INVOICE_ID, reason: 'raised in error' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_FOUND');
    assert.deepEqual(seen.rpcs, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D2. The void lock
//
// The half above executes. This half cannot: the lock is a property of one SQL
// statement and a stub has no transactions to interleave. What follows asserts
// that the lock exists, that it is taken before the ledger it protects is
// read, and that the write is inside it.
//
// These are text assertions and prove only that the clause is present and
// ordered — but they are not the only guard. scripts/verify-milestone-
// invoicing.mjs §7c check Q catches a deleted FOR UPDATE against a real
// database (verified: deleted, reset, five runs, five failures). This block is
// what makes that failure cheap to find, by running in `npm run check`.
// ═══════════════════════════════════════════════════════════════════════════

const serialisedVoidMigration = readFileSync(
  fileURLToPath(
    new URL('../supabase/migrations/20260811120004_invoice_void_serialized.sql', import.meta.url),
  ),
  'utf8',
);

/**
 * The migration with its comments removed.
 *
 * The file explains itself at length, and that prose names the very things
 * these tests assert are absent — the cached `paid_minor`, the word `definer`.
 * Asserting over the whole file would be asserting over the explanation.
 */
const executableSql = serialisedVoidMigration
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

describe('D2. the void lock', () => {
  test('it locks the invoice row', () => {
    assert.match(executableSql, /from finance\.invoices i[\s\S]{0,120}for update;/);
  });

  test('the lock is taken before the ledger is summed, and the write is inside it', () => {
    const lock = executableSql.indexOf('for update;');
    const sum = executableSql.indexOf('sum(p.amount_minor)');
    const write = executableSql.indexOf('update finance.invoices');
    assert.ok(lock > 0 && sum > 0 && write > 0, 'the migration lost one of the three');
    assert.ok(lock < sum, 'the sum is read before the lock, which is the bug this fixes');
    assert.ok(sum < write, 'the invoice is voided before the ledger is summed');
  });

  test('it sums the payment rows, not the cached paid_minor', () => {
    // paid_minor is a cache and can be stale — D3 is a way it goes stale.
    // A void decided from the cache is a void decided from a stale zero.
    const guard = executableSql.slice(
      executableSql.indexOf('for update;'),
      executableSql.indexOf('update finance.invoices'),
    );
    assert.match(guard, /from finance\.payments p/);
    assert.match(guard, /p\.status = 'captured'/);
    assert.doesNotMatch(guard, /paid_minor/);
  });

  test('it refuses rather than voids, and writes nothing when it refuses', () => {
    const refusal = executableSql.indexOf("'has_payments'::text");
    const write = executableSql.indexOf('update finance.invoices');
    assert.ok(refusal > 0, 'the refusal outcome is gone');
    assert.ok(refusal < write, 'the money guard no longer precedes the write');

    const guard = executableSql.slice(executableSql.indexOf('if v_captured > 0'), write);
    assert.doesNotMatch(guard, /update |insert into/);
  });

  test('the notes come from the locked row, never from the caller', () => {
    const write = executableSql.slice(executableSql.indexOf('update finance.invoices'));
    assert.match(write, /nullif\(v_notes, ''\)/);
  });

  test('it refuses exactly the statuses INVOICE_TRANSITIONS refuses', () => {
    const clause = executableSql.match(/v_status not in \(([^)]*)\)/);
    assert.ok(clause?.[1], 'the status guard is gone');

    const inSql = new Set(clause[1].split(',').map((s) => s.trim().replace(/'/g, '')));
    const inCode = new Set(
      (Object.keys(INVOICE_TRANSITIONS) as InvoiceStatus[]).filter((status) =>
        INVOICE_TRANSITIONS[status].includes('void'),
      ),
    );
    // A set, not a joined regex: reordering the SQL list is not a defect.
    assert.deepEqual([...inSql].sort(), [...inCode].sort());
  });

  test('already-void is answered before the status guard, so asking twice is not an error', () => {
    const already = executableSql.indexOf("'already_void'::text");
    const guard = executableSql.indexOf('v_status not in (');
    // Both indices are checked first. `indexOf` returns -1 for a branch that
    // has been deleted, and -1 is less than everything — so an unguarded
    // comparison would report the branch as correctly ordered after it was
    // removed, which is the one thing this test exists to notice.
    assert.ok(already > 0, 'the already-void branch is gone');
    assert.ok(guard > 0, 'the status guard is gone');
    assert.ok(
      already < guard,
      'an invoice that is already void would be reported as un-voidable',
    );
  });

  test('it runs as the caller, so RLS still answers tenancy', () => {
    assert.doesNotMatch(executableSql, /security definer/);
    assert.match(executableSql, /security invoker/);
    assert.match(executableSql, /set search_path = ''/);
    assert.match(executableSql, /revoke all on function[\s\S]{0,160}from public, anon/);
  });

  test('it changes no schema — this is a function, not a migration of tables', () => {
    assert.doesNotMatch(executableSql, /create table|alter table|drop table|drop constraint/);
    assert.doesNotMatch(executableSql, /create index|drop index/);
  });
});
