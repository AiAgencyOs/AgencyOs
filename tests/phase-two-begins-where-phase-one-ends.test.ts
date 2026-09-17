import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, SUBSCRIPTIONS, subscribersFor } from '../src/lib/events/catalog.ts';

/**
 * Phase 2 begins where Phase 1 ends — Master Flow §5.1–§5.3, PM §6 PM-01/02.
 *
 * PH1-CLS-002 built the WON handoff packet and wrote down why nothing consumed
 * it: both agents were disabled, so the row would "sit at `queued` with no
 * receiver — not a defect". BLK-002 was answered on 2026-09-13. This is the
 * receiver, and what is asserted here is the two decisions it rests on: that
 * Phase 2 starts at the BINDING rather than at the win, and that starting it
 * contacts nobody.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260916130000_phase_two_begins_where_phase_one_ends.sql');
const HANDLERS = read('src/modules/projects/handlers.ts');
const ROUTE = read('app/api/jobs/run/route.ts');
const HANDOFF = read('supabase/migrations/20260911180000_a_deal_that_is_handed_off.sql');
/** The migration's prose with its comment markers folded away. */
const PROSE = MIGRATION.replace(/\n--\s?/g, ' ');
/** Just the handler, so an assertion about it cannot be satisfied by another one. */
const HANDLER = HANDLERS.slice(HANDLERS.indexOf('`project.handoff_bound` → start Phase 2'));
/** Phase 1's own migration, comment markers folded, so an assertion is not about line wrapping. */
const HANDOFF_PROSE = () => HANDOFF.replace(/\n--\s?/g, ' ');

describe('A. the moment Phase 2 can start is the binding, not the win', () => {
  test('the handoff is written at the win with NO project — so the win cannot be the trigger', () => {
    // Phase 1's own migration says it: the packet is recorded by an AFTER
    // trigger on the transition, "with no project yet, and conversion BINDS
    // its project to that row".
    assert.match(HANDOFF_PROSE(), /with no project yet, and conversion BINDS its project to that row/);
    // So the subscription is NOT on the win's event.
    assert.equal(subscribersFor('opportunity.handed_off').length, 0, 'the win still has no subscriber, and should not');
  });

  test('the binding emits an event of its own, held at the row', () => {
    assert.match(MIGRATION, /insert into core\.event_types \(type, description, canonical\) values\s*\n\s*\('project\.handoff_bound'/);
    assert.match(MIGRATION, /create trigger handoffs_emit_bound\s*\n\s*after update of project_id on ai\.handoffs/);
    // Held at the row rather than inside the 400-line function, so a repair
    // run or a direct write emits it too.
    assert.match(PROSE, /Held at the row, not in the function/);
    assert.doesNotMatch(MIGRATION, /create or replace function sales\.record_won_handoff/, 'the door is not regenerated to add one statement');
  });

  test('only a real binding of the right packet emits', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function ai.emit_handoff_bound'));
    // A rewrite of the same project is not a binding.
    assert.match(fn, /old\.project_id is distinct from new\.project_id/);
    // And only the sales → project_manager packet for an opportunity.
    assert.match(fn, /new\.from_agent = 'sales'/);
    assert.match(fn, /new\.to_agent = 'project_manager'/);
    assert.match(fn, /new\.subject_type = 'opportunity'/);
  });
});

