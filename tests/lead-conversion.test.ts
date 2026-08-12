import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { LEAD_TRANSITIONS } from '../src/modules/crm/schema.ts';

/**
 * Audit finding D20 — the fourth writer, and the one D10 missed.
 *
 * D10 found three functions that read a state, decided against it, and then
 * wrote matching on the id alone. `markLeadConverted` is a fourth, and it was
 * worse than the other three: it did not read at all. It wrote
 * `status = 'converted'` with the lead id as its only predicate.
 *
 * Three things followed, and they are separate failures rather than one:
 *
 *   It moved a lead from *any* state. LEAD_TRANSITIONS admits only
 *   `qualified → converted`, and setLeadStatus enforces that on every path the
 *   UI can reach — but a deal won against a **disqualified** lead came through
 *   here and forced it converted anyway, carrying its `disqualified_reason`.
 *   D13 exists precisely to clear that reason on the way out of
 *   `disqualified`; this door left it set.
 *
 *   It rewrote `converted_at` every time. That column is the only record of
 *   when a lead became a client, and re-running a conversion moved it to now.
 *
 *   It reported success when it changed nothing. Without `.select()`, a
 *   PostgREST update matching zero rows looks exactly like one that matched —
 *   so a deleted lead, or another organization's lead invisible under RLS,
 *   came back `converted: true`.
 *
 * The fix is deliberately **narrower than LEAD_TRANSITIONS**, and that is the
 * part worth reading twice. The map admits only `qualified → converted`, but
 * `createOpportunity` refuses only a *disqualified* lead — so deals are
 * routinely opened on `new` and `qualifying` ones, and reaching `qualified`
 * takes two manual clicks on a form higher up the same page. Enforcing the map
 * here would strand every one of those: a project would exist whose lead still
 * reads `qualifying`, with nothing to reconcile it.
 *
 * So the swap admits `new`, `qualifying` and `qualified`, and excludes the two
 * states that are wrong under any reading. Whether winning a deal *should*
 * imply qualification is a question about how the agency works, and it is
 * ADM-41 rather than something decided here.
 *
 * Executed against the real service with the database stubbed, because all of
 * it is application branching over a row-or-error. The transition rule is read
 * from schema.ts rather than restated, so the two cannot drift.
 */

type Row = Record<string, unknown> | null;

/** What the compare-and-swap returns: a row when it matched, null when not. */
let swapOutcome: { data: Row; error: { message: string } | null } = {
  // A returning UPDATE hands back the row it wrote, so `status` here is
  // already 'converted' — the stub mirrors that rather than the prior state.
  data: { id: 'lead-1', organization_id: 'org-1', status: 'converted' },
  error: null,
};
/** What the follow-up read returns, when the swap matched nothing. */
let readOutcome: { data: Row; error: { message: string } | null } = { data: null, error: null };

const seen = {
  /** Every `.eq()` applied to the update, in order. */
  swapFilters: [] as [string, unknown][],
  activities: [] as Record<string, unknown>[],
  patches: [] as Record<string, unknown>[],
  reads: 0,
  audits: [] as Record<string, unknown>[],
};

const LEAD_ID = '11111111-1111-4111-8111-111111111111';

function client() {
  return {
    schema() {
      return {
        from(table: string) {
          const read = {
            select: () => read,
            eq: () => read,
            is: () => read,
            maybeSingle: async () => {
              seen.reads += 1;
              return readOutcome;
            },
          };
          return {
            select: () => read,
            insert(values: Record<string, unknown>) {
              if (table === 'lead_activities') seen.activities.push(values);
              return { then: (resolve: (v: unknown) => unknown) => resolve({ error: null }) };
            },
            update(patch: Record<string, unknown>) {
              seen.patches.push(patch);
              const chain = {
                eq(column: string, value: unknown) {
                  seen.swapFilters.push([column, value]);
                  return chain;
                },
                in(column: string, values: unknown) {
                  seen.swapFilters.push([column, values]);
                  return chain;
                },
                is(column: string, value: unknown) {
                  seen.swapFilters.push([column, value]);
                  return chain;
                },
                select: () => chain,
                maybeSingle: async () => swapOutcome,
              };
              return chain;
            },
          };
        },
      };
    },
  };
}

mock.module('@/lib/auth/session', {
  exports: { requireInternal: async () => ({ role: 'owner', userId: 'u', organizationId: 'o' }) },
});
mock.module('@/lib/audit', {
  exports: {
    recordAudit: async (entry: Record<string, unknown>) => {
      seen.audits.push(entry);
    },
  },
});
mock.module('@/lib/events', { exports: { emitEvent: async () => {} } });
mock.module('@/lib/db/server', { exports: { createClient: async () => client() } });

const { markLeadConverted } = await import('../src/modules/crm/service.ts');

beforeEach(() => {
  swapOutcome = { data: { id: LEAD_ID, organization_id: 'org-1', status: 'converted' }, error: null };
  readOutcome = { data: null, error: null };
  seen.swapFilters = [];
  seen.patches = [];
  seen.reads = 0;
  seen.audits = [];
  seen.activities = [];
});

