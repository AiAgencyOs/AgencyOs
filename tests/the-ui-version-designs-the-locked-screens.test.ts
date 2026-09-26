import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { uiVersionDraftSchema, UI_VERSION_SCREEN_STATES } from '../src/modules/projects/schema.ts';
import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { region, TO_END } from './_region.ts';

/**
 * The UI version designs the locked screens — UID §4, §6, §19; Impl §7.2, §8;
 * docs/phase-4-gap-analysis.md step 3 (UI Designer Agent against the real
 * Phase 3 baseline).
 *
 * The assertions that matter most: the workflow reads screens through the
 * FROZEN Phase 3 handoff rather than re-deriving them, an invented screen key
 * is rejected before it is ever persisted, and the door is idempotent per
 * workspace exactly like every other "duplicate event" door in this
 * repository.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260923110000_the_ui_version_designs_the_locked_screens.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const WORKFLOWS_TS = read('app/api/jobs/run/workflows.ts');
const WORKFLOW = region(WORKFLOWS_TS, 'const UI_VERSION_DRAFT: AgentWorkflow', '\n/**\n *');

const door = (() => {
  const start = SQL.indexOf('create or replace function projects.record_ui_version_draft');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. the schema draws the same boundary design_token_sets does', () => {
  test('states are the bounded five, not the production checklist', () => {
    assert.deepEqual([...UI_VERSION_SCREEN_STATES], ['default', 'empty', 'loading', 'error', 'success']);
  });

  test('a screen key must look like one Phase 3 already produces', () => {
    const bad = uiVersionDraftSchema.safeParse({
      screens: [{ screenKey: 'Not Valid!', layoutSummary: 'x', keyComponents: ['a'], statesAddressed: ['default'] }],
    });
    assert.equal(bad.success, false);
  });

  test('an empty draft designs nothing', () => {
    const empty = uiVersionDraftSchema.safeParse({ screens: [] });
    assert.equal(empty.success, false);
  });

  test('a valid screen parses', () => {
    const ok = uiVersionDraftSchema.safeParse({
      screens: [
        { screenKey: 'home', layoutSummary: 'A simple hero and feature grid.', keyComponents: ['hero', 'nav'], statesAddressed: ['default', 'loading'] },
      ],
    });
    assert.equal(ok.success, true);
  });
});

describe('B. the workflow reads the FROZEN baseline, never re-derives it', () => {
  test('it reads phase_three_handoffs.payload, not projects.screens directly', () => {
    assert.match(WORKFLOW, /\.from\('phase_three_handoffs'\)/);
    assert.doesNotMatch(WORKFLOW, /\.from\('screens'\)/);
  });

  test('and the comment says why', () => {
    assert.match(
      WORKFLOWS_TS.replace(/\n\s*\*\s?/g, ' '),
      /Handing the model a SECOND, freshly-read copy of `projects\.screens` would risk designing against a screen a later Phase 3 revision superseded/,
    );
  });
});

describe('C. an invented screen is rejected before it is ever persisted', () => {
  test('the workflow checks every output key against the known frozen set', () => {
    assert.match(WORKFLOW, /const invented = validated\.data\.screens\.map\(\(s\) => s\.screenKey\)\.filter\(\(key\) => !known\.has\(key\)\)/);
    assert.match(WORKFLOW, /if \(invented\.length > 0\) \{/);
  });

  test('and the door is never called on that path', () => {
    const before = WORKFLOW.slice(0, WORKFLOW.indexOf("rpc('record_ui_version_draft'"));
    assert.match(before, /invented\.length > 0/);
  });
});

describe('D. one draft per workspace, which is the idempotency', () => {
  test('the column is UNIQUE, not merely checked', () => {
    assert.match(SQL, /phase_four_id\s+uuid not null unique references projects\.phase_four\(id\)/);
  });

  test('the workspace is locked before anything is decided', () => {
    assert.match(door, /select p4\.\* into v_phase_four\s*\n\s*from projects\.phase_four p4\s*\n\s*where p4\.id = p_phase_four_id\s*\n\s*for update/);
  });

  test('a replay answers already_drafted WITH the existing id', () => {
    assert.match(door, /'already_drafted'::text, v_existing\.id/);
  });

  test('and the workflow checks for one before ever calling the model', () => {
    const beforeModel = WORKFLOW.slice(0, WORKFLOW.indexOf('const call = await callModel'));
    assert.match(beforeModel, /\.from\('ui_versions'\)/);
    assert.match(beforeModel, /this workspace already has a UI version draft/);
  });
});

describe('E. the state machine is named in full, and only DRAFT has a door', () => {
  test('every Impl §7.2 state is expressible', () => {
    for (const state of [
      'draft', 'qa_review', 'qa_changes_required', 'qa_pass',
      'admin_review', 'admin_edit', 'admin_approved',
      'client_review', 'client_change', 'client_approved', 'locked',
    ]) {
      assert.match(SQL, new RegExp(`'${state}'`), `${state} cannot be stored`);
    }
  });

  test('the door refuses a workspace not at task2_started', () => {
    assert.match(door, /if v_phase_four\.state <> 'task2_started' then/);
    assert.match(door, /'wrong_state'::text/);
  });

  test('a successful draft advances phase_four to ui_design', () => {
    assert.match(door, /update projects\.phase_four\s*\n\s*set state = 'ui_design'/);
  });
});

describe('F. the guards every table and door in this repository carries', () => {
  test('tenancy: every org-scoped foreign key is guarded', () => {
    assert.match(SQL, /core\.enforce_parent_org\('project_id', 'projects\.projects'\)/);
    assert.match(SQL, /core\.enforce_parent_org\('phase_four_id', 'projects\.phase_four'\)/);
    assert.match(SQL, /core\.enforce_parent_org\('source_phase_three_handoff_id', 'projects\.phase_three_handoffs'\)/);
  });

  test('RLS on, forced, internal-only, no write policy at all', () => {
    assert.match(SQL, /alter table projects\.ui_versions enable row level security/);
    assert.match(SQL, /alter table projects\.ui_versions force row level security/);
    assert.doesNotMatch(SQL, /for (insert|update|delete|all) (to|on) /);
  });

  test('the door is security definer with an empty search_path, and the can_write guard is coalesced', () => {
    assert.match(SQL, /security definer\s*\nset search_path = ''/);
    // G-281: an uncoalesced `not (select core.can_write())` is NULL, not
    // true, for a caller with no role — this table's own guard must not
    // repeat the defect the fail-open sweep exists to catch.
    assert.match(door, /not coalesce\(\(select core\.can_write\(\)\), false\)/);
    assert.doesNotMatch(door, /not\s+\(\s*select\s+core\.can_write\s*\(/);
  });

  test('an unattended caller is refused unless it is the service role', () => {
    assert.match(door, /if v_actor is null and \(select auth\.role\(\)\) is distinct from 'service_role' then/);
  });

  test('not callable by the world', () => {
    assert.match(SQL, /revoke all on function projects\.record_ui_version_draft\(uuid, jsonb\) from public, anon/);
    assert.match(SQL, /grant execute on function projects\.record_ui_version_draft\(uuid, jsonb\) to authenticated, service_role/);
  });

  test('it audits and announces inside the same transaction', () => {
    assert.match(door, /perform core\.record_audit\(/);
    assert.match(door, /perform core\.emit_event\(/);
    assert.match(SQL, /insert into core\.event_types/);
  });
});

describe('G. it is reachable — the defect this repository has found repeatedly', () => {
  test('the catalog fans project.phase_four_started to the router, the designer and PM', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.phase_four_started'], [
      'orchestrator:routeTask2Design',
      'ui_designer:draftUIVersion',
      'crm:announcePhaseFourStarted',
    ]);
    assert.ok(HANDLERS.includes('ui_designer:draftUIVersion'));
    assert.equal(HANDLER_JOB_KIND['ui_designer:draftUIVersion'], 'ui.version_draft');
  });

  test('the workflow is registered, so its job kind is actually claimed', () => {
    assert.match(WORKFLOWS_TS, /jobKind: 'ui\.version_draft'/);
    assert.match(WORKFLOWS_TS, /agentKey: 'ui_designer'/);
    const registration = region(WORKFLOWS_TS, 'export const AGENT_WORKFLOWS', TO_END);
    assert.match(registration.slice(0, 400), /UI_VERSION_DRAFT/);
  });
});

describe('H. no destructive scope — it does not overreach into QA or review', () => {
  test('no QA verdict, admin decision or client approval is decided here', () => {
    assert.doesNotMatch(WORKFLOW, /qa_pass|qa_changes_required|admin_approved|client_approved/);
  });
});
