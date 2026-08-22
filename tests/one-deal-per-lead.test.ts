import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * Audit finding D21 — one deal per lead, held by the database.
 *
 * `createOpportunity` already meant to be idempotent: it reads
 * sales.opportunities by lead_id and returns the existing deal if it finds
 * one. But that read and the insert that follows are two statements with a
 * gap, and only a NON-unique index sat behind them
 * (20260807120005_sales.sql:37). Two clicks on "Open deal" both read nothing
 * and both insert.
 *
 * The second row is not merely a duplicate. The lead page renders one deal, so
 * the other is invisible while still being counted by anything that
 * aggregates — and each can be won and converted independently, because
 * `projects_opportunity_key` is keyed on the *opportunity* and therefore
 * permits both. One prospect, two projects, two client accounts: exactly the
 * outcome D9 exists to prevent, reached through the door D9 did not cover.
 *
 * Two halves, tested where each lives. The index is asserted against the
 * migration Postgres actually runs, and proved to refuse against a real
 * database in verify-schema.mjs §5 — five simultaneous inserts, one survivor.
 * The application's half, turning that refusal back into the answer the winner
 * got, is executed here with the database stubbed.
 */

// ── the stub ───────────────────────────────────────────────────────────────

type Res = { data: unknown; error: { code?: string; message: string } | null };

let leadRead: Res = { data: null, error: null };
/** The pre-check for an existing deal. */
let existingRead: Res = { data: null, error: null };
/** What the insert answers. */
let insertRes: Res = { data: { id: 'new-deal' }, error: null };
/** The re-read after losing the index. */
let winnerRead: Res = { data: null, error: null };
/** What a stage UPDATE answers. */
let updateRes: Res = { data: { id: 'moved' }, error: null };

const seen = {
  inserts: 0,
  opportunityReads: 0,
  patches: [] as Record<string, unknown>[],
  /** Every `.not(col, op, value)` the service applied, in order (G-088). */
  filters: [] as string[],
};

function client() {
  return {
    schema() {
      return {
        from(table: string) {
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: () => chain,
            is: () => chain,
            not: (col: string, op: string, value: string) => {
              seen.filters.push(`${col} ${op} ${value}`);
              return chain;
            },
            limit: () => chain,
            order: () => chain,
            maybeSingle: async () => {
              if (table === 'leads') return leadRead;
              if (table === 'opportunities') {
                seen.opportunityReads += 1;
                // The first read is the pre-check; any later one is the
                // re-read after the index refused the insert.
                return seen.opportunityReads === 1 ? existingRead : winnerRead;
              }
              return { data: null, error: null };
            },
            single: async () => insertRes,
          };
          return {
            ...chain,
            insert: () => {
              if (table === 'opportunities') seen.inserts += 1;
              return chain;
            },
            update: (values: Record<string, unknown>) => {
              seen.patches.push(values);
              const patch: Record<string, unknown> = {
                eq: () => patch,
                select: () => patch,
                maybeSingle: async () => updateRes,
              };
              return patch;
            },
          };
        },
      };
    },
  };
}

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({ role: 'owner', userId: 'u', organizationId: 'org-1' }),
  },
});
mock.module('@/lib/audit', { exports: { recordAudit: async () => {} } });
mock.module('@/lib/db/server', { exports: { createClient: async () => client() } });

const { createOpportunity, setOpportunityStage } = await import(
  '../src/modules/sales/service.ts'
);
const { SETTLED_OPPORTUNITY_STAGES, OPPORTUNITY_STAGES, isOpenOpportunity } = await import(
  '../src/modules/sales/schema.ts'
);

const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const input = { leadId: LEAD_ID, name: 'A website', valueMinor: 500_000 };

/** The unique violation Postgres raises when the index refuses the insert. */
const lost = {
  data: null,
  error: {
    code: '23505',
    message:
      'duplicate key value violates unique constraint "opportunities_open_lead_key"',
  },
};

beforeEach(() => {
  leadRead = { data: { id: LEAD_ID, organization_id: 'org-1', status: 'qualifying' }, error: null };
  existingRead = { data: null, error: null };
  insertRes = { data: { id: 'new-deal' }, error: null };
  winnerRead = { data: null, error: null };
  updateRes = { data: { id: 'moved' }, error: null };
  seen.inserts = 0;
  seen.filters = [];
  seen.opportunityReads = 0;
  seen.patches = [];
});

