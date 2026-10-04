import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (p: string) => readFileSync(p, 'utf8');

// Found by driving the whole Phase 2 flow: a GST project confirms its MODE
// first and its details after. The M1 job found an incomplete profile and
// dead-lettered, and recording the details published nothing, so a GST
// project's advance invoice was always a manual click. Proved live in
// scripts/verify-phase-two-e2e.mjs.

describe('a GST project\'s advance invoice follows its details', () => {
  const sql = read('supabase/migrations/20261011340000_a_gst_projects_advance_invoice_follows_its_details.sql');
  const service = read('src/modules/finance/service.ts');

  test('an incomplete profile makes the M1 job WAIT, not fail', () => {
    const at = service.indexOf('export async function generateFirstMilestoneInvoice');
    const body = service.slice(at, at + 9000);
    assert.match(body, /if \(!readiness\.complete\) \{\s*\n\s*return ok\(\{\s*\n\s*outcome: 'skipped' as const,\s*\n\s*reason: `waiting for billing details/);
    assert.doesNotMatch(body, /Billing confirmation fired but the profile is still incomplete/);
  });

  test('recording the details publishes the confirmation again, once the profile is complete and only for GST', () => {
    assert.match(sql, /if v_live\.mode = 'gst' and v_name is not null and v_addr is not null and v_state is not null and v_gstin is not null then\s*\n\s*perform core\.emit_event\(\s*\n\s*v_project\.organization_id, 'project\.billing_mode_confirmed'/);
    assert.match(sql, /'source', 'details_completed'/);
  });

  test('it is carried forward from the live body: still a person\'s act, still audited, GSTIN still refused on Non-GST', () => {
    assert.match(sql, /return query select 'needs_person'::text, null::uuid, null::int; return;/);
    assert.match(sql, /'project\.billing_details_recorded'/);
    assert.match(sql, /return query select 'gstin_on_non_gst'::text/);
  });
});

describe('Phase 2 starting moves the project to onboarding', () => {
  const sql = read('supabase/migrations/20261011360000_phase_two_starting_moves_the_project_to_onboarding.sql');

  test('only planning -> onboarding, only with the phase, and a project beyond it is left alone', () => {
    assert.match(sql, /update projects\.projects set status = 'onboarding' where id = p_project_id and status = 'planning';/);
  });

  test('because the kickoff\'s last step starts only a project in onboarding', () => {
    // projects.start_project (20260813120016) answers not_startable for anything else.
    const start = read('supabase/migrations/20260813120016_project_start_conditions.sql');
    assert.match(start, /v_status <> 'onboarding'/);
  });

  test('it is carried forward from the live body: same idempotency, same audit, same event trail', () => {
    assert.match(sql, /'project\.phase_two_started'/);
    assert.match(sql, /return query select 'no_handoff'::text, null::uuid, null::uuid; return;/);
  });
});

describe('the kickoff gate says ready only when the kickoff can complete', () => {
  const sql = read('supabase/migrations/20261011370000_the_kickoff_gate_reads_the_requirement_too.sql');

  test('the accepted requirement (ADM-13) is read by the gate, so "ready" cannot be followed by a refusal', () => {
    assert.match(sql, /if not coalesce\(v_start\.requirement_approved, false\) then v_unmet := v_unmet \|\| 'no_approved_requirement'::text; end if;/);
  });

  test('every earlier gate is carried forward, unchanged', () => {
    for (const name of ['onboarding_incomplete', 'whatsapp_group_not_mapped', 'advance_not_verified', 'no_active_plan']) {
      assert.match(sql, new RegExp(`v_unmet \\|\\| '${name}'::text`), name);
    }
  });

  test('a missing requirement is Phase 1\'s, so the phase reads as waiting on staff', () => {
    const states = read('supabase/migrations/20261011330000_phase_two_states_follow_the_facts.sql');
    assert.match(states, /'no_approved_requirement' = any\(v_ready\.unmet\)\s+then 'waiting_admin'/);
  });
});
