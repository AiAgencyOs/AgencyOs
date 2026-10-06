import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';

/**
 * Phase 6 (Master QA). Behavioural proof: scripts/verify-phase-four-e2e.sql (the whole journey, real Postgres, red-proven). These are the text-level
 * guards that the pieces are reachable and the hard rules stay written down.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const subs = SUBSCRIPTIONS as Record<string, readonly string[]>;
const kinds = HANDLER_JOB_KIND as Record<string, string>;
const workspace = read('supabase/migrations/20261101100000_phase_six_starts_from_a_validated_intake.sql');
const plan = read('supabase/migrations/20261101110000_the_master_test_plan_covers_every_requirement.sql');
const defects = read('supabase/migrations/20261101120000_a_defect_is_triaged_handed_off_and_retested_on_the_fixed_build.sql');
const internal = read('supabase/migrations/20261101090000_phase_five_records_are_internal_only.sql');

describe('Phase 5 internal records are not readable by a portal client', () => {
  test('every internal table is tightened to is_internal()', () => {
    for (const table of ['code_reviews', 'build_runs', 'integration_connections', 'phase_five_handoffs', 'development_plans', 'technical_documents', 'flaky_tests']) {
      assert.ok(internal.includes(`'${table}'`), table);
    }
    assert.match(internal, /\(select core\.is_internal\(\)\)/);
  });
});

describe('Phase 6 workspace and intake', () => {
  test('the states are the spec\'s, verbatim', () => {
    for (const state of ['waiting_m3_verified', 'ready', 'intake_validating', 'plan_ready', 'testing', 'defect_fix_loop', 'final_verification', 'admin_review', 'blocked', 'phase6_completed', 'm4_due', 'phase7_financially_ready']) {
      assert.ok(workspace.includes(`'${state}'`), state);
    }
  });
  test('the intake refuses a different build, stale scope/UI and a missing M3 gate, with typed blockers', () => {
    for (const text of ['blocked_build', 'blocked_scope', 'blocked_finance', 'resumeCondition', 'tied to a different build', 'no longer locked']) assert.ok(workspace.includes(text), text);
  });
  test('Phase 6 is created waiting and becomes ready once, on the verified payment', () => {
    assert.match(workspace, /waiting_m3_verified/);
    assert.ok((subs['project.phase_five_completed'] ?? []).includes('projects:startPhaseSix'));
    assert.ok((subs['project.m3_payment_verified'] ?? []).includes('projects:startPhaseSix'));
    assert.deepEqual(subs['project.phase_six_ready'], ['projects:validateQaIntake', 'crm:announcePhaseSixReady']);
    for (const h of ['projects:startPhaseSix', 'projects:validateQaIntake', 'crm:announcePhaseSixReady']) assert.ok((HANDLERS as readonly string[]).includes(h), h);
    assert.equal(kinds['projects:startPhaseSix'], 'phase_six.start');
    assert.match(read('app/api/jobs/run/route.ts'), /handleStartPhaseSix/);
  });
});

describe('Master Test Plan', () => {
  test('payment/auth/tenant/destructive risk cannot be recorded low or shallow', () => {
    assert.match(plan, /kind not in \('payment', 'authentication', 'authorization', 'tenant_data', 'destructive'\) or \(level in \('high', 'critical'\) and depth = 'deep'\)/);
  });
  test('the plan names its gaps and only an Admin approves it', () => {
    for (const text of ['Requirement not covered', 'has no test case', 'has no end-to-end case', 'No risk matrix']) assert.ok(plan.includes(text), text);
    assert.match(plan, /core\.is_admin\(\)/);
  });
  test('results: independent, evidenced, on the exact commit; a critical case is never silently skipped; history is append-only', () => {
    for (const text of ["'self_review'", "'evidence_required'", "'stale_plan'", "'critical_cannot_be_skipped'", 'never edited or deleted']) assert.ok(plan.includes(text), text);
    assert.match(plan, /check \(status <> 'skipped_with_reason' or priority <> 'critical'\)/);
  });
});

describe('Phase 6 defects', () => {
  test('S0-S4, classification, and a test defect is not a product defect', () => {
    assert.match(defects, /s_level smallint check \(s_level between 0 and 4\)/);
    assert.match(defects, /classification = 'product_defect' and d\.status in/);
    assert.match(defects, /a new client request found in QA becomes a Change Request|never a defect/);
  });
  test('a retest verifies only on the FIXED commit, with evidence; a failed retest reopens', () => {
    assert.match(defects, /the retest must run on the FIXED build/);
    assert.match(defects, /'reopened'/);
  });
});

const release = read('supabase/migrations/20261101130000_a_release_candidate_is_one_exact_commit_and_gates_decide.sql');
const exit = read('supabase/migrations/20261101140000_phase_six_completes_on_an_approved_candidate_and_hands_phase_seven_an_intake.sql');
const specialists = read('supabase/migrations/20261101150000_the_phase_six_qa_specialists_are_installed_disabled.sql');

describe('release candidate, gates, exceptions, Admin review', () => {
  test('a candidate is one exact commit; approval cannot be a status edit', () => {
    assert.match(release, /a release candidate is one exact commit and build: a different commit is a new candidate/);
    assert.match(release, /approved through the Admin review door, never by a status edit/);
  });
  test('gates decide and the score cannot override them (a CHECK, not a convention)', () => {
    assert.match(release, /check \(result <> 'ready' or \(all_gates_satisfied and score >= 70\)\)/);
    for (const gate of ['build_succeeds', 'critical_tests', 'no_s0_s1', 'security', 'database_migration', 'regression', 'unique_artifact', 'evidence_current', 'rollback', 'client_acceptance', 'admin_approval']) {
      assert.ok(release.includes(`'${gate}'`), gate);
    }
  });
  test('exceptions are human-only, bounded, expiring, and only for gates policy allows', () => {
    assert.match(release, /gate in \('performance', 'compatibility', 'observability', 'deployment_config'\)/);
    assert.match(release, /core\.is_owner\(\)/);
    assert.match(release, /requester_cannot_approve/);
    assert.match(release, /e\.status = 'approved' and e\.expires_at > now\(\)/);
  });
  test('only an Admin decides, for the exact candidate, and the approval re-checks everything now', () => {
    assert.match(release, /core\.is_admin\(\)/);
    assert.match(release, /'wrong_candidate'/);
    assert.match(release, /select \* into v_a from qa\.evaluate_readiness\(v_c\.id\);\s+if v_a\.result <> 'ready'/);
  });
});

describe('Phase 6 exit and Phase 7 intake', () => {
  test('Phase 6 deploys nothing: a CHECK and a frozen row', () => {
    assert.match(exit, /production_deployed\s+boolean not null default false check \(not production_deployed\)/);
    assert.match(exit, /never edited/);
  });
  test('Phase6Completed needs an Admin-approved candidate that is still the build, every gate now, no FIX_READY awaiting retest', () => {
    for (const text of ['No release candidate is approved by an Admin', 'The approved candidate is stale', 'Hard gate not satisfied', 'await independent retest']) assert.ok(exit.includes(text), text);
  });
  test('M4 is a runner-only once-only fact and the Phase 7 gate ignores every override', () => {
    assert.match(exit, /grant execute on function projects\.record_m4_verified\(uuid\) to service_role;/);
    assert.match(exit, /offset 3 limit 1/);
    assert.ok((subs['invoice.paid'] ?? []).includes('projects:recordM4Verified'));
    assert.deepEqual(subs['project.m4_payment_verified'], ['crm:announceM4PaymentVerified', 'projects:openPhaseSeven']);
  });
  test('the nine QA specialists are installed disabled and verified by quality_assurance alone', () => {
    assert.equal((specialists.match(/'L1', false,/g) ?? []).length, 9);
    assert.ok(!/'L[012]', true/.test(specialists));
  });
});

describe('the Phase 6 Admin surface calls only whitelisted doors', () => {
  const actions = read('src/modules/projects/phase-six-actions.ts');
  const panel = read('app/(internal)/projects/[projectId]/phase-six-panel.tsx');
  const queries = read('src/modules/projects/phase-six-queries.ts');
  test('an unknown door name is refused and every action is gated on project.write', () => {
    assert.match(actions, /hasOwnProperty\.call\(DOORS, name\)/);
    assert.match(actions, /Unknown action/);
    assert.match(actions, /can\(context, 'project\.write'\)/);
  });
  test('every door the panel offers is in the whitelist', () => {
    const used = [...panel.matchAll(/door="([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(used.length >= 15, `only ${used.length} doors found`);
    for (const door of used) assert.ok(actions.includes(`${String(door)}:`), String(door));
  });
  test('the project page renders the panel and every read is guarded', () => {
    assert.match(read('app/(internal)/projects/[projectId]/page.tsx'), /<PhaseSixPanel view=\{phaseSix\} projectId=\{projectId\} \/>/);
    assert.ok((queries.match(/unreadable\('readPhaseSixOverview\./g) ?? []).length >= 18);
  });
  test('the panel says the score is a summary and shows the gates', () => {
    assert.match(panel, /a high score cannot hide a failed gate/);
    assert.match(panel, /candidate\.gates\.map/);
  });
});


describe('QA scheduling, canonical defects, source change', () => {
  const m = read('supabase/migrations/20261101160000_qa_is_scheduled_duplicates_are_canonical_and_a_source_change_reopens_phase_six.sql');
  test('safe parallelism: destructive database work serial, load testing exclusive, regression after what it protects', () => {
    assert.match(m, /when 'database' then 'serial' when 'performance' then 'exclusive' else 'parallel'/);
    assert.match(m, /when 'regression' then array\['functional', 'ui_e2e'\]/);
  });
  test('a held job is never recorded as started; it routes when the specialist is enabled', () => {
    assert.match(m, /agent_disabled/);
    assert.match(m, /the held work is routed/);
  });
  test('a duplicate points at one canonical product defect and keeps its evidence there', () => {
    assert.match(m, /canonical_is_not_a_product_defect/);
    assert.match(m, /Duplicate report:/);
  });
  test('a source change after approval makes the candidate stale and tells Phase 7', () => {
    assert.match(m, /phase_seven_candidate_current/);
    assert.match(m, /a new candidate and a new Admin approval are required before production/);
  });
  test('all of it is reachable', () => {
    assert.deepEqual(subs['project.master_test_plan_approved'], ['projects:scheduleQaJobs', 'crm:announceTestingStarted']);
    assert.ok((subs['project.deliverable_submitted'] ?? []).includes('projects:reopenOnSourceChange'));
    for (const h of ['projects:scheduleQaJobs', 'projects:reopenOnSourceChange', 'crm:announceTestingStarted']) assert.ok((HANDLERS as readonly string[]).includes(h), h);
    assert.match(read('app/api/jobs/run/route.ts'), /handleScheduleQaJobs/);
  });
});

describe('contracts, client clarification, client-safe progress, dashboards', () => {
  const m = read('supabase/migrations/20261101170000_contracts_are_declared_the_client_is_asked_one_question_and_progress_is_client_safe.sql');
  const panel = read('app/(internal)/projects/[projectId]/phase-six-panel.tsx');
  test('a contract is declared by a person with a name and a reference; none is inferred', () => {
    assert.match(m, /each_contract_needs_a_name_and_a_reference/);
  });
  test('the client is asked one question at a time; the question and answer are history; the event never carries the question', () => {
    assert.match(m, /already_open/);
    assert.match(m, /asked once and answered once; neither is edited/);
    assert.match(m, /the question itself is read from the row/);
  });
  test('the defect-progress fact carries the severity class, never the finding', () => {
    assert.match(m, /jsonb_build_object\('projectId', v_d\.project_id, 'sLevel', v_d\.s_level\)/);
    assert.ok(!/'title', v_d\.title/.test(m));
  });
  test('both PM messages are reachable', () => {
    assert.deepEqual(subs['project.qa_clarification_requested'], ['crm:announceQaClarification']);
    assert.deepEqual(subs['project.qa_defect_handed_off'], ['crm:announceQaDefectProgress']);
    assert.match(read('app/api/jobs/run/route.ts'), /announceQaClarification/);
  });
  test('the dashboards use the project\'s own targets and never invent a threshold', () => {
    for (const text of ['No performance targets set: none is invented', 'Over target', 'A simulator is not a device', '<DoorForm door="declare_contracts"', '<DoorForm door="ask_clarification"']) assert.ok(panel.includes(text), text);
  });
});
