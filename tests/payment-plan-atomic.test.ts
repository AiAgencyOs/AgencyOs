import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import type { Role } from '../src/lib/auth/claims.ts';

/**
 * Replacing a payment plan.
 *
 * Audit finding D8, raised by the Phase 14/15 sweep of the modules the finance
 * findings never reached.
 *
 * `configurePaymentPlan` refused a rewrite only when some milestone was
 * `met` — and nothing in the repository ever writes `met`. It never looked at
 * `finance.invoices` at all. Because `invoices.milestone_id` is `on delete set
 * null`, deleting the old plan silently unhooked every invoice raised against
 * it, issued and paid ones included, and re-inserted the same milestones as
 * fresh `pending` rows.
 *
 * The consequence is the one the invoicing index exists to prevent:
 * `invoices_milestone_live_key` keys on `milestone_id`, so a milestone that is
 * deleted and recreated carries no memory of having been billed. The client is
 * invoiced twice for the same work, and the first invoice — still issued,
 * still owed — points at nothing.
 *
 * A second defect sat in the same function: the delete and the insert were two
 * round trips, so a rejected plan left the project with no plan at all. The
 * comment above it claimed "all rows land in one transaction". Only the insert
 * did; the delete had already committed.
 *
 * `projects.replace_payment_plan` closes both — it locks the plan, looks for a
 * live invoice through that lock, and does the delete and the insert in one
 * statement.
 */

type Outcome = { data: unknown; error: { message: string } | null };

let projectOutcome: { data: Record<string, unknown> | null; error: null } = {
  data: null,
  error: null,
};
let rpcOutcome: Outcome = { data: null, error: null };
let role: Role = 'owner';

const seen = {
  rpcs: [] as [string, unknown][],
  deletes: 0,
  inserts: 0,
  audits: [] as Record<string, unknown>[],
};

const stubClient = {
  schema() {
    return {
      from() {
        const chain = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          not: () => chain,
          order: () => chain,
          maybeSingle: async () => projectOutcome,
          then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
        };
        return {
          ...chain,
          // Present so a regression to the old shape runs rather than crashing.
          delete: () => {
            seen.deletes += 1;
            return { in: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }) };
          },
          insert: () => {
            seen.inserts += 1;
            return { then: (r: (v: unknown) => unknown) => r({ error: null }) };
          },
        };
      },
      rpc(fn: string, args: unknown) {
        seen.rpcs.push([fn, args]);
        return { then: (resolve: (v: Outcome) => unknown) => resolve(rpcOutcome) };
      },
    };
  },
};

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({ role, userId: 'u', organizationId: ORGANIZATION_ID }),
  },
});
mock.module('@/lib/audit', {
  exports: {
    recordAudit: async (e: Record<string, unknown>) => {
      seen.audits.push(e);
    },
  },
});
mock.module('@/lib/db/server', { exports: { createClient: async () => stubClient } });

const PROJECT_ID = '55555555-5555-4555-8555-555555555555';
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';

const { configurePaymentPlan } = await import('../src/modules/projects/service.ts');

const PLAN = {
  projectId: PROJECT_ID,
  items: [
    { name: 'Advance', percent: 30 },
    { name: 'Design', percent: 20 },
    { name: 'Build', percent: 30 },
    { name: 'Handover', percent: 20 },
  ],
};

const settles = (outcome: string, extra: Record<string, unknown> = {}) => ({
  data: [{ outcome, milestone_count: null, blocking_number: null, ...extra }],
  error: null,
});

beforeEach(() => {
  role = 'owner';
  projectOutcome = {
    data: { id: PROJECT_ID, organization_id: ORGANIZATION_ID, budget_minor: 1_000_000 },
    error: null,
  };
  rpcOutcome = settles('replaced', { milestone_count: 4 });
  seen.rpcs = [];
  seen.deletes = 0;
  seen.inserts = 0;
  seen.audits = [];
});

// ═══════════════════════════════════════════════════════════════════════════
// A. A plan that has already been billed
// ═══════════════════════════════════════════════════════════════════════════

