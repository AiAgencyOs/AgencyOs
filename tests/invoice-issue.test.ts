import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { can } from '../src/lib/authz/permissions.ts';
import type { Role } from '../src/lib/auth/claims.ts';
import { INVOICE_TRANSITIONS, type InvoiceStatus } from '../src/modules/finance/schema.ts';

/**
 * Sending an invoice to a client, executed.
 *
 * Audit finding D4, and the third instance of one defect. `issueInvoice` read
 * the invoice, decided from that copy, counted its line items in a separate
 * round trip, and then wrote `status = 'issued'` with the invoice id as its
 * only predicate. Four statements, three gaps.
 *
 * A void landing in one of those gaps was overwritten: a withdrawn invoice
 * went live again, client-visible, still carrying the "Voided: …" note D2
 * wrote, and holding the milestone's live-invoice slot so no replacement could
 * be raised. A payment landing in one of them was worse — a settled invoice
 * came back as outstanding while keeping its `paid_at` and its full ledger,
 * and there is no way back from there: voiding refuses money, a fresh receipt
 * is an overpayment, and nothing but reconcile ever writes 'paid'.
 *
 * `finance.issue_invoice` decides all of it under a lock on the invoice, and
 * locks the line items while it checks them.
 *
 * Split the same way D2's tests are, and for the same reasons. The branching is
 * application code, so it is *executed* here with only the database stubbed.
 * The lock is a property of one SQL statement, so it is asserted structurally
 * at the bottom — and every ordering assertion there guards that its indices
 * are positive first, because `indexOf` returns -1 for a clause that has been
 * deleted and -1 is less than everything. A live §7d races an issue against a
 * void.
 *
 * Worth stating plainly: before this change `issueInvoice` had no test
 * anywhere. `grep issueInvoice tests/` returned nothing.
 */

// ── the stubs ──────────────────────────────────────────────────────────────

type ReadOutcome = { data: Record<string, unknown> | null; error: { message: string } | null };
type RpcOutcome = { data: unknown; error: { message: string } | null };

let readOutcome: ReadOutcome = { data: null, error: null };
let rpcOutcome: RpcOutcome = { data: null, error: null };
/**
 * What a bare `.update()` would answer.
 *
 * Nothing in the fixed function calls it. It is left reachable and successful
 * so the pre-fix implementation runs to completion against this stub and fails
 * these tests on its answers rather than on a missing method.
 */
let updateOutcome: { error: { message: string } | null } = { error: null };
/** What the old unlocked line-item count returned. */
let itemCount = 1;
let role: Role = 'owner';

const seen = {
  clientsOpened: 0,
  tables: [] as string[],
  updates: [] as unknown[],
  rpcs: [] as [string, unknown][],
  audits: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
};

function readBuilder(table: string) {
  const chain = {
    // The old items check was `.select('id', { count: 'exact', head: true })`,
    // which resolves to `{ count }` without a terminal `maybeSingle`. Both
    // shapes are modelled so the pre-fix code reaches its own answer.
    select: (_columns?: unknown, options?: { head?: boolean }) =>
      options?.head ? { eq: async () => ({ count: itemCount, error: null }) } : chain,
    eq: () => chain,
    maybeSingle: async () => readOutcome,
  };
  if (table === 'invoice_items') {
    return {
      select: (_columns?: unknown, _options?: unknown) => ({
        eq: async () => ({ count: itemCount, error: null }),
      }),
    };
  }
  return chain;
}

function updateBuilder() {
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
        seen.tables.push(table);
        const reader = readBuilder(table);
        return {
          ...reader,
          update(patch: unknown) {
            seen.updates.push(patch);
            return updateBuilder();
          },
        };
      },
      rpc(fn: string, args: unknown) {
        seen.rpcs.push([fn, args]);
        return { then: (resolve: (value: RpcOutcome) => unknown) => resolve(rpcOutcome) };
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

const { issueInvoice } = await import('../src/modules/finance/service.ts');

function draftInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    organization_id: ORGANIZATION_ID,
    client_account_id: '44444444-4444-4444-8444-444444444444',
    project_id: '55555555-5555-4555-8555-555555555555',
    milestone_id: '66666666-6666-4666-8666-666666666666',
    number: 'INV-2026-0007',
    status: 'draft',
    currency: 'INR',
    total_minor: 100_000,
    paid_minor: 0,
    notes: null,
    ...overrides,
  };
}

