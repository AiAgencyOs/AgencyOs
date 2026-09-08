import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * The quotation offers a choice — G-166, ADM-97.
 *
 * A HIGH-complexity engagement can now show a client 2-3 priced plans and let
 * them pick (Master Quotation System Part H). A plan-set sits above proposals:
 * each plan is a real proposal row, the set binds them into one offer with one
 * recommended plan whose price selects the approver.
 *
 * These pin the decisions the migration makes — the shape, the 2-3 cap, the
 * required recommendation, the one-approval-per-offer wiring, the live-key
 * reconciliation, and the zero-regression promise for a standalone quote. The
 * BEHAVIOUR (draft → submit → approve → send → the client picks one → the
 * chosen plan accepted and its siblings superseded) is proved against real
 * Postgres in scripts/verify-plan-set.mjs. A state machine over a guard is
 * exactly the thing that reads correct and behaves otherwise, so the guard's
 * branches are asserted here against the actual code and re-run live there.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const MIGRATION_RAW = read('supabase/migrations/20260907150000_the_quotation_offers_a_choice.sql');
const MIGRATION = sqlCode(MIGRATION_RAW);
const SCHEMA = read('src/modules/sales/schema.ts');
const SCHEMA_CODE = codeOnly(SCHEMA);

// The guard body, sliced from the code region so string-literal prose does not
// pollute the absence checks.
const GUARD = MIGRATION.slice(
  MIGRATION.indexOf('create or replace function sales.proposals_guard()'),
  MIGRATION.indexOf('comment on function sales.proposals_guard()'),
);

const fn = (name: string) => {
  const start = MIGRATION.indexOf(`create or replace function sales.${name}`);
  assert.ok(start >= 0, `function ${name} missing`);
  return MIGRATION.slice(start, MIGRATION.indexOf('$$;', start));
};

describe('A. the plan-set table, above proposals', () => {
  test('the table exists, org-scoped, cascading from the opportunity', () => {
    assert.match(MIGRATION, /create table if not exists sales\.proposal_plan_sets/);
    assert.match(MIGRATION, /organization_id\s+uuid not null references core\.organizations\(id\) on delete cascade/);
    assert.match(MIGRATION, /opportunity_id\s+uuid not null references sales\.opportunities\(id\) on delete cascade/);
  });

  test('the recommended and chosen plans point at real proposal rows', () => {
    assert.match(MIGRATION, /recommended_proposal_id uuid references sales\.proposals\(id\) on delete set null/);
    assert.match(MIGRATION, /chosen_proposal_id\s+uuid references sales\.proposals\(id\) on delete set null/);
  });

  test('the set status vocabulary is the full lifecycle', () => {
    const decl = MIGRATION.slice(MIGRATION.indexOf('status                 text not null default'));
    for (const s of ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected', 'superseded', 'lapsed']) {
      assert.ok(decl.includes(`'${s}'`), `set status missing ${s}`);
    }
  });

  test('one live SET per opportunity — the mirror of proposals_live_version_key', () => {
    assert.match(MIGRATION, /create unique index if not exists plan_sets_live_key\s+on sales\.proposal_plan_sets \(opportunity_id\)\s+where status in \('draft', 'pending_approval', 'approved', 'sent'\)/);
  });

  test('RLS is on, both policies present', () => {
    assert.match(MIGRATION, /alter table sales\.proposal_plan_sets enable row level security/);
    assert.match(MIGRATION, /create policy proposal_plan_sets_select on sales\.proposal_plan_sets/);
    assert.match(MIGRATION, /create policy proposal_plan_sets_write on sales\.proposal_plan_sets/);
  });
});

