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

const seen = { inserts: 0, opportunityReads: 0, patches: [] as Record<string, unknown>[] };

function client() {
  return {
    schema() {
      return {
        from(table: string) {
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: () => chain,
            is: () => chain,
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
mock.module('@/lib/events', { exports: { emitEvent: async () => {} } });
mock.module('@/lib/db/server', { exports: { createClient: async () => client() } });

const { createOpportunity, setOpportunityStage } = await import(
  '../src/modules/sales/service.ts'
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
  });

  test('while settling a deal still records both', async () => {
    // The clearing must not have been bought by breaking the way in.
    existingRead = { data: { id: reopen.opportunityId, stage: 'negotiation', organization_id: 'org-1' }, error: null };

    await setOpportunityStage({ opportunityId: reopen.opportunityId, stage: 'lost', lostReason: 'budget' });

    const written = seen.patches.at(-1) ?? {};
    assert.equal(written.stage, 'lost');
    assert.equal(written.lost_reason, 'budget');
    assert.ok(typeof written.closed_at === 'string', 'a lost deal must record when it closed');
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
