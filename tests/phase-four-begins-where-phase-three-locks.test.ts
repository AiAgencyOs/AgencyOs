import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { region, TO_END } from './_region.ts';

/**
 * Phase 4 begins where Phase 3 locks — Impl §8, §22; ORCH §19.
 *
 * `projects.lock_phase_three_direction` has emitted `project.phase_four_ready`
 * since 20260920000000 and nothing has ever consumed it — the same gap
 * `project.phase_three_ready` sat in before `handlePhaseThreeReady` existed.
 * This is the receiver, and the first Phase 4 unit for the same reason
 * `phase_three` was the first Phase 3 one.
 *
 * The assertions that matter most here: one workspace per project, the
 * handoff's `phase_four_ready` is read from the ROW rather than trusted from
 * the event (the event's subject is the handoff, not the project — the one
 * place this handler differs from `handlePhaseThreeReady`), and stopping
 * still says why.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260923100000_phase_four_begins_where_phase_three_locks.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const TOKENS_MIGRATION = read('supabase/migrations/20260920000000_the_tokens_phase_four_inherits.sql');
const HANDLERS_TS = read('src/modules/projects/handlers.ts');
const HANDLER = region(
  HANDLERS_TS,
  '`project.phase_four_ready` → start Phase 4',
  '`project.possible_scope_change_detected` → open a change request',
);
const RUNNER = read('app/api/jobs/run/route.ts');

const door = (() => {
  const start = SQL.indexOf('create or replace function projects.start_phase_four');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. the event Phase 3 already emits finally has a receiver', () => {
  test('Phase 3 emits it only when ready, and said so at the time', () => {
    assert.match(TOKENS_MIGRATION, /'project\.phase_four_ready'/);
    assert.match(TOKENS_MIGRATION, /if v_ready then/);
  });

  test('and the catalog now subscribes exactly one handler to it', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.phase_four_ready'], ['projects:startPhaseFour']);
    assert.ok(HANDLERS.includes('projects:startPhaseFour'));
    assert.equal(HANDLER_JOB_KIND['projects:startPhaseFour'], 'phase_four.start');
  });

  test('the runner drains that job kind, so the handler is reachable', () => {
    assert.match(RUNNER, /const PHASE_FOUR_JOB_KIND = HANDLER_JOB_KIND\['projects:startPhaseFour'\]/);
    assert.match(RUNNER, /handlePhaseFourReady/);
    assert.match(RUNNER, /PHASE_FOUR_JOB_KIND,\s*\n\s*handlePhaseFourReady/);
  });

  test('the handler decides nothing — the door does, under the lock', () => {
    assert.match(HANDLER, /rpc\('start_phase_four', \{ p_project_id: handoff\.project_id \}/);
    assert.doesNotMatch(HANDLER, /insert into|update projects\.phase_four/i);
  });
});

describe('B. the handoff row is authoritative, not the event payload', () => {
  test('readiness is read back from the handoff row before the door is called', () => {
    assert.match(HANDLER, /\.from\('phase_three_handoffs'\)/);
    assert.match(HANDLER, /\.select\('project_id, phase_four_ready'\)/);
    assert.match(HANDLER, /if \(!handoff\.phase_four_ready\)/);
  });

  test('a stale or forged readiness claim is refused, permanently', () => {
    const branch = HANDLER.slice(HANDLER.indexOf('if (!handoff.phase_four_ready)'), HANDLER.indexOf('const { data, error } = await admin'));
    assert.match(branch, /permanent: true/);
    assert.match(HANDLER.replace(/\n\s*\/\/ ?/g, ' '), /The row is authoritative, not the event that carried its id/);
  });

  test('the door independently re-checks the same fact under its own lock', () => {
    assert.match(door, /h\.phase_four_ready = true/);
    assert.match(door, /'not_ready'::text/);
  });
});

describe('C. one workspace per project, which is the idempotency', () => {
  test('the column is UNIQUE, not merely checked', () => {
    assert.match(SQL, /project_id\s+uuid not null unique references projects\.projects\(id\)/);
  });

  test('the project is locked before anything is decided', () => {
    assert.match(door, /select p\.\* into v_project from projects\.projects p where p\.id = p_project_id for update/);
    assert.ok(door.indexOf('for update') < door.indexOf('from projects.phase_four'));
  });

  test('a replay answers already_started WITH the existing id', () => {
    assert.match(door, /'already_started'::text, v_existing\.id/);
  });

  test('and the handler treats that as success, not failure', () => {
    assert.match(HANDLER, /case 'already_started':/);
  });
});

describe('D. it references the Phase 3 handoff rather than copying it', () => {
  test('the foreign key is restrict, not cascade or a copy', () => {
    assert.match(SQL, /phase_three_handoff_id uuid not null references projects\.phase_three_handoffs\(id\) on delete restrict/);
    const table = SQL.slice(SQL.indexOf('create table if not exists projects.phase_four'), SQL.indexOf('create index'));
    assert.doesNotMatch(table, /screen_baseline_id|theme_option_id|figma_node/);
  });
});

describe('E. the state model is scoped to Task 2\'s macro-stage, and stopping says why', () => {
  test('every macro-stage is expressible', () => {
    for (const state of [
      'not_started', 'task2_started', 'ui_design', 'ui_review', 'ui_locked',
      'prototype_build', 'prototype_review', 'prototype_locked', 'completed',
    ]) {
      assert.match(SQL, new RegExp(`'${state}'`), `${state} cannot be stored`);
    }
  });

  test('and so is every waiting and escalation state', () => {
    for (const state of [
      'waiting_client', 'waiting_admin', 'waiting_designer', 'waiting_prototype',
      'blocked_requirement', 'scope_escalation', 'revision_limit_escalation',
    ]) {
      assert.match(SQL, new RegExp(`'${state}'`), `${state} cannot be stored`);
    }
  });

  test('a stopped workspace may not be entered silently', () => {
    assert.match(SQL, /constraint phase_four_stop_says_why/);
    assert.match(SQL, /check \(state not in \('blocked_requirement', 'scope_escalation', 'revision_limit_escalation'\)/);
  });

  test('a completed workspace says when', () => {
    assert.match(SQL, /constraint phase_four_completion_is_dated/);
    assert.match(SQL, /check \(state <> 'completed' or completed_at is not null\)/);
  });

  test('UI and prototype revision limits are separate and configurable, not compiled in', () => {
    assert.match(SQL, /ui_revision_limit\s+int not null default 3 check \(ui_revision_limit between 1 and 10\)/);
    assert.match(SQL, /prototype_revision_limit int not null default 3 check \(prototype_revision_limit between 1 and 10\)/);
  });
});

describe('F. the guards every table and door in this repository carries', () => {
  test('tenancy: both org-scoped foreign keys are guarded', () => {
    assert.match(SQL, /core\.enforce_parent_org\('project_id', 'projects\.projects'\)/);
    assert.match(SQL, /core\.enforce_parent_org\('phase_three_handoff_id', 'projects\.phase_three_handoffs'\)/);
    assert.match(SQL, /core\.freeze_organization_id\(\)/);
  });

  test('RLS on, forced, internal-only, and no write policy at all', () => {
    assert.match(SQL, /alter table projects\.phase_four enable row level security/);
    assert.match(SQL, /alter table projects\.phase_four force row level security/);
    assert.match(SQL, /create policy phase_four_select on projects\.phase_four\s*\n\s*for select to authenticated/);
    assert.doesNotMatch(SQL, /for (insert|update|delete|all) (to|on) /);
    assert.match(PROSE, /Every mutation goes through a door below/);
  });

  test('the door is security definer with an empty search_path', () => {
    assert.match(SQL, /security definer\s*\nset search_path = ''/);
  });

  test('an unattended caller is refused unless it is the service role', () => {
    assert.match(door, /if v_actor is null and \(select auth\.role\(\)\) is distinct from 'service_role' then/);
    assert.match(door, /'no_actor'::text/);
  });

  test('an authenticated caller is tenancy-checked', () => {
    assert.match(door, /v_project\.organization_id is distinct from \(select core\.current_organization_id\(\)\)/);
    // G-281: `not (select core.can_write())` is NULL, not true, for a caller
    // whose token carries no role, and plpgsql's `if` does not run on NULL —
    // the guard must be coalesced or it fails open exactly the way
    // `20260920100000_forty_eight_guards_that_could_fail_open.sql` swept away.
    assert.match(door, /not coalesce\(\(select core\.can_write\(\)\), false\)/);
    assert.doesNotMatch(door, /not\s+\(\s*select\s+core\.can_write\s*\(/);
  });

  test('not callable by the world', () => {
    assert.match(SQL, /revoke all on function projects\.start_phase_four\(uuid\) from public, anon/);
    assert.match(SQL, /grant execute on function projects\.start_phase_four\(uuid\) to authenticated, service_role/);
  });

  test('it audits and announces inside the same transaction', () => {
    assert.match(door, /perform core\.record_audit\(/);
    assert.match(door, /perform core\.emit_event\(/);
    assert.match(SQL, /'project\.phase_four_started'/);
    assert.match(SQL, /insert into core\.event_types/);
  });
});

describe('G. it starts the workspace and nothing else', () => {
  test('nobody is messaged', () => {
    assert.doesNotMatch(door, /send_outbound_message|conversation_messages|whatsapp/i);
    const body = region(HANDLER, 'export async function handlePhaseFourReady', TO_END);
    assert.doesNotMatch(body, /send_outbound_message|announce|dispatchMessage|conversation_messages/i);
    assert.match(
      HANDLER.replace(/\n\s*\*\s?/g, ' '),
      /the PM's Task 2 start communication is its own unit once it exists/,
    );
  });

  test('and no UI or prototype artifact is created', () => {
    assert.doesNotMatch(door, /theme|colour|color|figma|prototype_build|ui_version/i);
  });
});
