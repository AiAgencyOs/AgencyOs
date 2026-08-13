import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

import { LEAD_TRANSITIONS } from '../src/modules/crm/schema.ts';
import type { Role } from '../src/lib/auth/claims.ts';

/**
 * Moving something from one state to another, when somebody else is too.
 *
 * Audit findings D10, D13 and D14, from the Phase 14/15 sweep.
 *
 * Three functions — setLeadStatus, setOpportunityStage, setProjectStatus —
 * read the current state, decided against their TypeScript transition map, and
 * then wrote matching on the id alone. The predicate the decision rested on
 * never made it into the write, so whatever landed in between was silently
 * overwritten.
 *
 * The sharpest case is a deal. Two people open the same opportunity in
 * `negotiation`. One marks it won; the other, still holding a page rendered
 * before that, marks it lost. Both writes match. The deal is lost, its
 * `closed_at` is the later moment, and the audit trail records both
 * transitions from `negotiation` as though each were the only one.
 *
 * This is the same defect D1, D2 and D4 fixed in finance, and it wants a
 * smaller answer here. Those needed a lock because they had to sum a ledger
 * through it. These have no ledger — only a state not to clobber — so
 * restating the state in the write is enough: `.eq('status', from)`. A write
 * that matches zero rows is the world having moved, and it is now reported
 * rather than assumed away.
 *
 * D13 rides along, because it is the same statement: `disqualified_reason` was
 * only ever written on the way in, so a reopened lead kept the reason it had
 * been rejected for and the panel kept showing it. It is cleared on the way
 * out now.
 */

type Outcome = { data: { id: string } | null; error: { message: string } | null };

let readOutcome: { data: Record<string, unknown> | null; error: null } = { data: null, error: null };
let writeOutcome: Outcome = { data: { id: 'x' }, error: null };
let role: Role = 'owner';

const seen = { filters: [] as [string, unknown][], patches: [] as Record<string, unknown>[], audits: 0 };

function client() {
  return {
    schema() {
      return {
        from() {
          const read = {
            select: () => read,
            eq: () => read,
            is: () => read,
            maybeSingle: async () => readOutcome,
          };
          return {
            select: () => read,
            update(patch: Record<string, unknown>) {
              seen.patches.push(patch);
              const chain = {
                eq(column: string, value: unknown) {
                  seen.filters.push([column, value]);
                  return chain;
                },
                select: () => chain,
                maybeSingle: async () => writeOutcome,
                then: (r: (v: Outcome) => unknown) => r(writeOutcome),
              };
              return chain;
            },
            insert: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }),
          };
        },
      };
    },
  };
}

mock.module('@/lib/auth/session', {
  exports: { requireInternal: async () => ({ role, userId: 'u', organizationId: 'o' }) },
});
mock.module('@/lib/audit', {
  exports: {
    recordAudit: async () => {
      seen.audits += 1;
    },
  },
});
mock.module('@/lib/db/server', { exports: { createClient: async () => client() } });

const ID = '55555555-5555-4555-8555-555555555555';

const { setLeadStatus } = await import('../src/modules/crm/service.ts');
const { setOpportunityStage } = await import('../src/modules/sales/service.ts');
const { setProjectStatus } = await import('../src/modules/projects/service.ts');

/** Each transition, with the state column it must restate in the write. */
const MOVES = [
  {
    name: 'setLeadStatus',
    column: 'status',
    from: 'qualifying',
    row: { id: ID, organization_id: 'o', status: 'qualifying' },
    call: () => setLeadStatus({ leadId: ID, status: 'qualified' }),
  },
  {
    name: 'setOpportunityStage',
    column: 'stage',
    from: 'negotiation',
    row: { id: ID, organization_id: 'o', lead_id: 'l', stage: 'negotiation', name: 'Deal' },
    call: () => setOpportunityStage({ opportunityId: ID, stage: 'won' }),
  },
  {
    name: 'setProjectStatus',
    column: 'status',
    from: 'planning',
    row: { id: ID, organization_id: 'o', status: 'planning' },
    call: () => setProjectStatus({ projectId: ID, status: 'onboarding' }),
  },
] as const;

beforeEach(() => {
  role = 'owner';
  writeOutcome = { data: { id: ID }, error: null };
  seen.filters = [];
  seen.patches = [];
  seen.audits = 0;
});

// ═══════════════════════════════════════════════════════════════════════════
// A. Somebody else moved it first
// ═══════════════════════════════════════════════════════════════════════════

describe('A. a transition that no longer applies', () => {
  for (const move of MOVES) {
    test(`${move.name} restates the state it decided against`, async () => {
      readOutcome = { data: { ...move.row }, error: null };

      await move.call();

      // Without this the write matches on the id alone and overwrites whatever
      // landed in between.
      assert.ok(
        seen.filters.some(([c, v]) => c === move.column && v === move.from),
        `the write does not carry ${move.column} = ${move.from}, so a concurrent move is clobbered`,
      );
    });

    test(`${move.name} reports a write that matched nothing`, async () => {
      readOutcome = { data: { ...move.row }, error: null };
      // The compare-and-swap found no row: somebody else got there first.
      writeOutcome = { data: null, error: null };

      const result = await move.call();

      assert.equal(result.ok, false, 'a lost race was reported as a successful transition');
      assert.equal(result.ok === false && result.error.code, 'CONFLICT');
      assert.match(result.ok === false ? result.error.message : '', /somebody else/i);
    });

    test(`${move.name} audits nothing when it changed nothing`, async () => {
      readOutcome = { data: { ...move.row }, error: null };
      writeOutcome = { data: null, error: null };

      await move.call();

      // audit.audit_log is append-only, so a transition recorded here can
      // never be taken back.
      assert.equal(seen.audits, 0, 'a transition that did not happen was written to the audit trail');
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The transition that does apply
// ═══════════════════════════════════════════════════════════════════════════

describe('B. a transition that lands', () => {
  for (const move of MOVES) {
    test(`${move.name} still succeeds, and no longer audits from here`, async () => {
      // G-093 moved the audit into a trigger on the table. The transition
      // still has to land — that is what this section is for — but the record
      // of it is written by the database, in the same transaction, on every
      // path into the row rather than only this one.
      readOutcome = { data: { ...move.row }, error: null };

      const result = await move.call();

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(seen.audits, 0);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Reopening a disqualified lead (D13)
// ═══════════════════════════════════════════════════════════════════════════

describe('C. the reason a lead was rejected', () => {
  test('is cleared when the lead is reopened', () => {
    // The transition this is about exists, so the test is not hypothetical.
    assert.ok(LEAD_TRANSITIONS.disqualified.includes('qualifying'));
  });

  test('the write clears disqualified_reason on the way out', async () => {
    readOutcome = { data: { id: ID, organization_id: 'o', status: 'disqualified' }, error: null };

    await setLeadStatus({ leadId: ID, status: 'qualifying' });

    const [patch] = seen.patches;
    assert.ok(patch, 'nothing was written');
    assert.equal(
      patch.disqualified_reason,
      null,
      'a reopened lead still carries the reason it was rejected for',
    );
  });

  test('and still sets it on the way in', async () => {
    readOutcome = { data: { id: ID, organization_id: 'o', status: 'qualifying' }, error: null };

    await setLeadStatus({ leadId: ID, status: 'disqualified', reason: 'budget went away' });

    const [patch] = seen.patches;
    assert.ok(patch);
    assert.equal(patch.disqualified_reason, 'budget went away');
  });
});
