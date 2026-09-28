import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { region, TO_END } from './_region.ts';

/**
 * PM4-M05/M06/M07 — Prototype Ready, Prototype Changes Received, Task 2
 * Complete. Impl §8; PM §5. docs/phase-4-gap-analysis.md step 5 (completed).
 *
 * Both underlying events (`project.deliverable_submitted`,
 * `project.deliverable_decided`) are generic across every deliverable kind
 * — the same events `handleDeliverableDecided` already filters for
 * `complete_phase_four`. These three handlers add a second/third
 * independent subscriber to events that already exist, filtering to
 * `kind = 'prototype'` themselves rather than teaching the shared SQL what
 * Phase 4 is.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const HANDLERS_TS = read('src/modules/crm/handlers.ts');
const RUNNER = read('app/api/jobs/run/route.ts');

const handlerFor = (name: string) => region(HANDLERS_TS, `export async function ${name}`, TO_END);

describe('A. each handler filters to kind=prototype itself', () => {
  test('announcePrototypeSubmitted ignores every other deliverable kind', () => {
    const fn = handlerFor('announcePrototypeSubmitted');
    assert.match(fn, /if \(event\.kind !== 'prototype'\)/);
    assert.match(fn, /outcome: 'not_mine'/);
  });

  test('announcePrototypeChangeRequested filters kind AND status', () => {
    const fn = handlerFor('announcePrototypeChangeRequested');
    assert.match(fn, /if \(event\.kind !== 'prototype'\)/);
    assert.match(fn, /if \(event\.status !== 'changes_requested'\)/);
  });

  test('an approved prototype is deliberately NOT announced by the change-requested handler', () => {
    const fn = handlerFor('announcePrototypeChangeRequested');
    assert.match(fn, /an approved prototype closes Task 2, announced there instead/);
  });
});

describe('B. idempotency keys are per-milestone and per-version', () => {
  test('three distinct externalRef prefixes, versioned where relevant', () => {
    assert.match(handlerFor('announcePrototypeSubmitted'), /externalRef: `prototype-submitted:\$\{event\.projectId\}:v\$\{event\.version\}`/);
    assert.match(handlerFor('announcePrototypeChangeRequested'), /externalRef: `prototype-change-requested:\$\{event\.projectId\}:v\$\{event\.version\}`/);
    assert.match(handlerFor('announceTask2Complete'), /externalRef: `task2-complete:\$\{event\.phaseFourId\}`/);
  });
});

describe('C. it is reachable — the defect this repository has found repeatedly', () => {
  test('project.deliverable_submitted now has a subscriber', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.deliverable_submitted'], ['crm:announcePrototypeSubmitted']);
  });

  test('project.deliverable_decided fans out to completion, the PM announcement, AND the reviser', () => {
    // The prototype revision loop (20260924110000) adds a third subscriber.
    assert.deepEqual(SUBSCRIPTIONS['project.deliverable_decided'], [
      'projects:completePhaseFourOnPrototypeApproval',
      'crm:announcePrototypeChangeRequested',
      'ui_prototype:reviseBuild',
    ]);
  });

  test('project.phase_four_completed fans out to both Finance AND the PM announcement', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.phase_four_completed'], [
      'finance:generateM2Invoice',
      'crm:announceTask2Complete',
    ]);
  });

  test('all three handlers are registered with job kinds', () => {
    for (const [handler, kind] of [
      ['crm:announcePrototypeSubmitted', 'prototype_submitted.announce'],
      ['crm:announcePrototypeChangeRequested', 'prototype_change_requested.announce'],
      ['crm:announceTask2Complete', 'task2_complete.announce'],
    ] as const) {
      assert.ok(HANDLERS.includes(handler), `${handler} missing from HANDLERS`);
      assert.equal(HANDLER_JOB_KIND[handler], kind);
    }
  });

  test('the runner drains all three job kinds', () => {
    for (const constName of ['PROTOTYPE_SUBMITTED_JOB_KIND', 'PROTOTYPE_CHANGE_REQUESTED_JOB_KIND', 'TASK2_COMPLETE_JOB_KIND']) {
      assert.match(RUNNER, new RegExp(`const ${constName} = HANDLER_JOB_KIND\\['crm:`));
    }
    assert.match(RUNNER, /announcePrototypeSubmitted,\s*\n\s*'runPrototypeSubmittedAnnouncementJobs'/);
    assert.match(RUNNER, /announcePrototypeChangeRequested,\s*\n\s*'runPrototypeChangeRequestedAnnouncementJobs'/);
    assert.match(RUNNER, /announceTask2Complete,\s*\n\s*'runTask2CompleteAnnouncementJobs'/);
  });
});

/**
 * `project.prototype_qa_reviewed` — QAP §7; docs/phase-4-implementation-
 * traceability.md's P4-QAP-AGENT-DEF row. `record_prototype_qa_verdict`
 * (`20260928100000_a_ui_version_moves_only_where_the_doors_lead.sql`) has
 * emitted this for every verdict since it was written, and nothing ever
 * subscribed — the same "found, not built" shape this file's other three
 * handlers were added to close. `handleReviewPrototypeBuild`
 * (`src/modules/qa/handlers.ts`) deliberately never touches
 * `projects.deliverables.status`, so a `qa_pass` build sat waiting for a
 * human to notice it with nothing telling them to look — a missing
 * notification, not a missing gate. Live-verified against a scratch Postgres
 * (`scripts/apply-migrations-locally.sh`, KEEP=1): a `record_prototype_qa_
 * verdict(..., 'qa_pass', ...)` call writes exactly one `core.outbox_events`
 * row of type `project.prototype_qa_reviewed` with
 * `{outcome, projectId, deliverableId}`, and red-proved — removing the
 * catalog subscription below makes `subscribersFor` return `[]` for that
 * event; restoring it returns `['crm:announcePrototypeQaPassed']` again.
 */