// ═══════════════════════════════════════════════════════════════════════════
// A. The write states what it decided against
// ═══════════════════════════════════════════════════════════════════════════

describe('A. the transition is in the write', () => {
  test('a qualified lead converts', async () => {
    const result = await markLeadConverted(LEAD_ID);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(seen.patches.length, 1);
    assert.equal(seen.patches[0]?.status, 'converted');
  });

  test('and the write restates the status, not only the id', async () => {
    await markLeadConverted(LEAD_ID);

    // The whole finding. Without this predicate the update matches whatever
    // the lead happens to be — including the two states where converting it
    // is wrong under any reading.
    assert.deepEqual(seen.swapFilters, [
      ['id', LEAD_ID],
      ['status', ['new', 'qualifying', 'qualified']],
      // Soft deletes: RLS does not filter them and neither did this write, so
      // a deleted lead was genuinely converted rather than skipped.
      ['deleted_at', null],
    ]);
  });

  test('it excludes exactly the two states that are wrong under any reading', async () => {
    await markLeadConverted(LEAD_ID);
    const allowed = seen.swapFilters.find(([column]) => column === 'status')?.[1] as string[];

    // `disqualified`: somebody rejected this lead after the deal was opened —
    // createOpportunity refuses to open one on a disqualified lead — so this
    // is a disagreement for a human, not something to overwrite.
    assert.ok(!allowed.includes('disqualified'));
    // `converted`: already done, and rewriting would move `converted_at`.
    assert.ok(!allowed.includes('converted'));
  });

  test('and it is wider than LEAD_TRANSITIONS on purpose, which is recorded', () => {
    // The map says a *person* may only move `qualified → converted`. This
    // function is not a person: createOpportunity opens deals on `new` and
    // `qualifying` leads, and those have always converted when the deal was
    // won. Narrowing here would strand them — a project whose lead still
    // reads `qualifying` — so the difference is deliberate and ADM-41 asks
    // which of the two the business actually wants.
    //
    // Asserted so that if the map is ever widened to match, this test fails
    // and the divergence is revisited rather than forgotten.
    const admits = Object.entries(LEAD_TRANSITIONS)
      .filter(([, to]) => (to as readonly string[]).includes('converted'))
      .map(([from]) => from);

    assert.deepEqual(admits, ['qualified']);
    assert.deepEqual(LEAD_TRANSITIONS.converted, [], 'converted is no longer terminal');
  });

  test('the conversion is audited — every other gated lead move is', async () => {
    await markLeadConverted(LEAD_ID);

    assert.equal(seen.audits.length, 1, 'the move that makes a prospect a client left no record');
    assert.equal(seen.audits[0]?.action, 'lead.converted');
    assert.equal(seen.audits[0]?.subjectId, LEAD_ID);
    // The organization comes from the row the swap returned, not from a
    // parameter a caller could get wrong.
    assert.equal(seen.audits[0]?.organizationId, 'org-1');
  });

  test('the conversion appears on the lead own timeline (G-087)', async () => {
    await markLeadConverted(LEAD_ID, 'user-1');

    assert.equal(seen.activities.length, 1, 'the moment the lead became a client is missing from it');
    const entry = seen.activities[0] ?? {};
    assert.equal(entry.kind, 'status_change');
    assert.equal(entry.lead_id, LEAD_ID);
    assert.equal(entry.actor_id, 'user-1');
  });

  test('and the caller names them, so the skip above is not the live path', async () => {
    // Without this the actor is optional in practice as well as in the
    // signature, and the timeline goes quiet again with every test still
    // green — the whole gap, restored.
    const sales = readFileSync(
      fileURLToPath(new URL('../src/modules/sales/service.ts', import.meta.url)),
      'utf8',
    );
    assert.match(sales, /markLeadConverted\(opportunity\.lead_id, context\.userId\)/);
  });

  test('and it is skipped rather than faked when nobody is named', async () => {
    // `actor_id` is what makes the row answerable. A row attributed to nobody
    // is worse than no row — and the audit entry is written either way, so
    // nothing is lost silently.
    await markLeadConverted(LEAD_ID);

    assert.deepEqual(seen.activities, []);
    assert.equal(seen.audits.length, 1, 'the audit row must not depend on the actor');
  });

  test('and it claims no `before`, because a returning update cannot know it', async () => {
    await markLeadConverted(LEAD_ID);

    // The row handed back is the row that was written, so its status is
    // already 'converted'. Recording that as the prior state would be a lie;
    // the accepted set is recorded instead.
    assert.equal('before' in (seen.audits[0] ?? {}), false);
    const after = seen.audits[0]?.after as Record<string, unknown>;
    assert.equal(after?.status, 'converted');
    assert.deepEqual(after?.convertedFrom, ['new', 'qualifying', 'qualified']);
  });

  test('nothing is audited when nothing moved', async () => {
    swapOutcome = { data: null, error: null };
    readOutcome = { data: { status: 'disqualified' }, error: null };

    await markLeadConverted(LEAD_ID, 'user-1');

    assert.deepEqual(seen.audits, [], 'a refused conversion was written into the history');
    assert.deepEqual(seen.activities, [], 'a refused conversion appeared on the timeline');
  });

  test('converted_at is stamped on the transition', async () => {
    await markLeadConverted(LEAD_ID);

    // crm.leads carries `leads_converted_at_set`: converted without a moment
    // is refused by the database.
    assert.ok(typeof seen.patches[0]?.converted_at === 'string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Nothing moved, and the reasons are not the same answer
// ═══════════════════════════════════════════════════════════════════════════

describe('B. a write that matched nothing', () => {
  beforeEach(() => {
    swapOutcome = { data: null, error: null };
  });

  test('a lead the machine forbids is refused, naming the state it is in', async () => {
    readOutcome = { data: { status: 'disqualified' }, error: null };

    const result = await markLeadConverted(LEAD_ID);

    assert.equal(result.ok, false, 'a disqualified lead was still forced to converted');
    if (result.ok) return;
    assert.equal(result.error.code, 'CONFLICT');
    assert.match(result.error.message, /disqualified/);
    // One patch was attempted and matched nothing; none was retried.
    assert.equal(seen.patches.length, 1);
  });

  test('but the swap admits new and qualifying, so today\'s flow is unchanged', async () => {
    // These reach the swap and match, so they never get here. Asserted from
    // the filter rather than by simulating, because the point is that the
    // predicate lets them through — a narrower fix would have stranded every
    // deal opened on a lead nobody had qualified yet.
    swapOutcome = { data: { id: LEAD_ID, organization_id: 'org-1', status: 'converted' }, error: null };
    await markLeadConverted(LEAD_ID);

    const allowed = seen.swapFilters.find(([column]) => column === 'status')?.[1] as string[];
    assert.ok(allowed.includes('new'));
    assert.ok(allowed.includes('qualifying'));
    assert.ok(allowed.includes('qualified'));
  });

  test('a soft-deleted lead is not converted', async () => {
    // It fails the swap on `deleted_at`, and the follow-up read filters it
    // too, so it reads as absent rather than producing a conflict about the
    // status of a lead nobody can see.
    readOutcome = { data: null, error: null };

    const result = await markLeadConverted(LEAD_ID);

    assert.equal(result.ok, false, 'a deleted lead was reported converted');
    assert.equal(result.ok === false && result.error.code, 'NOT_FOUND');
    assert.deepEqual(seen.audits, []);
  });

  test('a lead that no longer exists is NOT_FOUND, not success', async () => {
    readOutcome = { data: null, error: null };

    const result = await markLeadConverted(LEAD_ID);

    assert.equal(result.ok, false, 'a missing lead was reported converted');
    assert.equal(result.ok === false && result.error.code, 'NOT_FOUND');
  });

  test('a lead already converted is success, and is not written again', async () => {
    readOutcome = { data: { status: 'converted' }, error: null };

    const result = await markLeadConverted(LEAD_ID);

    assert.equal(result.ok, true, JSON.stringify(result));
    // The whole point of answering it here: `converted_at` is the only record
    // of when the lead became a client, and a second call must not move it.
    assert.equal(seen.patches.length, 1, 'a second write was attempted on an already-converted lead');
  });

  test('an unreadable database is not a lead in a wrong state', async () => {
    readOutcome = { data: null, error: { message: 'could not connect to server' } };

    const result = await markLeadConverted(LEAD_ID);

    assert.equal(result.ok, false);
    if (result.ok) return;
    // Not CONFLICT and not NOT_FOUND: both are statements about the lead, and
    // nothing was learned about the lead (D3, D5).
    assert.equal(result.error.code, 'INTERNAL');
    assert.notEqual(result.error.code, 'CONFLICT');
    assert.notEqual(result.error.code, 'NOT_FOUND');
    assert.doesNotMatch(result.error.message, /could not connect|server/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. The failed write itself
// ═══════════════════════════════════════════════════════════════════════════

describe('C. the swap fails outright', () => {
  test('it is reported, and no status is inferred from it', async () => {
    swapOutcome = { data: null, error: { message: 'permission denied for relation leads' } };

    const result = await markLeadConverted(LEAD_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    assert.doesNotMatch(
      result.ok === false ? result.error.message : '',
      /permission denied|relation/,
    );
    // No follow-up read: the write erroring says nothing about the lead, so
    // there is nothing to disambiguate.
    assert.equal(seen.reads, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. The harness can show a failure
// ═══════════════════════════════════════════════════════════════════════════

describe('D. the stub is capable of failing', () => {
  test('the follow-up read happens exactly once, and only when nothing moved', async () => {
    await markLeadConverted(LEAD_ID);
    assert.equal(seen.reads, 0, 'a successful swap should not need to ask why');

    swapOutcome = { data: null, error: null };
    readOutcome = { data: { status: 'converted' }, error: null };
    await markLeadConverted(LEAD_ID);
    assert.equal(seen.reads, 1);
  });
});
