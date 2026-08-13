import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * A won deal becoming a workspace — gap G-017, decision ADM-06.
 *
 * `convertToProject` created a client account, a project and a converted lead.
 * Document 10 §1 asks for rather more: sales context carried into a project
 * workspace "without making the client repeat information already provided."
 *
 * The guarantees live in Postgres and are proved against a real database by
 * `scripts/verify-onboarding.mjs` — 19 checks, watched failing first with the
 * completion constraint and the select policy removed. What is here is the
 * checklist pinned against the document it came from, the rules read out of
 * the migration, and the two behaviours of the conversion path that no live
 * script covers: which quotation is carried, and what happens when the
 * checklist cannot be created.
 */

const migration = readFileSync(
  fileURLToPath(
    new URL('../supabase/migrations/20260813120020_a_won_deal_becomes_a_workspace.sql', import.meta.url),
  ),
  'utf8',
);

const startConditions = readFileSync(
  fileURLToPath(
    new URL('../supabase/migrations/20260813120016_project_start_conditions.sql', import.meta.url),
  ),
  'utf8',
);

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

/** Document 10 §6, in its order. */
const DOCUMENT_ITEMS = [
  'client_identity_confirmed',
  'accepted_quotation_confirmed',
  'commercial_terms_confirmed',
  'payment_verified',
  'project_name_confirmed',
  'requirements_imported',
  'scope_version_created',
  'timeline_assumptions_recorded',
  'stakeholders_identified',
  'assets_requested',
  'design_references_requested',
  'technical_access_identified',
  'whatsapp_group_mapped',
  'project_manager_assigned',
  'specialist_agents_assigned',
  'kickoff_sent',
  'project_activated',
];

const OPPORTUNITY = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';

const seen = {
  createProject: [] as Record<string, unknown>[],
  seeded: [] as string[],
  proposalQuery: [] as Record<string, unknown>[],
};

/** The accepted proposal the conversion should find, or none. */
let acceptedProposal: { id: string; total_minor: number } | null = null;
let seedOk = true;

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({
      role: 'owner',
      userId: '44444444-4444-4444-8444-444444444444',
      organizationId: '55555555-5555-4555-8555-555555555555',
    }),
  },
});
mock.module('@/lib/audit', { exports: { recordAudit: async () => {} } });
mock.module('@/modules/crm/service', { exports: { markLeadConverted: async () => ({ ok: true, data: {} }) } });
mock.module('@/modules/projects/service', {
  exports: {
    createProject: async (input: Record<string, unknown>) => {
      seen.createProject.push(input);
      return { ok: true, data: { projectId: PROJECT } };
    },
    seedOnboarding: async (projectId: string) => {
      seen.seeded.push(projectId);
      return seedOk
        ? { ok: true, data: { items: 17, alreadySeeded: false } }
        : { ok: false, error: { code: 'INTERNAL', message: 'no' } };
    },
  },
});

/**
 * A query builder thin enough to record what was asked and answer it.
 *
 * The conversion reads three tables; only the proposal read is interesting
 * here, and its *shape* is the thing worth pinning — an unordered read would
 * pick an arbitrary accepted version.
 */
function builder(table: string) {
  const filters: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return chain;
    },
    is: () => chain,
    order: (col: string, opts: Record<string, unknown>) => {
      filters._order = `${col}:${opts?.ascending ? 'asc' : 'desc'}`;
      return chain;
    },
    limit: () => chain,
    insert: () => chain,
    update: () => chain,
    single: async () => ({ data: { id: ACCOUNT }, error: null }),
    maybeSingle: async () => {
      if (table === 'opportunities') {
        return {
          data: {
            id: OPPORTUNITY,
            name: 'Deal',
            stage: 'won',
            organization_id: 'org',
            lead_id: 'lead',
            client_account_id: ACCOUNT,
            value_minor: 999_999,
            currency: 'INR',
          },
          error: null,
        };
      }
      if (table === 'projects') return { data: null, error: null };
      if (table === 'proposals') {
        seen.proposalQuery.push({ ...filters });
        return { data: acceptedProposal, error: null };
      }
      return { data: null, error: null };
    },
  };
  return chain;
}

mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema: () => ({ from: (table: string) => builder(table) }),
    }),
  },
});

const { convertToProject } = await import('../src/modules/sales/service.ts');

beforeEach(() => {
  seen.createProject = [];
  seen.seeded = [];
  seen.proposalQuery = [];
  acceptedProposal = null;
  seedOk = true;
});

describe('A. the checklist is the document’s, not one somebody invented', () => {
  test('all seventeen of Document 10 §6’s items are seeded', () => {
    for (const key of DOCUMENT_ITEMS) {
      assert.ok(migration.includes(`'${key}'`), `${key} is in Document 10 §6 and not in the seed`);
    }
  });

  test('and they are seeded in the document’s order', () => {
    const seedFn = migration.slice(migration.indexOf('function projects.seed_onboarding'));
    const positions = DOCUMENT_ITEMS.map((key) => seedFn.indexOf(`'${key}'`));
    assert.ok(positions.every((p) => p > -1), 'an item is missing from the seed');
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
      'the seed list is not in the order Document 10 §6 gives',
    );
  });

  test('nothing is ticked on the agency’s behalf', () => {
    // Every item arrives pending. Pre-ticking "payment verified" because the
    // system happens to know it would be a claim the checklist cannot support.
    assert.match(migration, /status\s+text not null default 'pending'/);
    const seedFn = migration.slice(migration.indexOf('function projects.seed_onboarding'));
    const insert = seedFn.slice(0, seedFn.indexOf('get diagnostics'));
    assert.ok(!/'done'/.test(insert), 'the seed marks something done');
  });
});

/**
 * The migration's executable SQL: `--` lines and `COMMENT ON` bodies removed.
 *
 * Both kinds of prose explain at length *why* the checklist does not touch
 * ADM-13's start conditions, so both name `start_project`. The invariant is
 * about what runs, not about the word — asserting over the whole file fails on
 * the file's own explanation of itself, which is how this test first failed,
 * twice: once on a `--` comment and once on a COMMENT ON string, which is SQL
 * and so survived the first strip.
 */
