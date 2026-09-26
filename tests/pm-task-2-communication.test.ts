import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { region, TO_END } from './_region.ts';

/**
 * PM Task 2 communication — Impl §8; PM §5, §6. docs/phase-4-gap-
 * analysis.md step 5.
 *
 * PM §5 describes these as client-facing sends. This repository's own
 * precedent for the identical Phase 3 milestone (`phaseThreeCompletedAnnouncementFor`)
 * announces to the INTERNAL group instead, and these four handlers follow
 * that precedent rather than opening a third automated client-send path
 * beside the two already reviewed (`dispatchApprovedQuotation`,
 * `reply.due`). The assertions here hold that choice, not the letter of PM
 * §5.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const HANDLERS_TS = read('src/modules/crm/handlers.ts');
const SCHEMA_TS = read('src/modules/crm/schema.ts');
const RUNNER = read('app/api/jobs/run/route.ts');
const MIGRATION_140000 = read('supabase/migrations/20260923140000_the_client_confirms_the_locked_ui.sql');
const MIGRATION_130000 = read('supabase/migrations/20260923130000_admin_review_reuses_the_engine.sql');

const handlerFor = (name: string) => region(HANDLERS_TS, `export async function ${name}`, TO_END);

describe('A. it announces internally, a deliberate divergence from PM §5\'s letter', () => {
  test('every Task 2 handler calls the shared internal-channel announcer', () => {
    for (const name of [
      'announcePhaseFourStarted',
      'announceUiVersionAdminReviewed',
      'announceUiVersionChangeRequested',
      'announceUiVersionLocked',
    ]) {
      assert.match(handlerFor(name), /announceToInternalChannel\(admin, job, \{/, `${name} does not use the shared announcer`);
    }
  });

  test('the module says so, naming the conflict rather than hiding it', () => {
    const prose = SCHEMA_TS.replace(/\n\s*\/\/\s?/g, ' ');
    assert.match(prose, /PM §5 lists these as messages the PM sends the client directly/);
    assert.match(prose, /recorded here rather than\s+silently reconciled/);
  });
});

describe('B. each milestone filters to its own moment, not every state change', () => {
  test('admin_edit is not a PM communication, only admin_approved is', () => {
    const fn = handlerFor('announceUiVersionAdminReviewed');
    assert.match(fn, /if \(event\.status !== 'admin_approved'\)/);
    assert.match(fn, /outcome: 'not_mine'/);
  });

  test('final_confirmed is not announced here — the lock event carries PM4-M04 instead', () => {
    const fn = handlerFor('announceUiVersionChangeRequested');
    assert.match(fn, /if \(event\.decision !== 'change_requested'\)/);
  });
});

describe('C. idempotency keys are per-milestone, not shared', () => {
  test('four distinct externalRef prefixes', () => {
    assert.match(handlerFor('announcePhaseFourStarted'), /externalRef: `phase-four-started:\$\{event\.projectId\}`/);
    assert.match(handlerFor('announceUiVersionAdminReviewed'), /externalRef: `ui-version-admin-approved:\$\{event\.phaseFourId\}`/);
    assert.match(handlerFor('announceUiVersionChangeRequested'), /externalRef: `ui-version-change-requested:\$\{event\.phaseFourId\}`/);
    assert.match(handlerFor('announceUiVersionLocked'), /externalRef: `ui-version-locked:\$\{event\.phaseFourId\}`/);
  });
});

describe('D. it is reachable — the defect this repository has found repeatedly', () => {
  test('project.ui_version_admin_reviewed had no subscriber before this; now it does', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.ui_version_admin_reviewed'], ['crm:announceUiVersionAdminReviewed']);
  });

  test('project.ui_version_client_decided had no subscriber before this; now it does', () => {
    // The revision loop (20260924100000) adds a second subscriber, the
    // designer's own reviser, alongside this announcement.
    assert.deepEqual(SUBSCRIPTIONS['project.ui_version_client_decided'], [
      'crm:announceUiVersionChangeRequested',
      'ui_designer:reviseUIVersion',
    ]);
  });

  test('project.phase_four_started and project.ui_version_locked both fan out to their announcer too', () => {
    assert.ok(SUBSCRIPTIONS['project.phase_four_started']?.includes('crm:announcePhaseFourStarted'));
    assert.ok(SUBSCRIPTIONS['project.ui_version_locked']?.includes('crm:announceUiVersionLocked'));
  });

  test('all four handlers are registered with job kinds', () => {
    for (const [handler, kind] of [
      ['crm:announcePhaseFourStarted', 'phase_four_started.announce'],
      ['crm:announceUiVersionAdminReviewed', 'ui_version_admin_reviewed.announce'],
      ['crm:announceUiVersionChangeRequested', 'ui_version_change_requested.announce'],
      ['crm:announceUiVersionLocked', 'ui_version_locked.announce'],
    ] as const) {
      assert.ok(HANDLERS.includes(handler), `${handler} missing from HANDLERS`);
      assert.equal(HANDLER_JOB_KIND[handler], kind);
    }
  });

  test('the runner drains all four job kinds', () => {
    for (const constName of [
      'PHASE_FOUR_STARTED_JOB_KIND',
      'UI_VERSION_ADMIN_REVIEWED_JOB_KIND',
      'UI_VERSION_CHANGE_REQUESTED_JOB_KIND',
      'UI_VERSION_LOCKED_ANNOUNCE_JOB_KIND',
    ]) {
      assert.match(RUNNER, new RegExp(`const ${constName} = HANDLER_JOB_KIND\\['crm:`));
    }
    assert.match(RUNNER, /announcePhaseFourStarted,\s*\n\s*'runPhaseFourStartedAnnouncementJobs'/);
    assert.match(RUNNER, /announceUiVersionAdminReviewed,\s*\n\s*'runUiVersionAdminReviewedAnnouncementJobs'/);
    assert.match(RUNNER, /announceUiVersionChangeRequested,\s*\n\s*'runUiVersionChangeRequestedAnnouncementJobs'/);
    assert.match(RUNNER, /announceUiVersionLocked,\s*\n\s*'runUiVersionLockedAnnouncementJobs'/);
  });
});

describe('E. the events these handlers subscribe to are real, not invented', () => {
  test('sync_ui_version_decision actually emits project.ui_version_admin_reviewed', () => {
    assert.match(MIGRATION_130000, /'project\.ui_version_admin_reviewed'/);
    assert.match(MIGRATION_130000, /perform core\.emit_event\(\s*\n\s*v_row\.organization_id, 'project\.ui_version_admin_reviewed'/);
  });

  test('record_ui_version_client_decision actually emits project.ui_version_client_decided', () => {
    assert.match(MIGRATION_140000, /'project\.ui_version_client_decided'/);
  });

  test('lock_ui_version actually emits project.ui_version_locked', () => {
    assert.match(MIGRATION_140000, /'project\.ui_version_locked'/);
  });
});
