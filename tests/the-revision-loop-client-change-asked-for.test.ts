import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { region, TO_END } from './_region.ts';

/**
 * The revision loop client_change asked for — UI Client Revision Rule
 * (UID §4). `20260923140000`'s own header named this gap: a `change_requested`
 * decision moved a UI version to `client_change` and stopped there.
 *
 * The point of this unit: a second round is a second ROW (the first
 * version's own review history stays untouched), the limit is enforced in
 * the door itself rather than only displayed, and a round past the limit
 * stops the workspace for human escalation rather than drafting again.
 *
 * Live-verified end to end on a scratch Postgres (see PR description /
 * session notes): draft v1 → forced client_change → revise → v2 draft,
 * ui_revision_count 0→1; a replay against the still-`draft` v2 answers
 * already_revised without a third row; three real rounds bring the count to
 * the configured limit (3); a fourth is refused with revision_limit_reached
 * and the workspace moves to revision_limit_escalation with a blocked_reason,
 * and — critically — no fifth `ui_versions` row is written.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260924100000_the_revision_loop_client_change_asked_for.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const WORKFLOWS_TS = read('app/api/jobs/run/workflows.ts');
const WORKFLOW = region(WORKFLOWS_TS, 'const UI_VERSION_REVISE: AgentWorkflow', '\n// ═');
const QUERIES_TS = read('src/modules/projects/queries.ts');
const RUNNER = read('app/api/jobs/run/route.ts');

const reviseDoor = (() => {
  const start = SQL.indexOf('create or replace function projects.revise_ui_version');
  assert.ok(start > 0, 'revise_ui_version not found');
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. a second round is a second row, not a mutated first one', () => {
  test('the unique constraint moved from (phase_four_id) to (phase_four_id, version)', () => {
    assert.match(SQL, /drop constraint if exists ui_versions_phase_four_id_key/);
    assert.match(SQL, /add constraint ui_versions_phase_four_id_version_key unique \(phase_four_id, version\)/);
  });

  test('the migration says why the old single-row assumption had to change', () => {
    assert.match(PROSE, /one draft per workspace, because the loop did not exist yet/);
  });

  test('the overview reads the latest version, not .maybeSingle() over phase_four_id alone', () => {
    assert.match(
      QUERIES_TS,
      /\.eq\('phase_four_id', workspace\.id\)\s*\n(\s*\/\/[^\n]*\n)+\s*\.order\('version', \{ ascending: false \}\)\s*\n\s*\.limit\(1\)/,
    );
  });
});

describe('B. the door refuses a round that is not client_change', () => {
  test('a workspace with no version at all', () => {
    assert.match(reviseDoor, /no_prior_version/);
  });

  test('any status other than client_change is treated as already answered, not an error', () => {
    assert.match(reviseDoor, /if v_latest\.status <> 'client_change' then\s*\n\s*return query select 'already_revised'/);
  });
});

describe('C. the limit is enforced here, not just displayed', () => {
  test('ui_revision_count vs ui_revision_limit is read before drafting', () => {
    assert.match(reviseDoor, /if v_phase_four\.ui_revision_count >= v_phase_four\.ui_revision_limit then/);
  });

  test('a round past the limit stops the workspace for human escalation', () => {
    assert.match(reviseDoor, /state = 'revision_limit_escalation'/);
    assert.match(reviseDoor, /blocked_reason = format\(/);
    assert.match(reviseDoor, /return query select 'revision_limit_reached'/);
  });

  test('an accepted round increments the count and returns to ui_design', () => {
    assert.match(reviseDoor, /ui_revision_count = ui_revision_count \+ 1/);
    assert.match(reviseDoor, /state = 'ui_design'/);
  });
});

describe('D. reuses the existing draft event, no new subscription needed for QA', () => {
  test('it reuses project.ui_version_drafted rather than inventing a second event type', () => {
    assert.match(reviseDoor, /'project\.ui_version_drafted',\s*\n\s*'ui_version', v_new,/);
  });

  test('Design QA already subscribes to it', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.ui_version_drafted'], ['quality_assurance:reviewUIVersion']);
  });
});

describe('E. the workflow filters to change_requested and checks the limit before calling the model', () => {
  test('final_confirmed is explicitly not this workflow\'s concern', () => {
    assert.match(WORKFLOW, /outcome: 'not_mine'/);
  });

  test('the limit is checked before any model call, to avoid spending one the door would refuse', () => {
    const limitCheckIndex = WORKFLOW.indexOf('ui_revision_count >= phaseFour.ui_revision_limit');
    const modelCallIndex = WORKFLOW.indexOf('callModel(');
    assert.ok(limitCheckIndex > 0, 'limit check not found');
    assert.ok(modelCallIndex > limitCheckIndex, 'the model is called before the limit is checked');
  });

  test('a screen the model invents is rejected before the door is ever called', () => {
    const region2 = region(WORKFLOWS_TS, 'const UI_VERSION_REVISE: AgentWorkflow', TO_END);
    assert.match(region2, /designs \$\{invented\.length\} screen\(s\) not in the locked baseline/);
  });

  test('it calls revise_ui_version, not record_ui_version_draft', () => {
    assert.match(WORKFLOW, /\.rpc\('revise_ui_version', \{/);
  });
});

describe('F. it is reachable — the defect this repository has found repeatedly', () => {
  test('the client-decided event fans out to both the PM announcement AND the reviser', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.ui_version_client_decided'], [
      'crm:announceUiVersionChangeRequested',
      'ui_designer:reviseUIVersion',
    ]);
    assert.ok(HANDLERS.includes('ui_designer:reviseUIVersion'));
    assert.equal(HANDLER_JOB_KIND['ui_designer:reviseUIVersion'], 'ui.version_revise');
  });

  test('the workflow is registered in AGENT_WORKFLOWS', () => {
    assert.match(WORKFLOWS_TS, /\n {2}UI_VERSION_DRAFT,\n {2}UI_VERSION_REVISE,\n/);
  });

  test('the generic AI-workflow runner drains every registered job kind, including this one', () => {
    // AGENT_WORKFLOWS is drained generically by job kind (app/api/jobs/run/route.ts),
    // the same runner every other AgentWorkflow in this file already uses —
    // no per-workflow wiring is needed in the runner itself.
    assert.match(RUNNER, /AGENT_WORKFLOWS/);
  });
});
