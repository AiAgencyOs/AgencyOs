import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';

/**
 * Phase 5 foundation. The behavioural proofs are scripts/verify-phase-five-defects.sql and scripts/verify-phase-four-e2e.sql (real Postgres,
 * red-proven); these are the text-level guards that the pieces are reachable and the hard rules stay written down.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const defects = read('supabase/migrations/20261031140000_a_fix_is_not_a_verification_and_does_not_lift_the_gate.sql');
const baseline = read('supabase/migrations/20261031150000_phase_five_starts_from_a_locked_baseline.sql');
const builds = read('supabase/migrations/20261031160000_a_development_build_is_exact_independent_and_admin_approved.sql');

describe('Phase 5 defects: FIX_READY is not VERIFIED', () => {
  test('a fix claim keeps a blocker blocking; the fixer cannot verify', () => {
    assert.match(defects, /d\.status in \('open', 'fixed', 'needs_evidence', 'not_reproduced'\)/);
    assert.match(defects, /new\.verified_by is not distinct from old\.fixed_by/);
  });
});

describe('Phase 5 workspace and baseline', () => {
  test('the entry guard names every refusal and the baseline cannot be edited', () => {
    for (const refusal of ['phase_four_incomplete', 'm2_not_verified', 'no_locked_ui', 'no_approved_prototype', 'no_active_scope']) {
      assert.ok(baseline.includes(`'${refusal}'`), refusal);
    }
    assert.match(baseline, /never edited/);
  });
  test('the start is reachable: the verified-payment event starts it, through a registered handler and job kind', () => {
    assert.ok(SUBSCRIPTIONS['invoice.paid']?.includes('projects:startPhaseFive'));
    assert.ok(HANDLERS.includes('projects:startPhaseFive'));
    assert.equal(HANDLER_JOB_KIND['projects:startPhaseFive'], 'phase_five.start');
    assert.match(read('app/api/jobs/run/route.ts'), /handleStartPhaseFive/);
  });
  test('a development task needs the baseline', () => {
    assert.match(baseline, /'no_baseline'/);
  });
});

describe('Phase 5 builds, DoD and the Phase 6 gate', () => {
  test('no production target, an exact commit, independent QA, Admin approval', () => {
    assert.match(builds, /target_env in \('dev', 'review', 'staging', 'client_test'\)/);
    assert.match(builds, /'no_commit'/);
    assert.match(builds, /'self_review'/);
    assert.match(builds, /'not_qa_passed'/);
  });
  test('Phase 5 completion needs a client-approved final build; Phase 6 readiness needs M3 verified paid', () => {
    assert.match(builds, /No client-approved development build\./);
    assert.match(builds, /A newer development build exists than the one the client approved\./);
    assert.match(builds, /M3 not verified paid/);
    assert.match(builds, /offset 2 limit 1/);
  });
});

const reviews = read('supabase/migrations/20261031170000_a_build_is_reviewed_by_someone_who_did_not_write_it.sql');
const feedback = read('supabase/migrations/20261031180000_client_feedback_on_a_build_is_classified_and_routed.sql');
const truth = read('supabase/migrations/20261031200000_integrations_are_verified_by_evidence_and_specialists_say_when_not_required.sql');
const handoff = read('supabase/migrations/20261031210000_phase_five_hands_phase_six_a_frozen_intake.sql');
const specialists = read('supabase/migrations/20261031190000_the_phase_five_specialists_are_installed_disabled.sql');

describe('Phase 5 review, feedback, integrations and handoff', () => {
  test('a build is reviewed by someone who did not write it; stale after a new commit; high findings block', () => {
    assert.match(reviews, /'self_review'/);
    assert.match(reviews, /'blocking_finding'/);
    assert.match(reviews, /'stale'/);
    assert.match(reviews, /'needs_second'/);
    assert.match(reviews, /review_/);
  });
  test('scope-changing feedback can never carry a defect', () => {
    assert.match(feedback, /check \(classification not in \('possible_scope_change', 'new_feature'\) or defect_id is null\)/);
    assert.match(feedback, /a new feature does not become a bug/);
  });
  test('CONFIGURED is not VERIFIED, and a mock never verifies', () => {
    assert.match(truth, /check \(not \(is_mock and health = 'verified'\)\)/);
    assert.match(truth, /'only_an_adapter_verifies'/);
    assert.match(truth, /'mock_cannot_verify'/);
    assert.match(truth, /grant execute on function projects\.record_integration_check\(uuid, text, boolean, text\) to service_role;/);
  });
  test('NOT_REQUIRED keeps its reason', () => {
    assert.match(truth, /state not in \('not_required', 'blocked'\) or \(reason is not null/);
  });
  test('the Phase 6 intake is frozen, written with the completion, and never asks Phase 6 to trust', () => {
    assert.match(handoff, /independent_verification_required boolean not null default true check \(independent_verification_required\)/);
    assert.match(handoff, /perform projects\.build_phase_five_handoff\(p_project_id, v_id\)/);
    assert.match(handoff, /never edited/);
  });
  test('the eleven specialists are installed disabled and all verified by QA alone', () => {
    assert.equal((specialists.match(/'L1', false,/g) ?? []).length, 11);
    assert.ok(!/'L[012]', true/.test(specialists));
    assert.equal((specialists.match(/, 'quality_assurance'\)/g) ?? []).length >= 11, true);
  });
});

describe('Phase 5 Admin Panel overview is reachable and honest about failed reads', () => {
  const page = read('app/(internal)/projects/[projectId]/page.tsx');
  const queries = read('src/modules/projects/phase-five-queries.ts');
  const panel = read('app/(internal)/projects/[projectId]/phase-five-panel.tsx');
  test('the project page reads the overview and renders the panel', () => {
    assert.match(page, /readPhaseFiveOverview\(projectId\)/);
    assert.match(page, /<PhaseFivePanel view=\{phaseFive\} projectId=\{projectId\} \/>/);
  });
  test('every read is guarded: a failed read is unreadable, never "nothing yet"', () => {
    const awaited = (queries.match(/\{ data: [A-Za-z]+, error: [A-Za-z]+ \}/g) ?? []).length;
    const guards = (queries.match(/if \([A-Za-z]+Error\) unreadable\(/g) ?? []).length + (queries.match(/if \(result\.error\) unreadable\(/g) ?? []).length;
    assert.ok(awaited >= 11, `only ${awaited} reads found`);
    assert.ok(guards >= awaited, `${awaited} reads, ${guards} guards`);
  });
  test('the panel is read-only and says so', () => {
    assert.ok(!/<form|action=/.test(panel));
    assert.match(panel, /Read-only/);
  });
  test('the panel shows the gates that matter: baseline, review, QA, M3, the intake', () => {
    for (const text of ['Locked baseline', 'Review:', 'QA:', 'M3 payment', 'QA intake', 'Can Phase 5 complete?']) assert.ok(panel.includes(text), text);
  });
});

describe('PM5 messages are reachable and filtered to their own kind', () => {
  const handlers = read('src/modules/crm/handlers.ts');
  test('each PM5 announcer is subscribed through a registered handler and job kind', () => {
    const wiring: [string, string, string][] = [
      ['project.phase_five_started', 'crm:announcePhaseFiveStarted', 'phase_five_started.announce'],
      ['project.deliverable_submitted', 'crm:announceBuildShared', 'build_shared.announce'],
      ['project.build_feedback_received', 'crm:announceBuildFeedbackReceived', 'build_feedback.announce'],
      ['project.deliverable_decided', 'crm:announceBuildApproved', 'build_approved.announce'],
    ];
    for (const [event, handler, kind] of wiring) {
      assert.ok(((SUBSCRIPTIONS as Record<string, readonly string[]>)[event] ?? []).includes(handler), `${event} -> ${handler}`);
      assert.ok((HANDLERS as readonly string[]).includes(handler), handler);
      assert.equal((HANDLER_JOB_KIND as Record<string, string>)[handler], kind);
    }
  });
  test('the generic deliverable events only announce a development build', () => {
    assert.match(handlers, /event\.kind !== 'build'/);
    assert.match(handlers, /event\.kind !== 'build' \|\| event\.status !== 'approved'/);
  });
  test('the feedback event carries the project and build, never the client\'s words', () => {
    const migration = read('supabase/migrations/20261031220000_the_pm_hears_about_build_feedback.sql');
    assert.match(migration, /jsonb_build_object\('projectId', v_row\.project_id, 'deliverableId', v_row\.id, 'version', v_row\.version\)/);
  });
});
