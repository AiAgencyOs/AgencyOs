import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { region, TO_END } from './_region.ts';

/**
 * Admin review reuses the engine — Impl §7.2; Master's locked objective.
 *
 * The point of this unit: a UI version's Admin review is `handover`'s exact
 * pattern one audience earlier — adding a subject_type to the existing
 * approvals engine rather than building Phase 4 its own approval table.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260923130000_admin_review_reuses_the_engine.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const HANDOVER_MIGRATION = read('supabase/migrations/20260813120003_handover.sql');
const HANDLERS_TS = read('src/modules/orchestrator/handlers.ts');
const HANDLER = region(HANDLERS_TS, 'export async function handleRequestUIVersionAdminReview', TO_END);
const RUNNER = read('app/api/jobs/run/route.ts');
const ACTIONS_TS = read('src/modules/approvals/actions.ts');
const SERVICE_TS = read('src/modules/projects/service.ts');

const requestDoor = (() => {
  const start = SQL.indexOf('create or replace function projects.request_ui_version_admin_review');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

const syncDoor = (() => {
  const start = SQL.indexOf('create or replace function projects.sync_ui_version_decision');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. it extends the same engine handover already extended', () => {
  test('handover added a subject_type to the exact same two CHECK constraints', () => {
    assert.match(HANDOVER_MIGRATION, /approval_requests_subject_type_check/);
    assert.match(HANDOVER_MIGRATION, /approval_policies_subject_type_check/);
  });

  test('this migration adds ui_version alongside handover, not a new table', () => {
    assert.match(SQL, /'handover', 'ui_version'/);
    assert.doesNotMatch(SQL, /create table/i);
  });

  test('the request door calls approvals.request_approval, not a bespoke insert', () => {
    assert.match(requestDoor, /from approvals\.request_approval\(/);
    assert.doesNotMatch(requestDoor, /insert into approvals\.approval_requests/);
  });
});

describe('B. CONFIRM/EDIT, not a third outcome', () => {
  test('both rejected and changes_requested collapse onto admin_edit', () => {
    assert.match(syncDoor, /when 'rejected'\s*then 'admin_edit'/);
    assert.match(syncDoor, /when 'changes_requested'\s*then 'admin_edit'/);
  });

  test('and the migration says why', () => {
    const prose = MIGRATION.replace(/\n\s*--\s?/g, ' ');
    assert.match(prose, /Master's Admin UI Review section names exactly two actions: CONFIRM and\s+EDIT/);
  });
});

describe('C. one open request per version — the engine\'s own idempotency, reused', () => {
  test('the request door only fires from qa_pass', () => {
    assert.match(requestDoor, /if v_version\.status <> 'qa_pass' then/);
    assert.match(requestDoor, /'wrong_state'::text/);
  });

  test('no_policy is answered, not defaulted open', () => {
    assert.match(requestDoor, /if v_approval\.outcome = 'no_policy' then/);
    assert.match(requestDoor, /'no_policy'::text, v_version\.id/);
  });

  test('and the handler treats a missing policy as a named, permanent block', () => {
    assert.match(HANDLER, /case 'no_policy':/);
    assert.match(HANDLER, /permanent: true/);
    assert.match(HANDLER, /an owner must set one in the Admin Panel/);
  });
});

describe('D. the row is re-read, not trusted from the event', () => {
  test('the handler checks the CURRENT status before raising review', () => {
    assert.match(HANDLER, /if \(version\.status !== 'qa_pass'\)/);
  });

  test('and says why in its own words', () => {
    assert.match(
      HANDLERS_TS.replace(/\n\s*\*\s?/g, ' '),
      /only the row's CURRENT status decides whether review is raised/,
    );
  });
});

describe('E. the human decision is a PULL, not a trigger, exactly like deliverables', () => {
  test('carryDecisionToSubject gets a ui_version case', () => {
    assert.match(ACTIONS_TS, /case 'ui_version': \{/);
    assert.match(ACTIONS_TS, /syncUiVersionDecision\(request\.subject_id\)/);
  });

  test('syncUiVersionDecision mirrors syncDeliverableDecision\'s shape', () => {
    const fn = region(SERVICE_TS, 'export async function syncUiVersionDecision', TO_END);
    assert.match(fn, /await requireInternal\(\)/);
    assert.match(fn, /rpc\('sync_ui_version_decision', \{ p_ui_version_id: uiVersionId \}\)/);
  });

  test('the sync door pulls from approval_requests, and touches nothing else', () => {
    assert.match(syncDoor, /from approvals\.approval_requests r/);
    assert.doesNotMatch(syncDoor, /insert into|delete from/i);
  });
});

describe('F. the guards every table and door in this repository carries', () => {
  test('both doors are security definer with a coalesced can_write/is_internal guard', () => {
    assert.match(SQL, /security definer\s*\nset search_path = ''/);
    assert.match(requestDoor, /not coalesce\(\(select core\.can_write\(\)\), false\)/);
    assert.match(syncDoor, /not coalesce\(\(select core\.is_internal\(\)\), false\)/);
    assert.doesNotMatch(SQL, /not\s+\(\s*select\s+core\.(can_write|is_internal)\s*\(/);
  });

  test('not callable by the world', () => {
    assert.match(SQL, /revoke all on function projects\.request_ui_version_admin_review\(uuid\) from public, anon/);
    assert.match(SQL, /revoke all on function projects\.sync_ui_version_decision\(uuid\) from public, anon/);
  });

  test('the sync door audits and announces inside the same transaction', () => {
    assert.match(syncDoor, /perform core\.record_audit\(/);
    assert.match(syncDoor, /perform core\.emit_event\(/);
    assert.match(SQL, /insert into core\.event_types/);
  });
});

describe('G. it is reachable — the defect this repository has found repeatedly', () => {
  test('the catalog subscribes admin-review-raising to the QA-verdict event', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.ui_version_qa_reviewed'], ['orchestrator:requestUIVersionAdminReview']);
    assert.ok(HANDLERS.includes('orchestrator:requestUIVersionAdminReview'));
    assert.equal(HANDLER_JOB_KIND['orchestrator:requestUIVersionAdminReview'], 'ui_version.request_admin_review');
  });

  test('the runner drains that job kind', () => {
    assert.match(RUNNER, /const UI_VERSION_ADMIN_REVIEW_JOB_KIND = HANDLER_JOB_KIND\['orchestrator:requestUIVersionAdminReview'\]/);
    assert.match(RUNNER, /handleRequestUIVersionAdminReview/);
  });
});
