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
