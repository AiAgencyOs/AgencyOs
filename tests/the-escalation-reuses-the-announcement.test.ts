import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { region, TO_END } from './_region.ts';

/**
 * The escalation reuses the announcement it already had — Master's own
 * "after limit: HUMAN ESCALATION," genuinely wired this time.
 *
 * Both Phase 4 revision-loop doors (`20260924100000`, `20260924110000`)
 * shipped calling `core.record_audit` for their own revision-limit-reached
 * branch, and declaring their own event type — but never called
 * `core.emit_event`, so nothing ever told a person the workspace had
 * stopped. Worse, the declared event types
 * (`project.ui_revision_limit_reached`, `project.prototype_revision_limit_
 * reached`) duplicated a mechanism this repository already had, working,
 * live, since G-309: `project.revision_limit_escalated` /
 * `crm:handleRevisionLimitEscalated`, built for Phase 3's own revision loop.
 *
 * This migration `create or replace`s both doors to emit the EXISTING event
 * instead. Live-verified on a scratch Postgres: a workspace already at its
 * revision limit, asked to revise again, writes a real
 * `core.outbox_events` row of type `project.revision_limit_escalated` with
 * `subject_type = 'phase_four'` and the exact `{projectId, revisionCount,
 * revisionLimit}` shape the existing handler already parses — no new
 * subscription, no new handler, no new schema.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260924140000_the_escalation_reuses_the_announcement.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const HANDLERS_TS = read('src/modules/crm/handlers.ts');
const SCHEMA_TS = read('src/modules/crm/schema.ts');

const uiDoor = (() => {
  const start = SQL.indexOf('create or replace function projects.revise_ui_version');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

const prototypeDoor = (() => {
  const start = SQL.indexOf('create or replace function projects.revise_prototype_build');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. both doors now emit the event, not only record it', () => {
  test('revise_ui_version calls emit_event for project.revision_limit_escalated', () => {
    assert.match(uiDoor, /perform core\.emit_event\(\s*\n\s*v_phase_four\.organization_id, 'project\.revision_limit_escalated'/);
  });

  test('revise_prototype_build calls emit_event for project.revision_limit_escalated too', () => {
    assert.match(prototypeDoor, /perform core\.emit_event\(\s*\n\s*v_phase_four\.organization_id, 'project\.revision_limit_escalated'/);
  });

  test('neither door emits or declares a new, second event type', () => {
    assert.doesNotMatch(SQL, /ui_revision_limit_reached|prototype_revision_limit_reached/);
    assert.doesNotMatch(SQL, /insert into core\.event_types/);
  });
});

describe('B. the payload matches the shape the existing handler already parses', () => {
  test('both emit {projectId, revisionCount, revisionLimit}, not a Phase-4-specific field name', () => {
    for (const door of [uiDoor, prototypeDoor]) {
      assert.match(door, /jsonb_build_object\('projectId', v_phase_four\.project_id, 'revisionCount', v_phase_four\.\w+_revision_count, 'revisionLimit', v_phase_four\.\w+_revision_limit\)/);
    }
  });
});

describe('C. the migration says why this is a reuse, not a new mechanism', () => {
  test('names the existing event and handler by name', () => {
    assert.match(PROSE, /project\.revision_limit_escalated/);
    assert.match(PROSE, /crm:handleRevisionLimitEscalated/);
  });
});

describe('D. the shared announcement text is phase-agnostic, not hardcoded to Phase 3', () => {
  test('the wording no longer says "Phase 3" or "design revisions" specifically', () => {
    assert.doesNotMatch(SCHEMA_TS, /A Phase 3 design revision limit/);
    assert.doesNotMatch(SCHEMA_TS, /Design revisions have stopped/);
    assert.match(SCHEMA_TS, /A revision limit was reached\./);
  });
});

describe('E. the idempotency key no longer collides across a project\'s two independent counters', () => {
  test('it is keyed on the event\'s own subject, not projectId alone', () => {
    const fn = region(HANDLERS_TS, 'export async function handleRevisionLimitEscalated', TO_END);
    assert.match(fn, /p_external_ref: `revision-limit:\$\{envelope\.subjectId \?\? event\.projectId\}:\$\{event\.revisionCount\}`/);
  });

  test('the fix is explained: two counters on one project can reach the same number', () => {
    const fn = region(HANDLERS_TS, 'export async function handleRevisionLimitEscalated', TO_END);
    assert.match(fn, /the identical number/);
  });
});

describe('F. it is still reachable — the existing, proven wiring is untouched', () => {
  test('project.revision_limit_escalated still routes to the one handler', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.revision_limit_escalated'], ['crm:announceRevisionLimitEscalated']);
  });
});