// ═══════════════════════════════════════════════════════════════════════════
// A. Losing the index is an answer, not an error
// ═══════════════════════════════════════════════════════════════════════════

describe('A. the click that loses the race', () => {
  test('gets the deal that won, not a failure', async () => {
    insertRes = lost;
    winnerRead = { data: { id: 'winner' }, error: null };

    const result = await createOpportunity(input);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.ok === true && result.data.opportunityId, 'winner');
  });

  test('which is the same answer the pre-check gives when it is not racing', async () => {
    // The two paths must agree, or a double-click returns different things
    // depending on how fast the second one was.
    existingRead = { data: { id: 'winner' }, error: null };

    const alone = await createOpportunity(input);
    assert.equal(alone.ok === true && alone.data.opportunityId, 'winner');
    assert.equal(seen.inserts, 0, 'the pre-check should not have inserted');
  });

  test('and no second deal is left behind', async () => {
    insertRes = lost;
    winnerRead = { data: { id: 'winner' }, error: null };

    await createOpportunity(input);

    // One insert attempted, refused by the index. Nothing retried it.
    assert.equal(seen.inserts, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. What it does not swallow
// ═══════════════════════════════════════════════════════════════════════════

describe('B. the refusals it must not absorb', () => {
  test('a 23505 from some other constraint is still an error', async () => {
    // Matching on the code alone would answer a future unique constraint with
    // a re-read that finds nothing, and report a deal that does not exist.
    insertRes = {
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "some_other_key"' },
    };

    const result = await createOpportunity(input);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
  });

  test('losing the index but finding no winner is reported, not called success', async () => {
    // The index says a row exists and this cannot see it. Returning ok would
    // mean returning no id at all.
    insertRes = lost;
    winnerRead = { data: null, error: null };

    const result = await createOpportunity(input);

    assert.equal(result.ok, false, 'a conversion with no opportunity id was reported as success');
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
  });

  test('an ordinary insert failure is still INTERNAL', async () => {
    insertRes = { data: null, error: { code: '42501', message: 'permission denied' } };

    const result = await createOpportunity(input);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    assert.doesNotMatch(
      result.ok === false ? result.error.message : '',
      /permission denied/,
    );
  });

  test('a disqualified lead is still refused before any of this', async () => {
    leadRead = { data: { id: LEAD_ID, organization_id: 'org-1', status: 'disqualified' }, error: null };

    const result = await createOpportunity(input);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    assert.equal(seen.inserts, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B2. Reopening a settled deal can now hit the same index
// ═══════════════════════════════════════════════════════════════════════════

describe('B2. reopening a deal the lead has outgrown', () => {
  const reopen = { opportunityId: '22222222-2222-4222-8222-222222222222', stage: 'discovery' as const };

  beforeEach(() => {
    // A lost deal, which OPPORTUNITY_TRANSITIONS allows back to discovery.
    existingRead = { data: { id: reopen.opportunityId, stage: 'lost', organization_id: 'org-1' }, error: null };
  });

  test('is refused in the lead\'s own terms, not as a generic failure', async () => {
    // Narrowing the index to open deals created this path: reopening makes
    // this deal open, and the lead may already have another one. Before the
    // branch it surfaced as "Could not move the deal", which tells the
    // operator nothing they can act on.
    updateRes = {
      data: null,
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "opportunities_open_lead_key"',
      },
    };

    const result = await setOpportunityStage(reopen);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'CONFLICT');
    assert.match(result.error.message, /already has an open deal/);
    assert.doesNotMatch(result.error.message, /Could not move the deal/);
  });

  test('and any other write failure is still INTERNAL', async () => {
    updateRes = { data: null, error: { code: '42501', message: 'permission denied' } };

    const result = await setOpportunityStage(reopen);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
  });

  test('an ordinary reopen still works', async () => {
    const result = await setOpportunityStage(reopen);
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  // ── G-089: what a reopened deal stops carrying ──────────────────────────

  test('and it clears the date it closed and the reason it was lost', async () => {
    // Gap G-089, and exactly the shape D13 fixed for `disqualified_reason` on
    // a lead. Both columns were only ever written when moving *to* a terminal
    // stage, so a reopened deal read as `discovery` while still carrying the
    // day it closed and why it was lost. `opportunities_closed_at_set` only
    // requires the date when the stage is terminal, so nothing objected — and
    // anything reporting on closed deals, or on why deals are lost, counted a
    // live one.
    await setOpportunityStage(reopen);

    const written = seen.patches.at(-1) ?? {};
    assert.equal(written.stage, 'discovery');
    assert.equal(written.closed_at, null, 'the reopened deal still carries its close date');
    assert.equal(written.lost_reason, null, 'the reopened deal still carries its loss reason');
    // Doc 09 §25's category goes with them, or every report of why deals are
    // lost counts a deal that is back in the pipeline.
    assert.equal(written.lost_category, null, 'the reopened deal still carries the category it was lost under');
  });

  test('while settling a deal still records all three', async () => {
    // The clearing must not have been bought by breaking the way in.
    existingRead = { data: { id: reopen.opportunityId, stage: 'negotiation', organization_id: 'org-1' }, error: null };

    await setOpportunityStage({
      opportunityId: reopen.opportunityId,
      stage: 'lost',
      lostReason: 'budget',
      lostCategory: 'no_budget',
    });

    const written = seen.patches.at(-1) ?? {};
    assert.equal(written.stage, 'lost');
    assert.equal(written.lost_reason, 'budget');
    assert.equal(written.lost_category, 'no_budget');
    assert.ok(typeof written.closed_at === 'string', 'a lost deal must record when it closed');
  });

  /**
   * Doc 09 §38: *"LOST requires a reason."* Both halves — the sentence a
   * person reads and the category a report counts, because §37 asks for a
   * distribution and prose does not group.
   */
  test('and a loss with only half a reason is refused', async () => {
    existingRead = { data: { id: reopen.opportunityId, stage: 'negotiation', organization_id: 'org-1' }, error: null };

    const noCategory = await setOpportunityStage({
      opportunityId: reopen.opportunityId,
      stage: 'lost',
      lostReason: 'budget',
    });
    assert.equal(noCategory.ok, false, 'a reason nobody can count is half a reason');

    const noWords = await setOpportunityStage({
      opportunityId: reopen.opportunityId,
      stage: 'lost',
      lostCategory: 'no_budget',
    });
    assert.equal(noWords.ok, false, 'a category with no words loses what anybody learns from');
  });

  test('and an ordinary move touches neither', async () => {
    // discovery → proposal is neither settling nor reopening. Writing nulls
    // there would erase nothing today, but it would mean the patch no longer
    // says what the transition was.
    existingRead = { data: { id: reopen.opportunityId, stage: 'discovery', organization_id: 'org-1' }, error: null };

    await setOpportunityStage({ opportunityId: reopen.opportunityId, stage: 'proposal' });

    const written = seen.patches.at(-1) ?? {};
    assert.equal(written.stage, 'proposal');
    assert.equal('closed_at' in written, false);
    assert.equal('lost_reason' in written, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. The index itself
// ═══════════════════════════════════════════════════════════════════════════

describe('C. the rule is held by the database', () => {
  const migration = readFileSync(
    fileURLToPath(
      new URL('../supabase/migrations/20260812120006_one_deal_per_lead.sql', import.meta.url),
    ),
    'utf8',
  );

  const executable = migration
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  test('a unique index, not another ordinary one', () => {
    assert.match(
      executable,
      /create unique index[\s\S]{0,120}on sales\.opportunities \(lead_id\)/,
    );
  });

  test('partial, so a deal raised without a lead is unaffected', () => {
    assert.match(executable, /where lead_id is not null/);
  });

  test('it counts OPEN deals only, and that is the whole scope decision', () => {
    // The first draft had no stage predicate. It closed the same race — both
    // racing inserts are `stage: 'discovery'` — and would have cemented "one
    // deal per lead, ever" into DDL. That is contradicted by the primary
    // ingest path: WhatsApp keys a lead to a phone number permanently, so a
    // returning client lands on the same lead and could never have a second
    // engagement recorded.
    assert.match(executable, /where lead_id is not null and stage not in \('won', 'lost'\)/);
  });

  test('and it refuses legibly on a database that already raced', () => {
    // CREATE UNIQUE INDEX on existing duplicates fails with "Key (lead_id)=(…)
    // is duplicated" and nothing else — and that is exactly the population
    // this migration exists for. Which duplicate survives is a judgement, so
    // it stops with the lead ids rather than choosing.
    assert.match(executable, /raise exception/);
    assert.match(executable, /D21: these leads already carry more than one open deal/);
  });

  test('the service recognises it by name rather than guessing', () => {
    const service = readFileSync(
      fileURLToPath(new URL('../src/modules/sales/service.ts', import.meta.url)),
      'utf8',
    );
    assert.match(service, /opportunities_open_lead_key/);
    assert.match(service, /'23505'/);
  });

  test('it changes no table', () => {
    assert.doesNotMatch(executable, /create table|alter table|drop table|drop constraint/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G-088 — a settled deal does not block the next engagement
// ═══════════════════════════════════════════════════════════════════════════

describe('G-088 — the pre-check asks about OPEN deals only', () => {
  const migration = readFileSync(
    fileURLToPath(new URL('../supabase/migrations/20260812120006_one_deal_per_lead.sql', import.meta.url)),
    'utf8',
  );

  test('the constant and the index agree on what "settled" means', () => {
    // The index is the authority. This mirrors it so the application does not
    // spell the same rule out at each call site — the arrangement
    // LIVE_PROPOSAL_STATUSES has with proposals_live_version_key — and if the
    // two ever drift, "does this lead have a deal?" starts answering
    // differently in the database and in the code.
    for (const stage of SETTLED_OPPORTUNITY_STAGES) {
      assert.match(migration, new RegExp(`'${stage}'`), `${stage} is in the constant, not the index`);
    }
    assert.match(migration, /stage not in \('won', 'lost'\)/);
  });

  test('isOpenOpportunity is the inverse, for every stage the table admits', () => {
    for (const stage of OPPORTUNITY_STAGES) {
      assert.equal(
        isOpenOpportunity(stage),
        !['won', 'lost'].includes(stage),
        `${stage} is classified wrongly`,
      );
    }
  });

  test('the pre-check excludes settled deals', async () => {
    // The defect: this read had no stage filter, so a lead whose only deal was
    // lost handed that lost deal back and the second engagement could never be
    // opened. The database had already stopped forbidding it (D21's partial
    // index); this is what still did.
    leadRead = { data: { id: LEAD_ID, organization_id: 'org-1', status: 'qualified' }, error: null };
    existingRead = { data: null, error: null };

    await createOpportunity(input);

    assert.ok(
      seen.filters.some((f) => f === 'stage in (won,lost)'),
      `the pre-check did not exclude settled deals — filters were ${JSON.stringify(seen.filters)}`,
    );
  });

  test('and so does the re-read after the index refuses an insert', async () => {
    // Same rule, same reason: the index that was violated is the OPEN one, so
    // the row it refused this insert for is an open deal. Reading without the
    // filter could answer with a settled deal that had nothing to do with it.
    leadRead = { data: { id: LEAD_ID, organization_id: 'org-1', status: 'qualified' }, error: null };
    existingRead = { data: null, error: null };
    insertRes = lost;
    winnerRead = { data: { id: 'the-open-one' }, error: null };

    const result = await createOpportunity(input);

    assert.ok(result.ok);
    assert.equal(result.data.opportunityId, 'the-open-one');
    assert.equal(
      seen.filters.filter((f) => f === 'stage in (won,lost)').length,
      2,
      'both the pre-check and the re-read must filter',
    );
  });

  test('an open deal is still handed back rather than duplicated', async () => {
    // The half that must NOT change: a genuinely open deal still blocks, and
    // still answers idempotently rather than erroring.
    leadRead = { data: { id: LEAD_ID, organization_id: 'org-1', status: 'qualified' }, error: null };
    existingRead = { data: { id: 'already-open' }, error: null };

    const result = await createOpportunity(input);

    assert.ok(result.ok);
    assert.equal(result.data.opportunityId, 'already-open');
    assert.equal(seen.inserts, 0, 'a second deal was inserted while one was open');
  });
});
