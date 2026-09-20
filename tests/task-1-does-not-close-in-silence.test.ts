import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { region } from './_region.ts';

/**
 * Task 1 does not close in silence — G-309.
 *
 * The Phase 3 audit found two emitted events with zero consumers:
 * `project.revision_limit_escalated` (the revision loop stopping itself) and
 * `project.phase_three_completed` (a client confirming the UI direction).
 * Both sat in the outbox with only a same-page Admin Panel badge to show for
 * them — a person had to already be looking at the right project to notice
 * either. This wires both into the same internal-group announcer
 * `conversation.escalated` already uses, so somebody is actually told.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const CATALOG = read('src/lib/events/catalog.ts');
const HANDLERS = read('src/modules/crm/handlers.ts');
const SCHEMA = read('src/modules/crm/schema.ts');
const ROUTE = read('app/api/jobs/run/route.ts');

describe('A. the catalog actually subscribes both events', () => {
  test('project.revision_limit_escalated has a subscriber', () => {
    const subs = region(CATALOG, 'export const SUBSCRIPTIONS', 'export const HANDLER_JOB_KIND');
    assert.match(subs, /'project\.revision_limit_escalated': \['crm:announceRevisionLimitEscalated'\]/);
  });

  test('project.phase_three_completed has a subscriber', () => {
    const subs = region(CATALOG, 'export const SUBSCRIPTIONS', 'export const HANDLER_JOB_KIND');
    assert.match(subs, /'project\.phase_three_completed': \['crm:announcePhaseThreeCompleted'\]/);
  });

  test('both handlers are declared and have a job kind', () => {
    assert.match(CATALOG, /'crm:announceRevisionLimitEscalated',/);
    assert.match(CATALOG, /'crm:announcePhaseThreeCompleted',/);
    assert.match(CATALOG, /'crm:announceRevisionLimitEscalated': 'revision_limit\.announce',/);
    assert.match(CATALOG, /'crm:announcePhaseThreeCompleted': 'phase_three_completed\.announce',/);
  });
});

describe('B. the runner actually drains both job kinds', () => {
  test('both job-kind constants are read from the catalog', () => {
    assert.match(ROUTE, /const REVISION_LIMIT_JOB_KIND = HANDLER_JOB_KIND\['crm:announceRevisionLimitEscalated'\];/);
    assert.match(ROUTE, /const PHASE_THREE_COMPLETED_JOB_KIND = HANDLER_JOB_KIND\['crm:announcePhaseThreeCompleted'\];/);
  });

  test('both are actually drained through runEventJobs, not just declared', () => {
    assert.match(
      ROUTE,
      /runEventJobs\(\s*\n\s*admin,\s*\n\s*REVISION_LIMIT_JOB_KIND,\s*\n\s*handleRevisionLimitEscalated,/,
    );
    assert.match(
      ROUTE,
      /runEventJobs\(\s*\n\s*admin,\s*\n\s*PHASE_THREE_COMPLETED_JOB_KIND,\s*\n\s*handlePhaseThreeCompleted,/,
    );
  });

  test('both results reach the response, not just the log', () => {
    assert.match(ROUTE, /revisionLimitAnnouncements: revisionLimitAnnouncements\.results,/);
    assert.match(ROUTE, /phaseThreeCompletedAnnouncements: phaseThreeCompletedAnnouncements\.results,/);
  });
});

describe('C. the handlers follow the escalation announcer’s own discipline', () => {
  const revisionHandler = region(HANDLERS, 'export async function handleRevisionLimitEscalated');
  const completedHandler = region(HANDLERS, 'export async function handlePhaseThreeCompleted');

  test('a malformed payload is a permanent failure, not a retry loop', () => {
    for (const handler of [revisionHandler, completedHandler]) {
      assert.match(handler, /safeParse\(envelope\.event\)/);
      assert.match(handler, /if \(!parsed\.success\) \{\s*\n\s*return \{\s*\n\s*status: 'failed',\s*\n\s*permanent: true,/);
    }
  });

  test('an organization with no internal channel succeeds rather than fails', () => {
    for (const handler of [revisionHandler, completedHandler]) {
      assert.match(handler, /if \(!group\) \{\s*\n\s*return \{\s*\n\s*status: 'succeeded',\s*\n\s*outcome: 'no_group',/);
    }
  });

  test('idempotency is keyed on the subject, not the job or the event', () => {
    // A retried job or a redelivered event must collapse onto one message.
    assert.match(revisionHandler, /p_external_ref: `revision-limit:\$\{event\.projectId\}:\$\{event\.revisionCount\}`/);
    assert.match(completedHandler, /p_external_ref: `phase-three-completed:\$\{event\.projectId\}`/);
  });

  test('neither handler invents its own send path — both use the one provider call', () => {
    for (const handler of [revisionHandler, completedHandler]) {
      assert.match(handler, /const \{ sendWhatsAppText \} = await import\('@\/lib\/whatsapp\/send'\);/);
    }
  });
});

describe('D. the words say what happened, not a code', () => {
  test('the revision-limit announcement names the project and the count', () => {
    const fn = region(SCHEMA, 'export function revisionLimitEscalationAnnouncementFor');
    assert.match(fn, /Project: \$\{input\.projectName/);
    assert.match(fn, /Revisions used: \$\{input\.revisionCount\} of \$\{input\.revisionLimit\}/);
  });

  test('the completion announcement distinguishes Phase 4 ready from not', () => {
    const fn = region(SCHEMA, 'export function phaseThreeCompletedAnnouncementFor');
    assert.match(fn, /input\.phaseFourReady\s*\n\s*\? 'Phase 4 is ready to begin\.'/);
    assert.match(fn, /: 'Phase 4 is not yet ready/);
  });

  test('both schemas validate the exact payload the migrations emit', () => {
    assert.match(SCHEMA, /export const revisionLimitEscalatedEventSchema = z\s*\n\s*\.object\(\{\s*\n\s*projectId: z\.uuid\(\),\s*\n\s*revisionCount: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n\s*revisionLimit: z\.number\(\)\.int\(\)\.positive\(\),/);
    assert.match(SCHEMA, /export const phaseThreeCompletedEventSchema = z\s*\n\s*\.object\(\{\s*\n\s*projectId: z\.uuid\(\),\s*\n\s*phaseFourReady: z\.boolean\(\),/);
  });
});