function settles(outcome: string, invoiceStatus: string | null = 'draft') {
  return { data: [{ outcome, invoice_status: invoiceStatus }], error: null };
}

beforeEach(() => {
  role = 'owner';
  readOutcome = { data: draftInvoice(), error: null };
  rpcOutcome = settles('issued');
  updateOutcome = { error: null };
  itemCount = 1;
  seen.clientsOpened = 0;
  seen.tables = [];
  seen.updates = [];
  seen.rpcs = [];
  seen.audits = [];
  seen.events = [];
});

// ═══════════════════════════════════════════════════════════════════════════
// 0. Fixtures tied to the real vocabulary
// ═══════════════════════════════════════════════════════════════════════════

describe('0. what these tests rely on', () => {
  test('owner may issue, member may not — asserted, not assumed', () => {
    assert.equal(can('owner', 'invoice.issue'), true);
    assert.equal(can('member', 'invoice.issue'), false);
  });

  test('only two statuses may become issued, and issued is not one of them', () => {
    const issuable = (Object.keys(INVOICE_TRANSITIONS) as InvoiceStatus[]).filter((status) =>
      INVOICE_TRANSITIONS[status].includes('issued'),
    );
    assert.deepEqual(issuable.slice().sort(), ['draft', 'pending_approval']);
    // Which is why idempotence cannot be answered by the transition table.
    assert.equal(INVOICE_TRANSITIONS.issued.includes('issued'), false);
    assert.equal(INVOICE_TRANSITIONS.void.length, 0);
    assert.equal(INVOICE_TRANSITIONS.paid.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A. An issue that must not land
// ═══════════════════════════════════════════════════════════════════════════

describe('A. an issue that must not land', () => {
  test('a role without invoice.issue is refused before the database is opened', async () => {
    role = 'member';

    const result = await issueInvoice({ invoiceId: INVOICE_ID });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'FORBIDDEN');
    assert.equal(seen.clientsOpened, 0);
    assert.deepEqual(seen.rpcs, []);
  });

  test('an invoice voided under the lock is refused, and quotes the status the lock saw', async () => {
    // The caller read 'draft'. By the time the lock was taken it was void.
    readOutcome = { data: draftInvoice(), error: null };
    rpcOutcome = settles('not_issuable', 'void');

    const result = await issueInvoice({ invoiceId: INVOICE_ID });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    assert.match(result.ok === false ? result.error.message : '', /from void to issued/);
  });

  test('and a refused issue writes nothing, audits nothing, and emits nothing', async () => {
    rpcOutcome = settles('not_issuable', 'void');

    await issueInvoice({ invoiceId: INVOICE_ID });

    assert.deepEqual(seen.updates, []);
    assert.deepEqual(seen.audits, []);
    assert.deepEqual(seen.events, []);
  });

  test('an invoice paid under the lock is refused — issuing it would retract the payment', async () => {
    rpcOutcome = settles('not_issuable', 'paid');

    const result = await issueInvoice({ invoiceId: INVOICE_ID });

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : '', /from paid to issued/);
    assert.deepEqual(seen.audits, []);
  });

  test('an invoice with no line items is refused under the lock, not from a stale count', async () => {
    // The old code counted items itself, in an unlocked round trip that never
    // read its own error. That count is gone.
    rpcOutcome = settles('no_items', 'draft');

    const result = await issueInvoice({ invoiceId: INVOICE_ID });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    assert.match(result.ok === false ? result.error.message : '', /no line items/);
    assert.equal(
      seen.tables.includes('invoice_items'),
      false,
      'the line items are still being counted outside the lock',
    );
  });

  test('an invoice with no amount is refused', async () => {
    rpcOutcome = settles('no_amount', 'draft');

    const result = await issueInvoice({ invoiceId: INVOICE_ID });

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : '', /no amount/);
  });

  test('an invoice that vanished under the lock is NOT_FOUND, not a silent success', async () => {
    rpcOutcome = settles('not_found', null);

    const result = await issueInvoice({ invoiceId: INVOICE_ID });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_FOUND');
    assert.deepEqual(seen.events, []);
  });

  test('a driver failure is reported, never swallowed into a success', async () => {
    rpcOutcome = { data: null, error: { message: 'permission denied for relation invoices' } };

    const result = await issueInvoice({ invoiceId: INVOICE_ID });

    assert.equal(result.ok, false, 'a failed issue was reported as a sent invoice');
    if (result.ok) return;

    assert.equal(result.error.code, 'INTERNAL');
    assert.doesNotMatch(result.error.message, /permission denied|relation/);
    assert.deepEqual(seen.audits, []);
  });

  test('an outcome nobody recognises is an error, not an issued invoice', async () => {
    rpcOutcome = settles('banana', 'draft');

    const result = await issueInvoice({ invoiceId: INVOICE_ID });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    assert.deepEqual(seen.events, []);
  });

  test('an empty response is an error, not an issued invoice', async () => {
    rpcOutcome = { data: [], error: null };

    const result = await issueInvoice({ invoiceId: INVOICE_ID });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
  });

  test('a status the pre-lock read already rules out never reaches the database', async () => {
    // The cheap answer for the caller that is alone. It fails closed, so an
    // out-of-date copy can only make it stricter than the truth.
    readOutcome = { data: draftInvoice({ status: 'partially_paid' }), error: null };

    const result = await issueInvoice({ invoiceId: INVOICE_ID });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    assert.deepEqual(seen.rpcs, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The issue that lands
// ═══════════════════════════════════════════════════════════════════════════

describe('B. an issue that lands', () => {
  test('it goes through the serialised function, not a bare update', async () => {
    const result = await issueInvoice({ invoiceId: INVOICE_ID });

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.status, 'issued');
    assert.equal(result.ok === true && result.data.number, 'INV-2026-0007');
    assert.deepEqual(seen.rpcs, [['issue_invoice', { p_invoice_id: INVOICE_ID }]]);
    // The unguarded write the finding was about is gone.
    assert.deepEqual(seen.updates, []);
  });

  test('a due date is passed to the function; its absence leaves the existing one alone', async () => {
    await issueInvoice({ invoiceId: INVOICE_ID, dueOn: '2026-09-30' });

    assert.deepEqual(seen.rpcs, [
      ['issue_invoice', { p_invoice_id: INVOICE_ID, p_due_at: '2026-09-30T00:00:00.000Z' }],
    ]);

    seen.rpcs = [];
    await issueInvoice({ invoiceId: INVOICE_ID });

    const [call] = seen.rpcs;
    assert.ok(call, 'the function was not called');
    assert.equal('p_due_at' in (call[1] as Record<string, unknown>), false);
  });

  test('the service audits nothing itself — the function already did (G-079)', async () => {
    // This used to assert one `invoice.issued` audit row here, taking `before`
    // from the status the lock saw rather than the caller's stale read. Gap
    // G-079 moved the write into finance.issue_invoice, so the history commits
    // with the status it describes instead of in a second request that could
    // fail on its own — and `audit.audit_log` is append-only by trigger, so a
    // row that was never written can never be written later.
    //
    // The `before` it now records is the same locked status, which is asserted
    // against the migration in tests/audit-in-the-transaction.test.ts and end
    // to end against real Postgres in verify-milestone-invoicing §7g.
    readOutcome = { data: draftInvoice({ status: 'draft' }), error: null };
    rpcOutcome = settles('issued', 'pending_approval');

    await issueInvoice({ invoiceId: INVOICE_ID });

    assert.deepEqual(seen.audits, []);
  });

  test('the service publishes nothing itself — the function already did (D17)', async () => {
    await issueInvoice({ invoiceId: INVOICE_ID });

    // This used to assert one `invoice.issued` here, with its payload. Both
    // moved into finance.issue_invoice, so the event commits with the status
    // it describes instead of in a second transaction that could fail on its
    // own. An emit surviving here would be a *duplicate* event, and duplicate
    // events mean duplicate outbox ids, which means duplicate dedupe keys,
    // which means the same handler runs twice.
    //
    // The payload contract is asserted against the migration in
    // tests/outbox-transactional.test.ts, and end to end against real Postgres
    // in verify-milestone-invoicing §7f.
    assert.deepEqual(seen.events, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Asking twice
// ═══════════════════════════════════════════════════════════════════════════

describe('C. issuing something already issued', () => {
  test('the answer comes from the lock, not from the caller stale copy', async () => {
    // This is the case the pre-fix code answered `ok` to without asking the
    // database at all — so an invoice voided a moment earlier was reported as
    // successfully issued, and the client was told so.
    readOutcome = { data: draftInvoice({ status: 'issued' }), error: null };
    rpcOutcome = settles('already_issued', 'issued');

    const result = await issueInvoice({ invoiceId: INVOICE_ID });

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.status, 'issued');
    assert.equal(seen.rpcs.length, 1, 'an already-issued invoice was answered without asking');
    // Nothing changed, so nothing is recorded or announced a second time.
    assert.deepEqual(seen.audits, []);
    assert.deepEqual(seen.events, []);
  });

  test('an invoice voided between the read and the lock is refused, not reported as issued', async () => {
    readOutcome = { data: draftInvoice({ status: 'issued' }), error: null };
    rpcOutcome = settles('not_issuable', 'void');

    const result = await issueInvoice({ invoiceId: INVOICE_ID });

    assert.equal(result.ok, false, 'a voided invoice was reported to the client as issued');
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    assert.deepEqual(seen.events, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D4. The issue lock
//
// Text assertions, and only that: the lock is a property of one statement and
// a stub has no transactions to interleave. scripts/verify-milestone-
// invoicing.mjs §7d races an issue against a void for real; this block is what
// makes a missing clause cheap to find, by running in `npm run check`.
// ═══════════════════════════════════════════════════════════════════════════

const serialisedIssueMigration = readFileSync(
  fileURLToPath(
    new URL('../supabase/migrations/20260811120005_invoice_issue_serialized.sql', import.meta.url),
  ),
  'utf8',
);

/** The migration with its comments removed — the prose names what these assert is absent. */
const executableSql = serialisedIssueMigration
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

/** Every ordering assertion guards its indices first: indexOf returns -1 for a deleted clause. */
function at(needle: string): number {
  const index = executableSql.indexOf(needle);
  assert.ok(index > 0, `the migration no longer contains ${needle}`);
  return index;
}

describe('D4. the issue lock', () => {
  test('it locks the invoice row', () => {
    assert.match(executableSql, /from finance\.invoices i[\s\S]{0,120}for update;/);
  });

  test('the lock is taken before every decision, and the write is inside it', () => {
    const lock = at('for update;');
    const statusGuard = at('v_status not in (');
    const items = at('from finance.invoice_items it');
    const write = at('update finance.invoices');

    assert.ok(lock < statusGuard, 'the status is judged before the row is locked');
    assert.ok(statusGuard < items, 'the line items are checked before the status');
    assert.ok(items < write, 'the invoice is issued before its line items are checked');
  });

  test('the line items are locked as they are read, not merely counted', () => {
    const items = executableSql.slice(at('from finance.invoice_items it'), at('update finance.invoices'));
    assert.match(items, /for share;/);
    // FOR KEY SHARE would not conflict with a concurrent UPDATE moving a line
    // to another invoice, because invoice_id is in no unique index.
    assert.doesNotMatch(items, /for key share/);
    // A LIMIT under a row lock can lose its chosen tuple to a concurrent
    // delete and report an empty table that is not empty.
    assert.doesNotMatch(items, /limit/i);
  });

  test('it refuses exactly the statuses INVOICE_TRANSITIONS refuses', () => {
    const clause = executableSql.match(/v_status not in \(([^)]*)\)/);
    assert.ok(clause?.[1], 'the status guard is gone');

    const inSql = new Set(clause[1].split(',').map((s) => s.trim().replace(/'/g, '')));
    const inCode = new Set(
      (Object.keys(INVOICE_TRANSITIONS) as InvoiceStatus[]).filter((status) =>
        INVOICE_TRANSITIONS[status].includes('issued'),
      ),
    );
    assert.deepEqual([...inSql].sort(), [...inCode].sort());
  });

  test('already-issued is answered before the status guard, so asking twice is not an error', () => {
    assert.ok(
      at("'already_issued'::text") < at('v_status not in ('),
      'an invoice that is already issued would be reported as un-issuable',
    );
  });

  test('every refusal returns before the write', () => {
    const write = at('update finance.invoices');
    for (const outcome of ['not_found', 'already_issued', 'not_issuable', 'no_amount', 'no_items']) {
      assert.ok(at(`'${outcome}'::text`) < write, `${outcome} is decided after the invoice is issued`);
    }
  });

  test('the moment of issue is when the lock was held, not when the transaction opened', () => {
    // now() is transaction_timestamp(), fixed before the lock is granted — so
    // under the contention this exists for it would be wrong.
    const write = executableSql.slice(at('update finance.invoices'));
    assert.match(write, /clock_timestamp\(\)/);
    assert.doesNotMatch(write, /now\(\)/);
  });

  test('an absent due date leaves the existing one alone', () => {
    const write = executableSql.slice(at('update finance.invoices'));
    assert.match(write, /coalesce\(p_due_at, due_at\)/);
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
