import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

import { can } from '../src/lib/authz/permissions.ts';
import type { Role } from '../src/lib/auth/claims.ts';

/**
 * The requirement approval gate, executed.
 *
 * Audit finding C7. `decideRequirementVersion` is the point where a human
 * agrees to a scope, and every rule it enforces — the capability check, the
 * three ways a decision can be refused, the conditional write, and the audit
 * row — was asserted in tests/requirement-proposal.test.ts by matching the
 * function's own source text. A regex over a function body cannot fail when
 * the function stops doing what the text says: reorder the branches, drop the
 * `.eq('status', 'proposed')`, or audit a decision that never landed, and the
 * source still contains every string those assertions look for.
 *
 * That file's own header gives the reason it settled for source: the rules
 * "live in two places that cannot be called from a unit test". That is true of
 * the trigger inside Postgres and of the runner's model call, and those stay
 * where they are — proved against a real database by
 * scripts/verify-requirement-proposal.mjs. It is *not* true of this function.
 * What it does is application branching: read a row, decide which of four
 * answers the caller gets, write conditionally, audit. The database's part is
 * a row in and a row out.
 *
 * So the database is stubbed here, and only the database. `requireInternal`
 * and `recordAudit` are stubbed to observe what the function asks of them; the
 * capability model is the real one, and the fixtures below assert that against
 * `can` rather than assuming which roles hold `lead.write`. Nothing restates
 * the rule under test — every assertion is on what the real function returned
 * or did.
 *
 * Deliberately NOT simulated here, and left with the live script: RLS
 * visibility, the supersede trigger, the unique indexes, and version
 * allocation under a lock. A fake that reimplements those would prove only
 * that the fake agrees with itself — the same line tests/crm-ingest.test.ts
 * draws.
 */

// ── the stubs ──────────────────────────────────────────────────────────────

type Outcome = { data: Record<string, unknown> | null; error: { message: string } | null };

/** What the stubbed client will answer, and what it was asked, per test. */
let readOutcome: Outcome = { data: null, error: null };
let updateOutcome: Outcome = { data: null, error: null };
let role: Role = 'owner';

const seen = {
  clientsOpened: 0,
  schemas: [] as string[],
  tables: [] as string[],
  updates: [] as unknown[],
  readFilters: [] as [string, unknown][],
  updateFilters: [] as [string, unknown][],
  audits: [] as Record<string, unknown>[],
};

/**
 * A recorder shaped like the query builder, not a reimplementation of one.
 * It answers with whatever the test planted and remembers what was asked —
 * it never decides anything, which is the point: every decision in these
 * tests comes from the real function.
 */
function queryBuilder(isUpdate: boolean) {
  const chain = {
    select: () => chain,
    eq(column: string, value: unknown) {
      (isUpdate ? seen.updateFilters : seen.readFilters).push([column, value]);
      return chain;
    },
    maybeSingle: async () => (isUpdate ? updateOutcome : readOutcome),
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
          select: () => queryBuilder(false),
          update(patch: unknown) {
            seen.updates.push(patch);
            return queryBuilder(true);
          },
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
      organizationId: '22222222-2222-4222-8222-222222222222',
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

mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => {
      seen.clientsOpened += 1;
      return stubClient;
    },
  },
});

// Imported after the mocks are registered, so the real module resolves to them.
const { decideRequirementVersion } = await import('../src/modules/crm/service.ts');

const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';

/** A row the gate should accept: still open, and visible to the reader. */
const proposedRow = {
  id: VERSION_ID,
  organization_id: ORGANIZATION_ID,
  conversation_id: CONVERSATION_ID,
  version: 3,
  status: 'proposed',
};

beforeEach(() => {
  role = 'owner';
  readOutcome = { data: null, error: null };
  updateOutcome = { data: null, error: null };
  seen.clientsOpened = 0;
  seen.schemas = [];
  seen.tables = [];
  seen.updates = [];
  seen.readFilters = [];
  seen.updateFilters = [];
  seen.audits = [];
});

// ═══════════════════════════════════════════════════════════════════════════
// The fixtures are tied to the real capability model
// ═══════════════════════════════════════════════════════════════════════════

