import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { region, TO_END } from './_region.ts';

/**
 * Admin EDIT redrafts too — Master's locked objective names TWO paths back
 * to the designer: "ADMIN EDIT → DESIGNER → QA → ADMIN AGAIN" and the UI
 * Client Revision Rule's client_change loop (`20260924100000`). Only the
 * second existed until this migration: `sync_ui_version_decision` had
 * written `admin_edit` since `20260923130000` with zero subscribers — the
 * same "event with no receiver" shape this repository's audit history keeps
 * finding, this time silent rather than named as a known gap.
 *
 * Live-verified end to end on a scratch Postgres: a version forced to
 * admin_edit, revised through the same door the client path uses, produced
 * a real second row and incremented the SAME ui_revision_count the
 * client_change path shares — Master's schema never named a separate budget
 * for the two paths.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260924120000_admin_edit_redrafts_too.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const WORKFLOWS_TS = read('app/api/jobs/run/workflows.ts');
const WORKFLOW = region(WORKFLOWS_TS, 'const UI_VERSION_REVISE: AgentWorkflow', TO_END);

const reviseDoor = (() => {
  const start = SQL.indexOf('create or replace function projects.revise_ui_version');
  assert.ok(start > 0, 'revise_ui_version not found');
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. one door, one counter, two entry states', () => {
  test('the door accepts client_change OR admin_edit, not client_change alone', () => {
    assert.match(reviseDoor, /if v_latest\.status not in \('client_change', 'admin_edit'\) then/);
  });

  test('the migration says why there is no separate admin-edit counter', () => {
    assert.match(PROSE, /Master.s schema never named a separate budget/);
  });

  test('it is a create-or-replace of the SAME function, not a second door', () => {
    const occurrences = (SQL.match(/create or replace function projects\.revise_ui_version/g) ?? []).length;
    assert.equal(occurrences, 1);
  });
});

describe('B. the workflow tells the two trigger events apart by eventType', () => {
  test('project.ui_version_client_decided still filters to change_requested', () => {
    assert.match(WORKFLOW, /eventType === 'project\.ui_version_client_decided'/);
    assert.match(WORKFLOW, /parsed\.data\.decision !== 'change_requested'/);
  });

  test('project.ui_version_admin_reviewed filters to admin_edit', () => {
    assert.match(WORKFLOW, /eventType === 'project\.ui_version_admin_reviewed'/);
    assert.match(WORKFLOW, /parsed\.data\.status !== 'admin_edit'/);
  });

  test('an unrecognised trigger event fails loudly rather than guessing', () => {
    assert.match(WORKFLOW, /unrecognised trigger event/);
  });

  test('the prior version check accepts either status, matching the door', () => {
    assert.match(WORKFLOW, /prior\.status !== 'client_change' && prior\.status !== 'admin_edit'/);
  });

  test('admin feedback comes from approval_requests.decision_note, client feedback from ui_version_client_decisions', () => {
    assert.match(WORKFLOW, /\.from\('ui_version_client_decisions'\)/);
    assert.match(WORKFLOW, /\.schema\('approvals'\)\s*\n\s*\.from\('approval_requests'\)/);
    assert.match(WORKFLOW, /\.eq\('subject_type', 'ui_version'\)/);
  });
});

describe('C. it is reachable — the defect this repository has found repeatedly', () => {
  test('project.ui_version_admin_reviewed fans out to both the PM announcement AND the reviser', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.ui_version_admin_reviewed'], [
      'crm:announceUiVersionAdminReviewed',
      'ui_designer:reviseUIVersion',
    ]);
  });

  test('project.ui_version_client_decided is unaffected by this migration', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.ui_version_client_decided'], [
      'crm:announceUiVersionChangeRequested',
      'ui_designer:reviseUIVersion',
    ]);
  });
});
