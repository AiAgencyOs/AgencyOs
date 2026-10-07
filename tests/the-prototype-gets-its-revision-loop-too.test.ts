import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { region, TO_END } from './_region.ts';

/**
 * The prototype gets its revision loop too — Client Prototype Revision
 * (PROTO §21). `20260923150000`'s own header built the first build only;
 * `20260924100000` closed the identical gap one stage earlier for the UI
 * version. This is the same shape at the prototype stage.
 *
 * Live-verified end to end on a scratch Postgres (see session record): a
 * real build → submit → changes_requested (through the real approvals
 * engine, not a forced status) → revise produced a second deliverable/
 * artifact pair without disturbing the first; a replay against a still-draft
 * round answered already_revised; three full rounds reached the configured
 * limit of 3; a fourth was refused with revision_limit_reached, the
 * workspace moved to revision_limit_escalation, and no fifth
 * prototype_artifacts row was written.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260924110000_the_prototype_gets_its_revision_loop_too.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const WORKFLOWS_TS = read('app/api/jobs/run/workflows.ts');
const WORKFLOW = region(WORKFLOWS_TS, 'const PROTOTYPE_BUILD_REVISE: AgentWorkflow', TO_END);

const reviseDoor = (() => {
  const start = SQL.indexOf('create or replace function projects.revise_prototype_build');
  assert.ok(start > 0, 'revise_prototype_build not found');
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. a second round is a second build, not a mutated first one', () => {
  test('the unique constraint moved from (ui_version_id) to (ui_version_id, deliverable_id)', () => {
    assert.match(SQL, /drop constraint if exists prototype_artifacts_ui_version_id_key/);
    assert.match(SQL, /add constraint prototype_artifacts_ui_version_deliverable_key unique \(ui_version_id, deliverable_id\)/);
  });

  test('the migration says why the old single-build assumption had to change', () => {
    assert.match(PROSE, /One artifact per LOCKED UI version was correct for a build that could only ever happen once/);
  });
});

describe('B. the door refuses a round that is not changes_requested', () => {
  test('a UI version with no prior build at all', () => {
    assert.match(reviseDoor, /no_prior_build/);
  });

  test('any status other than changes_requested is treated as already answered, not an error', () => {
    assert.match(reviseDoor, /if v_latest\.deliverable_status <> 'changes_requested' then\s*\n\s*return query select 'already_revised'/);
  });

  test('the latest build is found by joining the deliverable and ordering by its version, not created_at on the artifact', () => {
    assert.match(reviseDoor, /join projects\.deliverables d on d\.id = a\.deliverable_id/);
    assert.match(reviseDoor, /order by d\.version desc/);
  });
});

describe('C. the limit is enforced here, not just displayed', () => {
  test('prototype_revision_count vs prototype_revision_limit is read before building', () => {
    assert.match(reviseDoor, /if v_phase_four\.prototype_revision_count >= v_phase_four\.prototype_revision_limit then/);
  });

  test('a round past the limit stops the workspace for human escalation', () => {
    assert.match(reviseDoor, /state = 'revision_limit_escalation'/);
    assert.match(reviseDoor, /blocked_reason = format\(/);
    assert.match(reviseDoor, /return query select 'revision_limit_reached'/);
  });

  test('an accepted round increments the count and returns to prototype_build', () => {
    assert.match(reviseDoor, /prototype_revision_count = prototype_revision_count \+ 1/);
    assert.match(reviseDoor, /state = 'prototype_build'/);
  });
});

describe('D. it reuses add_deliverable and project.prototype_build_ready, no parallel mechanism', () => {
  test('it calls the existing add_deliverable door, the same one record_prototype_build calls', () => {
    assert.match(reviseDoor, /from projects\.add_deliverable\(/);
  });

  test('it reuses project.prototype_build_ready rather than inventing a second event type', () => {
    assert.match(reviseDoor, /'project\.prototype_build_ready',\s*\n\s*'prototype_artifact', v_new,/);
  });

  test('Prototype QA already subscribes to it', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.prototype_build_ready'], ['quality_assurance:reviewPrototypeBuild', 'projects:attachP4uiBuild']);
  });
});

describe('E. the workflow filters to a prototype changes_requested decision, and checks the limit first', () => {
  test('any other kind or status is explicitly not this workflow\'s concern', () => {
    assert.match(WORKFLOW, /outcome: 'not_mine'/);
  });

  test('the limit is checked before any model call, to avoid spending one the door would refuse', () => {
    const limitCheckIndex = WORKFLOW.indexOf('used >= allowed');
    const modelCallIndex = WORKFLOW.indexOf('callModel(');
    assert.ok(limitCheckIndex > 0, 'limit check not found');
    assert.ok(modelCallIndex > limitCheckIndex, 'the model is called before the limit is checked');
  });

  test('an invented screen and a broken navigation target are both rejected before the door is called', () => {
    assert.match(WORKFLOW, /invented screen\(s\)/);
    assert.match(WORKFLOW, /broken navigation target\(s\)/);
  });

  test('it calls revise_prototype_build, not record_prototype_build', () => {
    assert.match(WORKFLOW, /\.rpc\('revise_prototype_build', \{/);
  });

  test('the reviewer\'s note comes from the real approval_requests.decision_note, not a client_words column that does not exist on deliverables', () => {
    assert.match(WORKFLOW, /\.schema\('approvals'\)\s*\n\s*\.from\('approval_requests'\)/);
    assert.match(WORKFLOW, /decision_note/);
  });
});

describe('F. it is reachable — the defect this repository has found repeatedly', () => {
  test('the deliverable-decided event fans out to completion, the PM announcement, AND the reviser', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.deliverable_decided'], [
      'projects:completePhaseFourOnPrototypeApproval',
      'crm:announcePrototypeChangeRequested',
      'crm:announceBuildApproved',
      'ui_prototype:reviseBuild',
      'project_manager:classifyPrototypeFeedback',
      'projects:syncP4uiBuild',
    ]);
    assert.ok(HANDLERS.includes('ui_prototype:reviseBuild'));
    assert.equal(HANDLER_JOB_KIND['ui_prototype:reviseBuild'], 'prototype.build_revise');
  });

  test('the workflow is registered in AGENT_WORKFLOWS', () => {
    assert.match(WORKFLOWS_TS, /\n {2}PROTOTYPE_BUILD,\n {2}PROTOTYPE_BUILD_REVISE,\n/);
  });
});