describe('B. one Phase 2 per project, and nothing invented', () => {
  test('the run is unique per project — the idempotency is a constraint, not a check', () => {
    assert.match(MIGRATION, /project_id\s+uuid not null unique references projects\.projects\(id\)/);
  });

  test('the door takes the project lock before it decides', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function projects.start_phase_two'));
    const lock = fn.indexOf('for update;');
    const existing = fn.indexOf('from projects.phase_two pt');
    assert.ok(lock > 0 && existing > lock, 'a replayed event and a repair must not both pass the check');
  });

  test('no packet is a named refusal, never a Phase 2 with no inherited context', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function projects.start_phase_two'));
    assert.match(fn, /return query select 'no_handoff'::text/);
    assert.match(PROSE, /Block invalid\/incomplete handoff instead of inventing/);
    for (const name of ['started', 'already_started', 'no_handoff', 'unknown_project', 'no_actor', 'forbidden']) {
      assert.match(fn, new RegExp(`'${name}'::text`), `${name} is documented but never returned`);
    }
  });

  test('the packet is REFERENCED, never copied', () => {
    // Every fact in it is owned by a row Phase 1 already wrote; a second copy
    // is a second source that drifts.
    assert.match(MIGRATION, /handoff_id\s+uuid not null references ai\.handoffs\(id\)/);
    // The COLUMNS, not the comments: the comment explains which facts are
    // referenced rather than copied, so it names them on purpose.
    const table = MIGRATION.slice(MIGRATION.indexOf('create table if not exists projects.phase_two'), MIGRATION.indexOf('comment on table projects.phase_two'));
    const columns = table
      .split('\n')
      .map((l) => l.replace(/--.*$/, '').trim())
      .filter((l) => /^[a-z_]+\s+(uuid|text|timestamptz|int|boolean|jsonb)/.test(l))
      .map((l) => l.split(/\s+/)[0]);
    assert.deepEqual(columns.sort(), [
      'blocked_reason', 'completed_at', 'context_loaded_at', 'created_at', 'handoff_id', 'id',
      'kickoff_at', 'organization_id', 'pm_agent_key', 'project_id', 'started_at', 'state', 'updated_at',
    ], 'a column carrying a fact the handoff already owns is a second source that drifts');
  });

  test('a completed phase says when, and a kickoff does too', () => {
    assert.match(MIGRATION, /check \(\(state = 'completed'\) = \(completed_at is not null\)\)/);
    assert.match(MIGRATION, /check \(state not in \('kickoff_sent', 'completed'\) or kickoff_at is not null\)/);
  });

  test('the phase state is the PM’s, and it is not the project’s status', () => {
    // PM §11's model spans onboarding, finance and planning; projects.status
    // is planning/onboarding/active and is a different fact.
    for (const state of ['context_loading', 'waiting_client', 'waiting_admin', 'waiting_finance', 'waiting_planning', 'pre_kickoff_check', 'kickoff_ready', 'kickoff_sent', 'completed']) {
      assert.match(MIGRATION, new RegExp(`'${state}'`), `${state} is in PM §11 and not in the column`);
    }
  });

  test('it carries the tenancy discipline every org-scoped table here carries', () => {
    assert.match(MIGRATION, /enforce_parent_org\('project_id', 'projects\.projects'\)/);
    assert.match(MIGRATION, /enforce_parent_org\('handoff_id', 'ai\.handoffs'\)/);
    assert.match(MIGRATION, /core\.freeze_organization_id\(\)/);
    assert.match(MIGRATION, /alter table projects\.phase_two enable row level security/);
    assert.match(MIGRATION, /core\.is_internal\(\)/, 'a client never reads the agency’s own phase state');
  });
});

describe('C. starting Phase 2 contacts nobody', () => {
  test('neither the migration nor the handler sends anything', () => {
    for (const [name, text] of [['migration', MIGRATION], ['handler', HANDLER]] as const) {
      assert.doesNotMatch(text, /send_outbound_message|sendMessage|whatsapp|template/i, `${name} reaches a client`);
    }
    assert.match(PROSE, /It does not contact the client/);
  });

  test('and it bills nobody, though ADM-105 now has it install the plan', () => {
    // The door itself still knows nothing about money.
    assert.doesNotMatch(MIGRATION, /invoice|payment|finance\./i);
    // The handler installs the locked 30/20/30/20 structure (ADM-105) — a plan
    // of milestones nobody has been billed for. What it must still not do is
    // issue an invoice or record a payment: those are Finance's own doors,
    // behind Admin verification, and a phase-start reaching them would bill a
    // client for a phase that has not been kicked off.
    assert.match(HANDLER, /installLockedPaymentStructure/);
    assert.doesNotMatch(HANDLER, /issue_milestone_invoice|record_payment|invoices|payment_submissions/);
  });
});

describe('D. the handler is thin, and the decisions are in the door', () => {
  test('it reads the project from the JOB, never from the payload', () => {
    assert.match(HANDLER, /envelope\.subjectId/);
    // The payload's own fields are a claim anybody who can write an event
    // could forge; the row is the fact.
    assert.doesNotMatch(HANDLER, /payload\.handoff_id|envelope\.event/);
    assert.match(HANDLER.replace(/\n \* ?/g, ' '), /the payload is a claim anybody who can write an event could forge/);
  });

  test('a database that did not answer is retried; a missing packet is not', () => {
    assert.match(HANDLER, /if \(error\) \{[\s\S]{0,260}permanent: false/);
    assert.match(HANDLER, /case 'no_handoff':[\s\S]{0,300}permanent: true/);
    // Both settled outcomes succeed — `already_started` is the replay this is
    // built to survive.
    assert.match(HANDLER, /case 'started':\s*\n\s*case 'already_started':/);
  });

  test('it is wired: a handler, a job kind, a subscription and a drain', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.handoff_bound'], ['projects:startPhaseTwo']);
    assert.equal(HANDLER_JOB_KIND['projects:startPhaseTwo'], 'phase_two.start');
    assert.match(ROUTE, /PHASE_TWO_JOB_KIND,\s*\n\s*handleHandoffBound,/);
    // Beside the unlocks, ahead of the agent batch: pure database work should
    // not wait behind a model call.
    const phaseTwoAt = ROUTE.indexOf('const phaseTwo = await runEventJobs');
    const agentsAt = ROUTE.indexOf('AGENT_BATCH');
    assert.ok(phaseTwoAt > 0 && agentsAt > phaseTwoAt);
  });
});