describe('0. the roles these tests rely on', () => {
  test('owner may decide, member may not — asserted, not assumed', () => {
    assert.equal(can('owner', 'lead.write'), true);
    assert.equal(can('member', 'lead.write'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A. Refusals — the three ways a decision does not happen
// ═══════════════════════════════════════════════════════════════════════════

describe('A. a decision that must not land', () => {
  test('a role without lead.write is refused before the database is opened', async () => {
    role = 'member';
    readOutcome = { data: proposedRow, error: null };

    const result = await decideRequirementVersion(VERSION_ID, 'accepted');

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'FORBIDDEN');
    // The capability check has to come first: a refused caller must not even
    // cause a read, or the gate leaks whether the row exists.
    assert.equal(seen.clientsOpened, 0, 'the database was opened for a forbidden caller');
    assert.deepEqual(seen.updates, []);
    assert.deepEqual(seen.audits, []);
  });

  test('a version that is absent or invisible is NOT_FOUND, and nothing is written', async () => {
    readOutcome = { data: null, error: null };

    const result = await decideRequirementVersion(VERSION_ID, 'accepted');

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'NOT_FOUND');
    assert.deepEqual(seen.updates, [], 'it wrote against a row it could not read');
    assert.deepEqual(seen.audits, []);
  });

  test('an already-decided proposal is a CONFLICT, and is not decided twice', async () => {
    for (const already of ['accepted', 'rejected', 'superseded']) {
      seen.updates = [];
      seen.audits = [];
      readOutcome = { data: { ...proposedRow, status: already }, error: null };

      const result = await decideRequirementVersion(VERSION_ID, 'accepted');

      assert.equal(result.ok, false, `${already} was allowed to be decided again`);
      if (result.ok) return;
      assert.equal(result.error.code, 'CONFLICT');
      assert.match(result.error.message, new RegExp(already));
      assert.deepEqual(seen.updates, [], `${already} was written to`);
      assert.deepEqual(seen.audits, [], `${already} produced an audit row`);
    }
  });

  test('losing the race writes no audit — an unlanded decision is not recorded', async () => {
    // The row was proposed when read and decided by someone else before the
    // conditional update ran, so the update matches nothing.
    readOutcome = { data: proposedRow, error: null };
    updateOutcome = { data: null, error: null };

    const result = await decideRequirementVersion(VERSION_ID, 'accepted');

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'CONFLICT');
    assert.deepEqual(
      seen.audits,
      [],
      'a decision that never landed was written to the audit trail',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Failures are internal, and say nothing about the driver
// ═══════════════════════════════════════════════════════════════════════════

describe('B. a database failure', () => {
  test('a failed read is INTERNAL and does not leak the driver message', async () => {
    readOutcome = { data: null, error: { message: 'permission denied for relation requirement_versions' } };

    const result = await decideRequirementVersion(VERSION_ID, 'accepted');

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
    assert.doesNotMatch(result.error.message, /permission denied|relation/);
    assert.deepEqual(seen.updates, []);
    assert.deepEqual(seen.audits, []);
  });

  test('a failed write is INTERNAL, and is never audited as a decision', async () => {
    readOutcome = { data: proposedRow, error: null };
    updateOutcome = { data: null, error: { message: 'deadlock detected' } };

    const result = await decideRequirementVersion(VERSION_ID, 'accepted');

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
    assert.doesNotMatch(result.error.message, /deadlock/);
    assert.deepEqual(seen.audits, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. A decision that does land
// ═══════════════════════════════════════════════════════════════════════════

describe('C. accepting a proposal', () => {
  beforeEach(() => {
    readOutcome = { data: proposedRow, error: null };
    updateOutcome = { data: { id: VERSION_ID }, error: null };
  });

  test('it reports the version and the status it reached', async () => {
    const result = await decideRequirementVersion(VERSION_ID, 'accepted');

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data, { versionId: VERSION_ID, status: 'accepted' });
  });

  test('the write is conditional on the row still being proposed', async () => {
    await decideRequirementVersion(VERSION_ID, 'accepted');

    // Both predicates, or two people deciding at once could both succeed.
    assert.deepEqual(
      seen.updateFilters.sort(),
      [
        ['id', VERSION_ID],
        ['status', 'proposed'],
      ].sort(),
    );
  });

  test('it moves the status and nothing else — the approved scope is untouched', async () => {
    await decideRequirementVersion(VERSION_ID, 'accepted');

    assert.equal(seen.updates.length, 1);
    // Exactly one key. A gate that could also rewrite the payload would be
    // approving something other than what it showed the human.
    assert.deepEqual(seen.updates[0], { status: 'accepted' });
  });

  test('it reads through the caller’s own client, on the crm schema', async () => {
    await decideRequirementVersion(VERSION_ID, 'accepted');

    assert.equal(seen.clientsOpened, 1);
    assert.deepEqual(seen.schemas, ['crm', 'crm']);
    assert.deepEqual(seen.tables, ['requirement_versions', 'requirement_versions']);
    assert.deepEqual(seen.readFilters, [['id', VERSION_ID]]);
  });

  test('who agreed to what scope is recorded by the database now (G-093)', async () => {
    // This asserted the service wrote the row. Since G-093 the trigger on
    // crm.requirement_versions writes it inside the same transaction as the
    // UPDATE, so the decision and its record commit together — and the
    // `before` is the real prior row rather than the { status: 'proposed' }
    // the service had to assert from a read taken earlier.
    //
    // The vocabulary (requirement.accepted / requirement.rejected, from the
    // new status) is asserted in audit-in-the-transaction.test.ts §G.
    await decideRequirementVersion(VERSION_ID, 'accepted');

    assert.deepEqual(seen.audits, [], 'the service is auditing again — G-093 chose one mechanism');
  });
});

describe('D. rejecting a proposal', () => {
  beforeEach(() => {
    readOutcome = { data: proposedRow, error: null };
    updateOutcome = { data: { id: VERSION_ID }, error: null };
  });

  test('it takes the same path and reports the rejection', async () => {
    const result = await decideRequirementVersion(VERSION_ID, 'rejected');

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data, { versionId: VERSION_ID, status: 'rejected' });
    assert.deepEqual(seen.updates[0], { status: 'rejected' });
  });

  test('and the rejection is recorded by the trigger, not faked as an approval', async () => {
    // The distinction this protects is now structural: the trigger derives
    // `requirement.` || new.status, so a rejection cannot be recorded as an
    // acceptance without the status itself being wrong.
    await decideRequirementVersion(VERSION_ID, 'rejected');

    assert.deepEqual(seen.updates[0], { status: 'rejected' });
    assert.deepEqual(seen.audits, []);
  });
});