describe('D. PrototypeQAPassed — the notification, not a second approval mechanism', () => {
  test('announcePrototypeQaPassed filters to qa_pass; qa_changes_required is the revision loop\'s job, not this handler\'s', () => {
    const fn = handlerFor('announcePrototypeQaPassed');
    assert.match(fn, /if \(event\.outcome !== 'qa_pass'\)/);
    assert.match(fn, /outcome: 'not_mine'/);
  });

  test('it writes nothing to deliverables or prototype_artifacts — the human Submit-for-review click stays the real gate', () => {
    const fn = handlerFor('announcePrototypeQaPassed');
    assert.doesNotMatch(fn, /\.from\('deliverables'\)|\.from\('prototype_artifacts'\)|update.*status/i);
  });

  test('project.prototype_qa_reviewed now has exactly the one subscriber this PR wires', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.prototype_qa_reviewed'], ['crm:announcePrototypeQaPassed']);
  });

  test('the handler is registered with a job kind and reachable from HANDLERS', () => {
    assert.ok(HANDLERS.includes('crm:announcePrototypeQaPassed'));
    assert.equal(HANDLER_JOB_KIND['crm:announcePrototypeQaPassed'], 'prototype_qa_passed.announce');
  });

  test('the runner drains this job kind', () => {
    assert.match(RUNNER, /const PROTOTYPE_QA_PASSED_JOB_KIND = HANDLER_JOB_KIND\['crm:announcePrototypeQaPassed'\]/);
    assert.match(RUNNER, /announcePrototypeQaPassed,\s*\n\s*'runPrototypeQaPassedAnnouncementJobs'/);
  });

  test('the idempotency key is per-deliverable, matching the SQL door\'s one-shot qa_reviewed_at gate', () => {
    assert.match(handlerFor('announcePrototypeQaPassed'), /externalRef: `prototype-qa-passed:\$\{event\.deliverableId\}`/);
  });
});