describe('B. tenancy guards — every org-scoped FK, or db:verify:tenancyguards fails', () => {
  // core.unguarded_org_fks demands a guard for each single-column FK whose
  // parent also carries organization_id: opportunity, requirement version, the
  // recommended and chosen plans, and the responding contact.
  for (const [trigger, parent] of [
    ['org_match_plan_sets_opportunity', 'sales.opportunities'],
    ['org_match_plan_sets_requirement', 'crm.requirement_versions'],
    ['org_match_plan_sets_recommended', 'sales.proposals'],
    ['org_match_plan_sets_chosen', 'sales.proposals'],
    ['org_match_plan_sets_contact', 'crm.contacts'],
  ] as const) {
    test(`${trigger} guards against ${parent}`, () => {
      assert.ok(
        MIGRATION.includes(`create trigger ${trigger}`),
        `trigger ${trigger} missing`,
      );
      assert.ok(
        MIGRATION.includes(`enforce_parent_org('`) && MIGRATION.includes(`', '${parent}')`),
        `guard for ${parent} missing`,
      );
    });
  }

  test('organization_id is frozen and updated_at is stamped', () => {
    assert.match(MIGRATION, /create trigger freeze_org_plan_sets[\s\S]*?core\.freeze_organization_id\(\)/);
    assert.match(MIGRATION, /create trigger set_updated_at[\s\S]*?core\.set_updated_at\(\)/);
  });

  test('the new proposals FK (plan_set_id) is guarded too', () => {
    assert.match(MIGRATION, /create trigger org_match_proposals_plan_set_id/);
    assert.ok(MIGRATION.includes(`enforce_parent_org('plan_set_id', 'sales.proposal_plan_sets')`));
  });
});

describe('C. each plan is a real proposal row', () => {
  test('the membership columns are added, nullable so slot-0 quotes are untouched', () => {
    assert.match(MIGRATION, /add column if not exists plan_set_id uuid references sales\.proposal_plan_sets\(id\) on delete set null/);
    assert.match(MIGRATION, /add column if not exists plan_slot\s+int\s+check \(plan_slot between 1 and 3\)/);
    assert.match(MIGRATION, /add column if not exists plan_label\s+text/);
  });

  test('the live-version key is re-keyed to (opportunity_id, coalesce(plan_slot, 0))', () => {
    assert.match(MIGRATION, /drop index if exists sales\.proposals_live_version_key/);
    assert.match(MIGRATION, /create unique index if not exists proposals_live_version_key\s+on sales\.proposals \(opportunity_id, coalesce\(plan_slot, 0\)\)/);
  });
});

describe('D. the guard carries the plan-set through — verbatim + marked edits', () => {
  test('plan_set_id / plan_slot / plan_label join the frozen-once-out-of-draft terms', () => {
    const frozen = GUARD.slice(GUARD.indexOf("if old.status <> 'draft' then"));
    assert.match(frozen, /new\.plan_set_id\s+is distinct from old\.plan_set_id/);
    assert.match(frozen, /new\.plan_slot\s+is distinct from old\.plan_slot/);
    assert.match(frozen, /new\.plan_label\s+is distinct from old\.plan_label/);
  });

  test('a plan-set member enters review through its SET, not a request of its own', () => {
    // The pending_approval branch verifies against the set's approval request,
    // whose subject is the recommended plan.
    assert.match(GUARD, /new\.plan_set_id is not null then[\s\S]*?proposal_plan_sets s[\s\S]*?s\.status = 'pending_approval'[\s\S]*?r\.subject_id = s\.recommended_proposal_id[\s\S]*?r\.state = 'pending'/);
  });

  test('a plan-set member is approved only when its set is', () => {
    assert.match(GUARD, /s\.status = 'approved'[\s\S]*?r\.subject_id = s\.recommended_proposal_id[\s\S]*?r\.state = 'approved'/);
  });

  test('the standalone (slot-0) path still verifies against its own request — no regression', () => {
    // The elsif branch: plan_set_id null falls through to the original check.
    assert.match(GUARD, /r\.subject_type = 'proposal' and r\.subject_id = new\.id\s+and r\.state = 'pending'/);
    assert.match(GUARD, /r\.subject_type = 'proposal' and r\.subject_id = new\.id\s+and r\.state = 'approved'/);
  });

  test('superseded stays reachable from any non-terminal state', () => {
    assert.match(GUARD, /elsif new\.status = 'superseded' then[\s\S]*?null;/);
  });
});