const sql = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .replace(/comment on [\s\S]*?';/gi, '');

describe('B. it blocks nothing — the whole of ADM-06', () => {
  test('the stripped SQL is still the migration — the checks below are not vacuous', () => {
    // A strip that ate too much would turn every assertion in this block into
    // "the empty string does not contain X", which passes and proves nothing.
    assert.match(sql, /create table if not exists projects\.onboarding_items/);
    assert.match(sql, /function projects\.seed_onboarding/);
    assert.match(sql, /function projects\.set_onboarding_item/);
    assert.ok(sql.length > migration.length / 3, 'the strip removed most of the file');
  });

  test('the migration adds no gate function and no unmet condition', () => {
    assert.ok(!/unmet/i.test(sql), 'this migration contributes an unmet start condition');
    assert.ok(
      !/start_readiness|start_project/.test(sql),
      'this migration touches the start gate',
    );
  });

  test('the start conditions are still ADM-13’s three, and none of them is the checklist', () => {
    assert.match(startConditions, /advance_not_verified/);
    assert.match(startConditions, /no_approved_requirement/);
    assert.match(startConditions, /no_whatsapp_group/);
    assert.ok(
      !/onboarding_items|checklist/.test(startConditions),
      'the start gate learned about the checklist',
    );
  });

  test('nothing raises on an incomplete checklist', () => {
    // The assertion that would catch this feature quietly becoming a gate: no
    // function here refuses anything on the grounds of what is still pending.
    assert.ok(
      !/raise exception/i.test(sql),
      'a function in this migration refuses something',
    );
    const setFn = sql.slice(sql.indexOf('function projects.set_onboarding_item'));
    assert.ok(!/status <> 'done'|status = 'pending' then\s+return query select 'not/.test(setFn));
  });
});

describe('C. the rules the database holds', () => {
  test('a settled item knows when, and a pending one carries no half-answer', () => {
    assert.match(migration, /onboarding_items_completion_shape/);
    assert.match(migration, /when 'pending' then completed_at is null and completed_by is null/);
  });

  test('un-ticking clears who answered', () => {
    const setFn = migration.slice(migration.indexOf('function projects.set_onboarding_item'));
    assert.match(setFn, /completed_by = case when p_status = 'pending' then null/);
    assert.match(setFn, /completed_at = case when p_status = 'pending' then null/);
  });

  test('seeding is idempotent by the count, not only by the unique key', () => {
    // `on conflict do nothing` alone would reinstate an item somebody deleted.
    const seedFn = migration.slice(migration.indexOf('function projects.seed_onboarding'));
    assert.match(seedFn, /if v_existing > 0 then/);
    assert.match(seedFn, /already_seeded/);
  });

  test('the checklist is internal — a client never sees it', () => {
    const policy = migration.slice(migration.indexOf('policy onboarding_items_select'));
    assert.match(policy.slice(0, 400), /core\.is_internal\(\)/);
    assert.ok(!/is_client/.test(policy.slice(0, 400)), 'the client was given a way in');
  });
});

describe('D. what conversion carries', () => {
  test('the accepted quotation is linked, and its total becomes the budget', async () => {
    acceptedProposal = { id: 'prop-1', total_minor: 250_000 };

    const result = await convertToProject({ opportunityId: OPPORTUNITY, projectName: 'Build' });

    assert.ok(result.ok);
    const input = seen.createProject[0]!;
    assert.equal(input.proposalId, 'prop-1');
    assert.equal(
      input.budgetMinor,
      250_000,
      'the agreed total should win over the opportunity’s estimate',
    );
  });

  test('without an accepted quotation the conversion still happens', async () => {
    // Document 10 §2 says a project "should not be created" without one, and
    // ADM-13's three start conditions deliberately do not include it. Every
    // project raised before quotations existed has none; refusing here would
    // strand all of them. ADM-63 asks whether it should become a fourth.
    acceptedProposal = null;

    const result = await convertToProject({ opportunityId: OPPORTUNITY, projectName: 'Build' });

    assert.ok(result.ok);
    const input = seen.createProject[0]!;
    assert.equal(input.proposalId, null);
    assert.equal(input.budgetMinor, 999_999, 'it falls back to the opportunity’s value');
  });

  test('the accepted quotation read is ordered — a deal can have more than one', async () => {
    // `accepted` is terminal, so a deal re-quoted and re-accepted has several,
    // and an unordered read would pick an arbitrary one. The answer is the
    // latest version.
    acceptedProposal = { id: 'prop-2', total_minor: 1 };

    await convertToProject({ opportunityId: OPPORTUNITY, projectName: 'Build' });

    const query = seen.proposalQuery[0]!;
    assert.equal(query.status, 'accepted');
    assert.equal(query.opportunity_id, OPPORTUNITY);
    assert.equal(query._order, 'version:desc', 'the read must name which accepted version wins');
  });

  test('the checklist is created for the new project', async () => {
    await convertToProject({ opportunityId: OPPORTUNITY, projectName: 'Build' });
    assert.deepEqual(seen.seeded, [PROJECT]);
  });

  test('a checklist that could not be created does not undo the project', async () => {
    // ADM-06: it blocks nothing. Rolling back a created project over a list of
    // reminders would be the wrong trade in the other direction, and
    // seedOnboarding is idempotent, so re-running conversion repairs it.
    seedOk = false;

    const result = await convertToProject({ opportunityId: OPPORTUNITY, projectName: 'Build' });

    assert.ok(result.ok, 'the project is the durable outcome');
    assert.equal(result.data.projectId, PROJECT);
  });
});