describe('A. a plan with a live invoice against it', () => {
  test('the rewrite is refused, and the invoice is named', async () => {
    rpcOutcome = settles('billed', { blocking_number: 'INV-2026-0007' });

    const result = await configurePaymentPlan(PLAN);

    assert.equal(result.ok, false, 'a plan carrying a live invoice was replaced');
    if (result.ok) return;

    assert.equal(result.error.code, 'CONFLICT');
    assert.match(result.error.message, /INV-2026-0007/);
    assert.match(result.error.message, /void it before/i);
  });

  test('nothing is deleted, nothing is inserted, nothing is audited', async () => {
    rpcOutcome = settles('billed', { blocking_number: 'INV-2026-0007' });

    await configurePaymentPlan(PLAN);

    assert.equal(seen.deletes, 0, 'milestones were deleted out from under a bill');
    assert.equal(seen.inserts, 0);
    assert.deepEqual(seen.audits, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The rewrite goes through one statement
// ═══════════════════════════════════════════════════════════════════════════

describe('B. a plan that may be replaced', () => {
  test('it goes through the serialised function, not a delete and an insert', async () => {
    const result = await configurePaymentPlan(PLAN);

    assert.equal(result.ok, true);
    assert.equal(seen.rpcs.length, 1);
    assert.equal(seen.rpcs[0]?.[0], 'replace_payment_plan');
    // The two round trips are the second half of the finding.
    assert.equal(seen.deletes, 0, 'the plan is still deleted from the application');
    assert.equal(seen.inserts, 0, 'the plan is still inserted from the application');
  });

  test('the money is resolved before it is sent, not re-derived in SQL', async () => {
    await configurePaymentPlan(PLAN);

    const [, args] = seen.rpcs[0] as [string, { p_milestones: { amountMinor: number }[] }];
    const total = args.p_milestones.reduce((sum, m) => sum + m.amountMinor, 0);
    // The split is resolved into exact minor units once, and adds up.
    assert.equal(total, 1_000_000);
    assert.equal(args.p_milestones.length, 4);
  });

  test('a met milestone is still refused', async () => {
    rpcOutcome = settles('met');

    const result = await configurePaymentPlan(PLAN);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : '', /met milestone/);
  });

  test('an unrecognised outcome is an error, not a replaced plan', async () => {
    rpcOutcome = settles('banana');

    const result = await configurePaymentPlan(PLAN);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    assert.deepEqual(seen.audits, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D8. The plan lock
//
// The live section proves the refusal (§3b of verify-milestone-invoicing).
// It cannot prove the atomicity, because showing a rolled-back rewrite means
// destroying the fixture every later section depends on. That half is here.
// ═══════════════════════════════════════════════════════════════════════════

const migration = readFileSync(
  fileURLToPath(
    new URL(
      '../supabase/migrations/20260812120001_payment_plan_replaced_atomically.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);

const executableSql = migration
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

function at(needle: string): number {
  const index = executableSql.indexOf(needle);
  assert.ok(index > 0, `the migration no longer contains ${needle}`);
  return index;
}

describe('D8. the plan lock', () => {
  test('it locks the project and its milestones', () => {
    // Bounded to each statement, so one lock cannot stand in for the other:
    // the project's must appear before `perform 1`, and the milestones' after.
    const projectSelect = executableSql.slice(at('from projects.projects p'), at('perform 1'));
    assert.match(projectSelect, /for update;/, 'the project row is no longer locked');

    const milestoneLock = executableSql.slice(at('perform 1'), at('select count(*)'));
    assert.match(milestoneLock, /from projects\.milestones m[\s\S]{0,120}for update;/);
  });

  test('the invoice check is read through the lock, before anything is deleted', () => {
    const lock = at('for update;');
    const invoices = at('from finance.invoices i');
    const del = at('delete from projects.milestones');

    assert.ok(lock < invoices, 'the bill is looked for before the plan is locked');
    assert.ok(invoices < del, 'the plan is deleted before the bill is looked for');
  });

  test('a void invoice does not block a rewrite — a withdrawn bill is not a bill', () => {
    const guard = executableSql.slice(at('from finance.invoices i'), at('delete from projects.milestones'));
    assert.match(guard, /i\.status <> 'void'/);
  });

  test('the delete and the insert are in the same statement, so a refusal rolls both back', () => {
    const del = at('delete from projects.milestones');
    const ins = at('insert into projects.milestones');
    assert.ok(del < ins, 'the plan is inserted before the old one is cleared');

    // Nothing may return between them — a return there would commit the
    // delete and leave the project with no plan, which is the second half of
    // the finding.
    const between = executableSql.slice(del, ins);
    assert.doesNotMatch(between, /return query|return;/);
  });

  test('every refusal returns before the delete', () => {
    const del = at('delete from projects.milestones');
    for (const outcome of ['not_found', 'met', 'billed']) {
      assert.ok(at(`'${outcome}'::text`) < del, `${outcome} is decided after the plan is deleted`);
    }
  });

  test('it runs as the caller, so RLS still answers tenancy', () => {
    assert.doesNotMatch(executableSql, /security definer/);
    assert.match(executableSql, /security invoker/);
    assert.match(executableSql, /set search_path = ''/);
    assert.match(executableSql, /revoke all on function[\s\S]{0,160}from public, anon/);
  });

  test('it changes no schema', () => {
    assert.doesNotMatch(executableSql, /create table|alter table|drop table|drop constraint/);
    assert.doesNotMatch(executableSql, /create index|drop index/);
  });
});