describe('E. one offer, one approval — submit reuses the proposal money-floor', () => {
  const SUBMIT = fn('submit_plan_set');

  test('the approval subject is the recommended plan, type still proposal', () => {
    assert.match(SUBMIT, /request_approval\(/);
    assert.match(SUBMIT, /'proposal',\s*\n\s*v_set\.recommended_proposal_id/);
  });

  test('the amount is the recommended plan total — so the same ladder resolves the approver', () => {
    assert.match(SUBMIT, /v_recommended\.total_minor,\s*\n\s*'internal'/);
  });

  test('a set with no recommendation is refused', () => {
    assert.match(SUBMIT, /if v_set\.recommended_proposal_id is null then[\s\S]*?'no_recommended'/);
  });

  test('an unpriced member is refused', () => {
    assert.match(SUBMIT, /total_minor <= 0[\s\S]*?'no_items'/);
  });

  test('no policy is not a default-open', () => {
    assert.match(SUBMIT, /v_approval\.outcome = 'no_policy'[\s\S]*?'no_policy'/);
  });
});

describe('F. acceptance mints one winner', () => {
  const CHOICE = fn('record_plan_set_choice');

  test('the chosen member becomes accepted, its siblings superseded', () => {
    // Siblings first: superseded where id <> chosen.
    assert.match(CHOICE, /update sales\.proposals\s+set status = 'superseded'\s+where plan_set_id = v_set\.id\s+and id <> v_chosen\.id/);
    // The winner: accepted.
    assert.match(CHOICE, /set status\s+= 'accepted'/);
  });

  test('the set records the choice and settles accepted', () => {
    assert.match(CHOICE, /update sales\.proposal_plan_sets\s+set status\s+= 'accepted',\s+chosen_proposal_id\s+= v_chosen\.id/);
  });

  test('plan_set.accepted carries the CHOSEN plan total — the close path sees one winner', () => {
    assert.match(CHOICE, /emit_event\([\s\S]*?'plan_set\.accepted'[\s\S]*?'chosenProposalId', v_chosen\.id[\s\S]*?'totalMinor', v_chosen\.total_minor/);
  });

  test('a plan from another offer, or an already-settled sibling, is refused', () => {
    assert.match(CHOICE, /v_chosen\.plan_set_id is distinct from v_set\.id[\s\S]*?'not_a_member'/);
  });

  test('a plan past its validity date cannot be the winner', () => {
    assert.match(CHOICE, /v_chosen\.valid_until <[\s\S]*?'expired'/);
  });

  test('no member is deleted — acceptance is a state change, not a removal', () => {
    assert.doesNotMatch(CHOICE, /delete from sales\.proposals/);
  });
});

describe('G. the whole offer can be declined', () => {
  const RESP = fn('record_plan_set_response');

  test('only "rejected" — accepting is choosing a plan', () => {
    assert.match(RESP, /if p_response <> 'rejected' then[\s\S]*?'invalid_response'/);
  });

  test('every live member and the set move to rejected, plan_set.rejected fires', () => {
    assert.match(RESP, /update sales\.proposals\s+set status\s+= 'rejected'/);
    assert.match(RESP, /update sales\.proposal_plan_sets\s+set status\s+= 'rejected'/);
    assert.match(RESP, /'plan_set\.rejected'/);
  });
});

describe('H. one live offer per deal — across both kinds', () => {
  test('the three plan-set events are declared in the closed registry', () => {
    const stmt = MIGRATION.slice(
      MIGRATION.indexOf('into core.event_types'),
      MIGRATION.indexOf('on conflict (type) do nothing'),
    );
    for (const e of ['plan_set.sent', 'plan_set.accepted', 'plan_set.rejected']) {
      assert.ok(stmt.includes(`'${e}'`), `event ${e} not declared`);
    }
  });

  test('draft_proposal supersedes a live plan-set before a standalone quote takes the floor', () => {
    const DRAFT = fn('draft_proposal');
    assert.match(DRAFT, /supersede_plan_set\(s\.id[\s\S]*?from sales\.proposal_plan_sets s[\s\S]*?s\.status in \('draft', 'pending_approval', 'approved', 'sent'\)/);
    // And it only supersedes the standalone (slot-0) live version thereafter.
    assert.match(DRAFT, /p\.plan_set_id is null\s+and p\.status in/);
  });

  test('draft_plan_set supersedes a live set and a live standalone, under the lock', () => {
    const DRAFT = fn('draft_plan_set');
    assert.match(DRAFT, /for update/);
    assert.match(DRAFT, /supersede_plan_set\(s\.id/);
    assert.match(DRAFT, /p\.plan_set_id is null[\s\S]*?status = 'superseded'/);
  });

  test('the 2-3 cap and the in-range recommendation are refused at draft time', () => {
    const DRAFT = fn('draft_plan_set');
    assert.match(DRAFT, /v_count < 2 or v_count > 3[\s\S]*?'bad_count'/);
    assert.match(DRAFT, /p_recommended_slot > v_count[\s\S]*?'bad_recommended'/);
  });

  test('supersede_plan_set cancels the set approval and moves members through the guard', () => {
    const SUP = fn('supersede_plan_set');
    assert.match(SUP, /approvals\.cancel_request\(/);
    assert.match(SUP, /update sales\.proposals\s+set status = 'superseded'\s+where plan_set_id = v_set\.id/);
  });
});

describe('I. the schema vocabulary mirrors the database', () => {
  test('PLAN_SET_STATUSES matches the table CHECK', () => {
    for (const s of ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected', 'superseded', 'lapsed']) {
      assert.ok(SCHEMA_CODE.includes(`'${s}'`), `PLAN_SET_STATUSES missing ${s}`);
    }
    assert.match(SCHEMA_CODE, /export const PLAN_SET_STATUSES/);
  });

  test('the 2-3 cap is a shared constant, enforced in the draft schema', () => {
    assert.match(SCHEMA_CODE, /PLAN_SET_MIN_PLANS = 2/);
    assert.match(SCHEMA_CODE, /PLAN_SET_MAX_PLANS = 3/);
    assert.match(SCHEMA_CODE, /\.min\(PLAN_SET_MIN_PLANS\)\.max\(PLAN_SET_MAX_PLANS\)/);
  });

  test('the recommendation is required and validated against the plan count', () => {
    assert.match(SCHEMA_CODE, /recommendedSlot: z\.number\(\)\.int\(\)\.min\(1\)/);
    assert.match(SCHEMA_CODE, /recommendedSlot <= v\.plans\.length/);
  });

  test('the whole-offer response schema takes only "rejected"', () => {
    assert.match(SCHEMA_CODE, /recordPlanSetResponseSchema[\s\S]*?response: z\.literal\('rejected'\)/);
  });
});

describe('J. the migration reloads PostgREST and grants nothing to public', () => {
  test("notify pgrst 'reload schema' is the last word", () => {
    assert.match(MIGRATION, /notify pgrst, 'reload schema';/);
  });

  test('every set-level writer is revoked from public and granted to the two roles', () => {
    for (const sig of [
      'sales.draft_plan_set(uuid, jsonb, int, uuid, uuid)',
      'sales.submit_plan_set(uuid, uuid, text)',
      'sales.send_plan_set(uuid, uuid, text)',
      'sales.record_plan_set_choice(uuid, uuid, uuid, text)',
      'sales.record_plan_set_response(uuid, text, uuid, text)',
      'sales.sync_plan_set_decision(uuid)',
      'sales.supersede_plan_set(uuid, text)',
    ]) {
      assert.ok(MIGRATION.includes(`revoke all on function ${sig} from public`), `no revoke for ${sig}`);
      assert.ok(MIGRATION.includes(`grant execute on function ${sig} to authenticated, service_role`), `no grant for ${sig}`);
    }
  });
});
