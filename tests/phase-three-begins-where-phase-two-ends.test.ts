import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';

/**
 * Phase 3 begins where Phase 2 ends — Master §3, §14, §15, §22; G-277.
 *
 * G-258 built the kickoff gate and emitted `project.phase_three_ready` into
 * nothing, recording at the time that this was deliberate — *"exactly as Phase
 * 1 emitted `opportunity.handed_off` with no receiver until Phase 2 existed."*
 * This is the receiver, and the first Phase 3 unit for the same reason G-250
 * was the first Phase 2 one: every later unit hangs off a workspace row.
 *
 * The assertions that matter here are the two the specification repeats most:
 * **one workspace per project** (§3's start condition and §22's duplicate-event
 * row are the same constraint), and **Phase 2 must actually be complete** —
 * read from the row, not from the event that woke the handler.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260918140000_phase_three_begins_where_phase_two_ends.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const KICKOFF = read('supabase/migrations/20260917160000_the_kickoff_gate.sql');
const HANDLERS_TS = read('src/modules/projects/handlers.ts');
const HANDLER = HANDLERS_TS.slice(HANDLERS_TS.indexOf('`project.phase_three_ready` → start Phase 3'));
const RUNNER = read('app/api/jobs/run/route.ts');

const door = (() => {
  const start = SQL.indexOf('create or replace function projects.start_phase_three');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. the event Phase 2 already emits finally has a receiver', () => {
  test('Phase 2 emits it, and said so at the time', () => {
    // The positive twin: if `record_kickoff` stopped emitting, this whole unit
    // would be a subscription to nothing and every assertion below would still
    // pass on its own.
    assert.match(KICKOFF, /'project\.phase_three_ready'/);
    assert.match(KICKOFF, /Nothing consumes it yet/);
  });

  test('and the catalog now subscribes exactly one handler to it', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.phase_three_ready'], ['projects:startPhaseThree']);
    assert.ok(HANDLERS.includes('projects:startPhaseThree'));
    assert.equal(HANDLER_JOB_KIND['projects:startPhaseThree'], 'phase_three.start');
  });

  test('the runner drains that job kind, so the handler is reachable', () => {
    // The defect this repository found six times in Phase 2: a handler with no
    // caller. A subscription that queues a job nothing drains is the same
    // shape wearing an event.
    assert.match(RUNNER, /const PHASE_THREE_JOB_KIND = HANDLER_JOB_KIND\['projects:startPhaseThree'\]/);
    assert.match(RUNNER, /handlePhaseThreeReady/);
    assert.match(RUNNER, /PHASE_THREE_JOB_KIND,\s*\n\s*handlePhaseThreeReady/);
  });

  test('the handler decides nothing — the door does, under the lock', () => {
    assert.match(HANDLER, /rpc\('start_phase_three', \{ p_project_id: projectId \}/);
    assert.doesNotMatch(HANDLER, /from\('phase_two'\)|\.state ===|insert/i);
  });

  test('and the project comes from the job subject, never the payload', () => {
    assert.match(HANDLER, /const projectId = typeof envelope\.subjectId === 'string' \? envelope\.subjectId : null/);
    assert.match(
      HANDLER.replace(/\n\s*\*\s?/g, ' '),
      /a payload is a claim anybody who can write an event could forge/,
    );
  });
});

describe('B. one workspace per project, which is the idempotency', () => {
  test('the column is UNIQUE, not merely checked', () => {
    // §3's start condition and §22's duplicate-event row are the same rule.
    // A check-then-insert has a gap a replayed event fits through.
    assert.match(SQL, /project_id\s+uuid not null unique references projects\.projects\(id\)/);
  });

  test('the project is locked before anything is decided', () => {
    assert.match(door, /select p\.\* into v_project from projects\.projects p where p\.id = p_project_id for update/);
    assert.ok(door.indexOf('for update') < door.indexOf('from projects.phase_three'));
  });

  test('a replay answers already_started WITH the existing id', () => {
    // §22: "return existing artifact/version idempotently." Returning the id
    // is what makes the replay learn nothing new rather than fail.
    assert.match(door, /'already_started'::text, v_existing\.id/);
  });

  test('and the handler treats that as success, not failure', () => {
    assert.match(HANDLER, /case 'already_started':/);
    assert.match(
      HANDLER.replace(/\n\s*\/\/ ?/g, ' '),
      /Succeeded, not failed — the world is in the state the event asked for/,
    );
  });
});

describe('C. Phase 2 must actually be complete', () => {
  test('read from the phase_two ROW, not from the event', () => {
    assert.match(door, /if v_phase_two\.state <> 'completed' then/);
    assert.match(door, /'phase_two_incomplete'::text/);
    assert.match(PROSE, /an event is a claim about the past and the row is the present/);
  });

  test('a project with no Phase 2 at all is its own answer', () => {
    // Different from incomplete, and worth telling apart: one is a phase that
    // has not finished and the other is a project that never had one.
    assert.match(door, /'no_phase_two'::text/);
  });

  test('both refusals are PERMANENT in the handler', () => {
    // Retrying cannot complete somebody else's phase, and a job that keeps
    // trying hides the blocker behind an attempt counter.
    const incomplete = HANDLER.slice(HANDLER.indexOf("case 'phase_two_incomplete':"), HANDLER.indexOf("case 'unknown_project':"));
    assert.equal((incomplete.match(/permanent: true/g) ?? []).length, 2);
    assert.match(HANDLER.replace(/\n\s*\/\/ ?/g, ' '), /hides the blocker behind an attempt counter/);
  });

  test('but a database that did not answer is transient', () => {
    assert.match(HANDLER, /permanent: false, detail: `the door did not answer/);
  });
});

describe('D. the state model is Master §14’s, and stopping says why', () => {
  test('every state §14 names is expressible', () => {
    for (const state of [
      'not_started', 'context_loading', 'screen_definition', 'theme_generation',
      'internal_review', 'admin_review', 'client_review', 'revision',
      'final_confirmation', 'locked', 'completed',
    ]) {
      assert.match(SQL, new RegExp(`'${state}'`), `§14's ${state} cannot be stored`);
    }
  });

  test('and so is every waiting and escalation state', () => {
    for (const state of [
      'waiting_client', 'waiting_admin', 'waiting_review', 'waiting_designer',
      'blocked_requirement', 'scope_escalation', 'revision_limit_escalation',
    ]) {
      assert.match(SQL, new RegExp(`'${state}'`), `${state} cannot be stored`);
    }
  });

  test('a stopped phase may not be entered silently', () => {
    // §22: the three states a person has to act on must show why. Proven on a
    // scratch Postgres: setting `scope_escalation` with no reason violates
    // `phase_three_stop_says_why`.
    assert.match(SQL, /constraint phase_three_stop_says_why/);
    assert.match(SQL, /check \(state not in \('blocked_requirement', 'scope_escalation', 'revision_limit_escalation'\)/);
  });

  test('a completed phase says when', () => {
    assert.match(SQL, /constraint phase_three_completion_is_dated/);
    assert.match(SQL, /check \(state <> 'completed' or completed_at is not null\)/);
  });
});

describe('E. the boundary Phase 3 must not cross', () => {
  test('there is nowhere to put a design, a prototype or a route', () => {
    // Master §1: Phase 3 "does not create the complete final UI or functional
    // product." Same doctrine as G-256's plan schema and G-273's test: the
    // boundary is held by the schema having nowhere to hold the thing.
    const table = SQL.slice(SQL.indexOf('create table if not exists projects.phase_three'), SQL.indexOf('create index'));
    for (const forbidden of ['component', 'route', 'prototype', 'html', 'css', 'figma_node']) {
      assert.doesNotMatch(table, new RegExp(`\\b${forbidden}`), `phase_three can hold a ${forbidden}`);
    }
    assert.match(PROSE, /the boundary is held by the schema having nowhere to put the thing it must not hold/);
  });

  test('it REFERENCES Phase 2 rather than copying it', () => {
    // §6's first cost-control line is reuse. A copy is a second source that
    // drifts from the first.
    assert.match(SQL, /phase_two_id\s+uuid not null references projects\.phase_two\(id\) on delete restrict/);
    const table = SQL.slice(SQL.indexOf('create table if not exists projects.phase_three'), SQL.indexOf('create index'));
    assert.doesNotMatch(table, /handoff_id|quotation|scope_version_id|kickoff/);
  });

  test('the revision limit is configurable, not compiled in', () => {
    // §16 says "configured limit" repeatedly, and a number inside a door is
    // not configured.
    assert.match(SQL, /client_revision_limit int not null default 3/);
    assert.match(SQL, /check \(client_revision_limit between 1 and 10\)/);
    assert.match(PROSE, /a number compiled into a door is not configured/);
  });

  test('the count is CLIENT rounds only, and says so', () => {
    assert.match(PROSE, /the limit exists to bound what the CLIENT can ask for/);
    assert.match(SQL, /client_revision_count int not null default 0/);
  });
});

describe('F. the guards every table and door in this repository carries', () => {
  test('tenancy: both org-scoped foreign keys are guarded', () => {
    assert.match(SQL, /core\.enforce_parent_org\('project_id', 'projects\.projects'\)/);
    assert.match(SQL, /core\.enforce_parent_org\('phase_two_id', 'projects\.phase_two'\)/);
    assert.match(SQL, /core\.freeze_organization_id\(\)/);
  });

  test('RLS on, forced, internal-only, and no write policy at all', () => {
    assert.match(SQL, /alter table projects\.phase_three enable row level security/);
    assert.match(SQL, /alter table projects\.phase_three force row level security/);
    assert.match(SQL, /create policy phase_three_select on projects\.phase_three\s*\n\s*for select to authenticated/);
    assert.doesNotMatch(SQL, /for (insert|update|delete|all) (to|on) /);
    assert.match(PROSE, /Every mutation goes through a door below/);
  });

  test('the door is security definer with an empty search_path', () => {
    assert.match(SQL, /security definer\s*\nset search_path = ''/);
  });

  test('an unattended caller is refused unless it is the service role', () => {
    // The trigger is an EVENT, so the service role must pass; a person may
    // also repair a lost one, which is why the actor path exists.
    assert.match(door, /if v_actor is null and \(select auth\.role\(\)\) is distinct from 'service_role' then/);
    assert.match(door, /'no_actor'::text/);
  });

  test('an authenticated caller is tenancy-checked', () => {
    assert.match(door, /v_project\.organization_id is distinct from \(select core\.current_organization_id\(\)\)/);
    assert.match(door, /not \(select core\.can_write\(\)\)/);
  });

  test('not callable by the world', () => {
    assert.match(SQL, /revoke all on function projects\.start_phase_three\(uuid\) from public, anon/);
    assert.match(SQL, /grant execute on function projects\.start_phase_three\(uuid\) to authenticated, service_role/);
  });

  test('it audits and announces inside the same transaction', () => {
    assert.match(door, /perform core\.record_audit\(/);
    assert.match(door, /perform core\.emit_event\(/);
    assert.match(SQL, /'project\.phase_three_started'/);
    assert.match(SQL, /insert into core\.event_types/);
  });
});

describe('G. it starts the phase and nothing else', () => {
  test('nobody is messaged', () => {
    // Master §7.1 gives the PM an announcement and it is deliberately its own
    // unit: a phase that begins by messaging a client is the one step nobody
    // can undo.
    assert.doesNotMatch(door, /send_outbound_message|conversation_messages|whatsapp/i);
    // The handler BODY, not its doc comment: the comment explains why nothing
    // is sent, and a check that read that as sending would forbid the
    // explanation.
    const body = HANDLER.slice(HANDLER.indexOf('export async function handlePhaseThreeReady'));
    assert.doesNotMatch(body, /send_outbound_message|announce|dispatchMessage|conversation_messages/i);
    assert.match(
      HANDLER.replace(/\n\s*\*\s?/g, ' '),
      /a phase that began by messaging a client is the one part of this flow nobody could undo/,
    );
  });

  test('and no design artifact is created', () => {
    assert.doesNotMatch(door, /theme|colour|color|figma/i);
  });
});
