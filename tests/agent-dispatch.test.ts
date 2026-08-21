import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { AGENT_KEYS } from '../src/modules/agents/registry.ts';
import { RUNNER_SOURCE } from './_runner-source.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const workflows = read('app/api/jobs/run/workflows.ts');
/**
 * The same file with its prose removed.
 *
 * Every "this must NOT appear" assertion runs against this: `workflows.ts`
 * explains at length why an agent cannot bring its own kill switch, and an
 * explanation of a prohibition necessarily contains the words it forbids.
 * Fifth time this repository has caught that.
 */
const workflowCode = workflows
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('//'))
  .join('\n');
const agentRun = read('app/api/jobs/run/agent-run.ts');
const route = read('app/api/jobs/run/route.ts');

const seed = readdirSync(join(root, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => read(`supabase/migrations/${f}`))
  .join('\n');

/**
 * An agent is enabled when something can send it work.
 *
 * This file exists because of a question with an uncomfortable answer. Twelve
 * of ADM-82's thirteen agents were installed disabled; asked to enable them,
 * the honest reply was that flipping the flag would change nothing — the
 * runner named one agent in a module-level constant, so eleven of the twelve
 * had no queue, and the Admin screen would have shown twelve agents running
 * while none of them could receive anything.
 *
 * What these assert is the rule that replaced the constant, and the one that
 * keeps `enabled` from becoming decoration again.
 */
describe('A. the runner dispatches, rather than knowing one agent', () => {
  test('no agent key is hard-coded anywhere in it', () => {
    // `const AGENT_KEY = 'requirement_collector'` was the whole problem.
    assert.doesNotMatch(route, /const AGENT_KEY =/);
    assert.doesNotMatch(route, /const JOB_KIND =/);
    assert.doesNotMatch(agentRun, /'requirement_collector'/);
  });

  test('the agent comes from the job, and the job from the registry', () => {
    assert.match(route, /const workflow = workflowFor\(job\.kind\)/);
    assert.match(route, /\.eq\('key', workflow\.agentKey\)/);
    assert.match(route, /for \(const kind of AGENT_JOB_KINDS\)/);
  });

  test('a job kind nothing implements fails loudly rather than being claimed forever', () => {
    assert.match(route, /if \(!workflow\) \{[\s\S]{0,300}?no agent workflow is registered/);
  });

  test('and every agent a workflow names is one the registry defines', () => {
    const bound = [...workflows.matchAll(/^\s*agentKey: '([a-z_]+)',/gm)].map((m) => m[1] ?? '');
    assert.ok(bound.length >= 2, `only ${bound.length} workflow(s) found — the parser drifted`);
    for (const key of bound) {
      assert.ok(AGENT_KEYS.includes(key), `a workflow dispatches to "${key}", which is not defined`);
    }
  });
});

describe('B. what a workflow may not bring its own version of', () => {
  test('the autonomy gate, the kill switch and the registry lookup are the route’s', () => {
    // An agent that could bring its own would be an agent that could skip it.
    assert.match(route, /mayAgentRun\(agent\.autonomy_level\)/);
    assert.doesNotMatch(workflowCode, /mayAgentRun/);
    assert.doesNotMatch(workflowCode, /\.from\('agents'\)/);
    assert.doesNotMatch(workflowCode, /enabled/);
  });

  test('the provider and the step trace are the shared helper’s', () => {
    assert.match(agentRun, /resolveProvider\(ctx\.agent\.default_model\)/);
    assert.doesNotMatch(workflowCode, /resolveProvider/);
    assert.doesNotMatch(workflowCode, /generateStructured/);
    assert.doesNotMatch(workflowCode, /from\('agent_steps'\)/);
  });

  test('and the gate is passed before the model is reached', () => {
    // The one ordering that matters, asserted across the split: the route
    // gates, and only then does a workflow reach `agent-run.ts` for a model.
    assert.ok(
      RUNNER_SOURCE.indexOf('mayAgentRun(agent.autonomy_level)') <
        RUNNER_SOURCE.indexOf('resolveProvider(ctx.agent.default_model)'),
      'an agent that may not act must not reach the model',
    );
  });
});

describe('C. the support agent names a kind of work, never who pays', () => {
  const schema = read('src/modules/projects/schema.ts');

  test('its schema has no field for coverage, and is strict', () => {
    // Doc 18 §6 separates "what kind of thing is this" from "is it covered".
    // §35: "Never classify new scope as maintenance to avoid approval."
    //
    // The agent answers the first and is never asked the second — not told
    // not to, GIVEN NO FIELD. A model cannot return a key the schema does not
    // declare, and `.strict()` refuses one that arrives anyway.
    const triage = schema.slice(schema.indexOf('export const maintenanceTriageSchema'));
    const body = triage.slice(0, triage.indexOf('export type MaintenanceTriage'));
    assert.match(body, /ticketType: z\.enum\(MAINTENANCE_TICKET_TYPES\)/);
    assert.match(body, /rationale: z\.string\(\)/);
    assert.doesNotMatch(body, /coverage/);
    assert.match(body, /\.strict\(\)/);
  });

  test('and the write names one column', () => {
    const triage = workflowCode.slice(workflowCode.indexOf('const MAINTENANCE_TRIAGE'));
    // Anchored on the UPDATE itself. Two earlier drafts anchored on
    // `.from('maintenance_items')` and on the first `.eq(` after it — the
    // first match is the SELECT that loads the ticket, so both read the wrong
    // statement and reported a defect that was not there.
    // Scoped to statements that touch the TICKET. The workflow also settles
    // its job four times and parks it once, and a matcher over every
    // `.update(` counted six writes and reported the wrong one — the third
    // draft of this assertion, and the third time the anchor was the bug
    // rather than the code.
    const writes = [...triage.matchAll(/\.from\('maintenance_items'\)[\s\S]{0,300}?;/g)]
      .map((m) => m[0])
      .filter((stmt) => stmt.includes('.update('));
    assert.equal(writes.length, 1, `the triage workflow writes ${writes.length} times to a ticket`);
    assert.match(writes[0] ?? '', /\.update\(\{ ticket_type: validated\.data\.ticketType \}\)/);
    assert.doesNotMatch(writes[0] ?? '', /coverage/);
  });

  test('the twelve types are Doc 18 §8’s, and the database agrees', () => {
    for (const t of ['production_bug', 'security_update', 'dependency_update', 'performance',
                     'content_change', 'minor_ui', 'monitoring_alert', 'backup_recovery',
                     'access_support', 'new_feature', 'integration_change', 'upgrade_migration']) {
      assert.ok(schema.includes(`'${t}'`), `Doc 18 §8 names ${t} and the schema does not`);
      assert.ok(seed.includes(`'${t}'`), `${t} is not in the ticket_type CHECK`);
    }
  });
});

describe("C2. the project manager plans, and decides nothing else", () => {
  const schema = read('src/modules/projects/schema.ts');

  test('ADM-16 is implemented rather than re-decided', () => {
    // Granted 2026-08-13: "The breakdown from approved requirements into
    // modules, features and tasks is automatic — the AI does it without
    // proposing it for review." `break_down_requirement` was written for it
    // the same day, describes its caller in its own comments, and had none.
    const triage = workflowCode.slice(workflowCode.indexOf('const PLAN_BREAKDOWN'));
    assert.match(triage, /rpc\('break_down_requirement'/);
    // The plan is the only thing the agent contributes. The transaction, the
    // provenance, the wrong-client refusal and the idempotency are the
    // function's, already written and already tested.
    assert.doesNotMatch(triage, /insert\(/);
    assert.doesNotMatch(triage, /from\('tasks'\)/);
    assert.doesNotMatch(triage, /from\('modules'\)/);
  });

  test('and its plan has no field for status, assignee, due date or milestone', () => {
    // Doc 10 §25: "A project should be marked BLOCKED when work cannot safely
    // continue, not when an agent merely feels uncertain." §9 makes specialist
    // assignment its own act; §18 ties milestones to the payment plan, which
    // ADM-22 keeps with a human. Four absences, one pattern.
    const at = schema.indexOf('export const requirementBreakdownSchema');
    const body = schema.slice(at, schema.indexOf('export type RequirementBreakdown', at));
    assert.ok(at > 0, 'the breakdown schema was not found — the parser drifted');
    for (const forbidden of ['status', 'assignee', 'dueOn', 'due_on', 'milestone', 'blocked']) {
      assert.doesNotMatch(body, new RegExp(`\\b${forbidden}\\b`), `the plan can name ${forbidden}`);
    }
    assert.match(body, /title: z\.string\(\)/);
    assert.match(body, /priority: z\.enum\(\['p0', 'p1', 'p2', 'p3'\]\)/);
  });

  test('a retry is an ordinary outcome, not a failure', () => {
    // The function answers `already_broken_down` rather than duplicating,
    // because ADM-16 makes this automatic and a retry after a partial network
    // failure is the normal case. Treating that as a failure would requeue a
    // job whose work is already done.
    const triage = workflowCode.slice(workflowCode.indexOf('const PLAN_BREAKDOWN'));
    assert.match(triage, /already_broken_down/);
  });
});

describe('D. enabled means reachable', () => {
  test('every enabled agent has a workflow that can send it work', () => {
    // The rule this whole change exists to make true. An enabled agent with
    // no queue is the Admin screen saying an agent runs when nothing can
    // reach it — the same class as the seeded `score 82` that production
    // showed an operator for a feature nobody built.
    const enabled = new Set<string>();
    for (const m of seed.matchAll(/\(\s*'([a-z_]+)',\s*'[^']*',\s*'(?:[^']|'')*',\s*'L[012]',\s*true/g)) {
      enabled.add(m[1] ?? '');
    }
    // Both shapes of the WHERE. The first version matched `where key = '…'`
    // only, so enabling an agent with `where key in ('a', 'b')` slipped past
    // it — and the red-proof that was supposed to catch exactly that passed,
    // which is how the hole was found. A parser that reads one spelling of a
    // statement is a check that can be avoided by rephrasing it.
    for (const m of seed.matchAll(/update ai\.agents\s*\n\s*set enabled = true,[\s\S]{0,300}?where key (?:=|in)\s*\(?([^;]+?)\)?;/g)) {
      for (const key of (m[1] ?? '').matchAll(/'([a-z_]+)'/g)) enabled.add(key[1] ?? '');
    }
    assert.ok(enabled.size >= 2, `only ${enabled.size} enabled agent(s) parsed — the parser drifted`);

    const reachable = new Set(
      [...workflows.matchAll(/^\s*agentKey: '([a-z_]+)',/gm)].map((m) => m[1] ?? ''),
    );
    for (const key of enabled) {
      assert.ok(reachable.has(key), `"${key}" is enabled and no workflow can send it work`);
    }
  });

  test('and a disabled one still says why', () => {
    // `agents_disabled_reason_together` enforces it; this catches a migration
    // that would fail to apply before it is applied.
    assert.match(seed, /check \(enabled = \(disabled_reason is null\)\)/);
  });
});
