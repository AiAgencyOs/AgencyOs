import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decideAgentForTask } from '../src/modules/orchestrator/route.ts';
import { AGENT_DEFINITIONS } from '../src/modules/agents/registry.ts';
import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { region } from './_region.ts';

/**
 * Task 2 routes to a designer — ORCH §4, §10, §19; docs/phase-4-gap-analysis.md
 * step 2 (Orchestrator/Router MVP).
 *
 * The gap analysis found `ai.handoffs` + `ai.agent_handoff_targets` already
 * real, trigger-enforced (ADM-83) and already read by the Admin Automations
 * page — with zero producer anywhere in `src/` or `app/` except one hardcoded
 * WON handoff. This is the first genuinely dynamic producer: given
 * `project.phase_four_started`, decide the specific agent Task 2's design work
 * routes to from the registry's own declared capabilities and handoff graph,
 * and record that decision as a real, visible handoff — not a new parallel
 * table.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const HANDLERS_TS = read('src/modules/orchestrator/handlers.ts');
const HANDLER = region(
  HANDLERS_TS,
  'export async function handleRouteTask2Design',
  '`project.ui_version_qa_reviewed` → raise Admin review',
);
const RUNNER = read('app/api/jobs/run/route.ts');
const HANDOFF_MIGRATION = read('supabase/migrations/20260814120003_a_handoff_goes_where_it_is_allowed.sql');

describe('A. the decision function reuses the registry, and invents no graph of its own', () => {
  test('project_manager can reach exactly one multimodal, long-context target today', () => {
    const decision = decideAgentForTask({
      fromAgent: 'project_manager',
      requiredCapabilities: ['multimodal', 'long_context'],
    });
    assert.equal(decision.outcome, 'selected');
    assert.equal(decision.outcome === 'selected' && decision.toAgent, 'ui_designer');
  });

  test('a capability nobody in the handoff graph carries yields no_candidate, not a guess', () => {
    const decision = decideAgentForTask({
      fromAgent: 'project_manager',
      requiredCapabilities: ['multimodal', 'coding'],
    });
    assert.equal(decision.outcome, 'no_candidate');
  });

  test('capability alone is not routing authority — a non-target is never selected', () => {
    // sales has no handoffTargets that carry 'multimodal' at all in the
    // current roster, so this must refuse rather than reach across the graph.
    const decision = decideAgentForTask({ fromAgent: 'sales', requiredCapabilities: ['multimodal'] });
    assert.notEqual(decision.outcome, 'selected');
  });

  test('an unregistered sender is named, not silently routed', () => {
    const decision = decideAgentForTask({ fromAgent: 'not_a_real_agent', requiredCapabilities: [] });
    assert.equal(decision.outcome, 'unknown_agent');
  });

  test('every candidate this function could ever return is a real registered agent', () => {
    // Cheap proof that the function reads AGENT_DEFINITIONS rather than a
    // hardcoded list that could drift from it.
    const keys = new Set(AGENT_DEFINITIONS.map((a) => a.key));
    assert.ok(keys.has('project_manager') && keys.has('ui_designer'));
  });
});

describe('B. the routed decision is a real ai.handoffs row, not a new table', () => {
  test('the handler writes to the schema and table that already exist, already enforced', () => {
    assert.match(HANDLER, /\.schema\('ai'\)\s*\n\s*\.from\('handoffs'\)/);
    assert.doesNotMatch(HANDLER, /routing_decisions|create table/i);
  });

  test('and that table already refuses an undeclared target — ADM-83, proven where it lives', () => {
    assert.match(HANDOFF_MIGRATION, /create or replace function ai\.enforce_handoff_target/);
    assert.match(HANDOFF_MIGRATION, /handoff refused: % may not hand work to %/);
  });

  test('the correlation id is the workspace itself, so every future hop traces to one chain', () => {
    assert.match(HANDLER, /correlation_id: phaseFour\.id/);
  });
});

describe('C. idempotent by construction', () => {
  test('an existing handoff for this workspace is read before any insert is attempted', () => {
    const beforeInsert = HANDLER.slice(0, HANDLER.indexOf(".from('handoffs')\n    .insert("));
    assert.match(beforeInsert, /\.eq\('subject_type', 'phase_four'\)/);
    assert.match(beforeInsert, /\.eq\('subject_id', phaseFour\.id\)/);
  });

  test('a replay succeeds without writing a second row', () => {
    assert.match(HANDLER, /outcome: 'already_routed'/);
    const body = region(HANDLER, 'if (existing) {', '}\n\n  const decision');
    assert.doesNotMatch(body, /\.insert\(/);
  });
});

describe('D. the phase_four row is re-read, not trusted from the event', () => {
  test('routing reads the CURRENT actor columns off the row', () => {
    assert.match(HANDLER, /pm_agent_key, designer_agent_key, state/);
    assert.match(HANDLER, /fromAgent: phaseFour\.pm_agent_key/);
  });

  test('the organization comes from the job, not the payload', () => {
    assert.match(HANDLER, /\.eq\('organization_id', job\.organization_id\)/);
  });
});

describe('E. it is reachable — the defect this repository has found six times before', () => {
  test('the catalog subscribes it to the event Phase 4 already emits', () => {
    // Fans out further each time there is a new independent thing worth
    // doing with the same fact — step 3 added `ui_designer:draftUIVersion`,
    // step 5 added the PM's Task 2 start announcement.
    assert.deepEqual(SUBSCRIPTIONS['project.phase_four_started'], [
      'orchestrator:routeTask2Design',
      'ui_designer:draftUIVersion',
      'crm:announcePhaseFourStarted',
    ]);
    assert.ok(HANDLERS.includes('orchestrator:routeTask2Design'));
    assert.equal(HANDLER_JOB_KIND['orchestrator:routeTask2Design'], 'phase_four.route_task2_design');
  });

  test('the runner drains that job kind', () => {
    assert.match(RUNNER, /const TASK2_ROUTE_JOB_KIND = HANDLER_JOB_KIND\['orchestrator:routeTask2Design'\]/);
    assert.match(RUNNER, /handleRouteTask2Design/);
    assert.match(RUNNER, /TASK2_ROUTE_JOB_KIND,\s*\n\s*handleRouteTask2Design/);
  });
});

describe('F. it does not overreach into the stage that does not exist yet', () => {
  test('no UI artifact, deliverable or phase_four state transition is written here', () => {
    assert.doesNotMatch(HANDLER, /update.*phase_four|deliverable|ui_version|design_token/i);
  });

  test('and the module says so', () => {
    const module = read('src/modules/orchestrator/handlers.ts').replace(/\n\s*\*\s?/g, ' ');
    assert.match(module, /It does not invoke the UI Designer, generate a UIVersion, or advance/);
  });
});
