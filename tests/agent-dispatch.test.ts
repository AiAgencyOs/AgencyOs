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
/**
 * One workflow's code, bounded at the next section rule.
 *
 * A slice that runs to the end of the file reads the workflows that follow it,
 * so "the planner writes no row itself" started failing the moment a designer
 * that DOES write rows was added below it — a test reporting a defect in code
 * it was not looking at.
 */
const workflowSlice = (name: string): string => {
  const at = workflowCode.indexOf(`const ${name}`);
  if (at < 0) return '';
  // Bounded at the NEXT workflow declaration, not at a section rule: the rules
  // are `//` comments and `workflowCode` has already stripped them, so a slice
  // anchored on one ran to the end of the file and read every workflow below.
  const next = workflowCode.slice(at + 1).search(/\nconst [A-Z_]+: AgentWorkflow = \{/);
  return next < 0 ? workflowCode.slice(at) : workflowCode.slice(at, at + 1 + next);
};

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
    // Level AND work class. The gate used to take only the level, which is
    // why one path's argument refused seven agents.
    assert.match(route, /mayAgentRun\(agent\.autonomy_level, workflow\.workClass\)/);
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
      RUNNER_SOURCE.indexOf('mayAgentRun(agent.autonomy_level, workflow.workClass)') <
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
    const triage = workflowSlice('MAINTENANCE_TRIAGE');
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
    const triage = workflowSlice('PLAN_BREAKDOWN');
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

describe('C3. the designer draws the scope, and approves nothing', () => {
  const schema = read('src/modules/projects/schema.ts');
  const inventory = workflowSlice('SCREEN_INVENTORY');

  test('it is the first L2 workflow, and it says which class earns that', () => {
    // ADM-61 §2, "draft anything at all". Before the gate could ask which
    // work, this workflow would have been dispatched and then refused.
    assert.match(inventory, /agentKey: 'ui_designer'/);
    assert.match(inventory, /workClass: 'draft'/);
  });

  test('the inventory has no field for a status or a deliverable', () => {
    // Doc 12 §5: "Do not declare completion when required screens or states
    // are missing", "do not overwrite an approved version." Filing the
    // inventory as a design VERSION and submitting it is ADM-61 §3's
    // delivery_approval — different work, and the schema cannot express it.
    const at = schema.indexOf('export const screenInventorySchema');
    const body = schema.slice(at, schema.indexOf('export type ScreenInventory', at));
    assert.ok(at > 0, 'the inventory schema was not found — the parser drifted');
    for (const forbidden of ['status', 'deliverable', 'approved', 'version']) {
      // Substring, not `\b…\b`: every field here is camelCase, so a
      // `deliverableId` has no word boundary before `Id` and a bounded
      // pattern silently misses exactly the field being forbidden.
      assert.doesNotMatch(body, new RegExp(forbidden, 'i'), `the inventory can name ${forbidden}`);
    }
    assert.match(body, /\.strict\(\)/);
  });

  test('every screen must cover at least one scope item', () => {
    // Doc 12 §9 flags "screens with no scope/feature mapping". A screen
    // nobody agreed to pay for cannot be produced at all.
    assert.match(schema, /coversScopeItems: z\.array\(z\.string\(\)\.uuid\(\)\)\.min\(1\)/);
  });

  test('and the agent is never shown an exclusion', () => {
    // Doc 12 §20: "Excluded features not accidentally designed as
    // commitments." An agent that cannot see an exclusion cannot design one.
    // The row rule refuses the mapping regardless — that is where the rule
    // lives; this is where it is made unnecessary.
    assert.match(inventory, /\.in\('inclusion', \['included', 'optional'\]\)/);
    assert.doesNotMatch(inventory, /'excluded'/);
  });

  test('a scope item the model invented fails the run rather than the insert', () => {
    // The foreign key would refuse it and report a uuid. This reports what
    // went wrong, which is the difference between an error and a diagnosis.
    assert.match(inventory, /const known = new Set\(designable\.map/);
    assert.match(inventory, /are not in this baseline/);
  });
});

describe('C4. the sales agent reads a message, and reading it is not agreeing', () => {
  const crm = read('src/modules/crm/schema.ts');
  const intent = workflowSlice('MESSAGE_INTENT');

  test('naming what a message is, is internal work — ADM-61 §2', () => {
    // Doc 08 §12 lists 22 intents. Naming one is a reading, not a reply:
    // nothing goes to the client, so §3's client_facing never applies.
    assert.match(intent, /agentKey: 'sales'/);
    assert.match(intent, /workClass: 'internal_plan'/);
  });

  test('the whole of Doc 08 §12 is offered, including the two dangerous ones', () => {
    // `acceptance` and `approval` are the readings §14 forbids ACTING on. The
    // list is not trimmed to avoid them, because a sales agent that cannot say
    // "this client said yes" cannot tell a human there is something to check.
    for (const i of ['acceptance', 'approval', 'not_interested', 'cancellation_request']) {
      assert.match(crm, new RegExp(`'${i}',`), `§12's ${i} is missing`);
    }
    assert.match(crm, /MESSAGE_INTENTS = \[\.\.\.LEAD_INTENTS, \.\.\.PROJECT_INTENTS\]/);
  });

  test('and saying one is safe because the schema cannot say anything else', () => {
    // Business rules §5: never "treat a client's word as a fact". The label is
    // safe to write precisely because no field beside it can move a status,
    // accept a proposal, or draft the reply that would.
    const at = crm.indexOf('export const messageIntentSchema');
    assert.ok(at > 0, 'the intent schema was not found — the parser drifted');
    const body = crm.slice(at, crm.indexOf('export type MessageIntent', at));
    for (const forbidden of ['status', 'accept', 'approve', 'reply', 'confidence', 'score', 'action']) {
      assert.doesNotMatch(body, new RegExp(forbidden, 'i'), `the reading can name ${forbidden}`);
    }
    assert.match(body, /\.strict\(\)/);
  });

  test('the run writes the label and its author, and no third column', () => {
    // If this ever writes a status too, the paragraph above stops being true
    // and no database guard would notice — nothing forbids sales updating a
    // lead. The absence is the control, so the absence is what is tested.
    // Anchored past the job settles, which also call `.update(` — the first
    // match in this workflow is `jobs.update(settledSucceeded)`, not this one.
    const at = intent.indexOf(".from('conversation_messages')\n      .update(");
    assert.ok(at > 0, 'the message write was not found — the workflow drifted');
    const written = intent.slice(at, intent.indexOf('})', at));
    const columns = [...written.matchAll(/(\w+):/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(columns, ['intent', 'intent_by_agent']);
  });

  test('a message already read is not read again', () => {
    // The trigger only asks for unlabelled, client-authored messages, so a
    // relabelling job can only come from a replay. The freeze rule would
    // refuse the write; this refuses the model call, which costs money.
    assert.match(intent, /reason: 'already read'/);
    assert.match(intent, /if \(message\.intent !== null\)/);
  });
});

describe('C5. QA says what to test, and judges nothing', () => {
  const qa = read('src/modules/qa/schema.ts');
  const plan = workflowSlice('QA_TEST_PLAN');

  test('drafting a plan is draft work, and QA is the one agent that also verifies', () => {
    // ADM-82 makes `quality_assurance` the independent verifier. Drafting a
    // plan is a different act from verifying one, so enabling it for this
    // does not enlarge what it may declare complete — `mayVerify` is
    // untouched, and section §14 of check-record still asks the converse.
    assert.match(plan, /agentKey: 'quality_assurance'/);
    assert.match(plan, /workClass: 'draft'/);
  });

  test('all eleven of Doc 14 §6, and no twelfth', () => {
    // "360° QA = FUNCTIONAL + UI + API + DATABASE + INTEGRATION + E2E +
    // REGRESSION + SECURITY + PERFORMANCE + COMPATIBILITY + DEPLOYMENT/SMOKE."
    const at = qa.indexOf('export const TEST_CATEGORIES');
    const body = qa.slice(at, qa.indexOf('] as const', at));
    const found = [...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual(found, [
      'functional', 'ui', 'api', 'database', 'integration', 'e2e',
      'regression', 'security', 'performance', 'compatibility', 'smoke',
    ]);
  });

  test('and no field for a number Document 14 gives to somebody else', () => {
    // §16 performance: "AI must not invent universal thresholds."
    // §14 severity: "Exact thresholds are Admin-configurable."
    // §19 readiness: "configurable in the Admin Policy Engine."
    // §21 gates: deterministic policy, and this is a draft.
    //
    // Substring, not `\b…\b` — every field here is camelCase, so a
    // `targetLatencyMs` has no word boundary before `Latency`.
    const at = qa.indexOf('export const testPlanSchema');
    assert.ok(at > 0, 'the plan schema was not found — the parser drifted');
    const body = qa.slice(at, qa.indexOf('export type TestPlan', at));
    for (const forbidden of [
      'score', 'readiness', 'band', 'threshold', 'latency', 'target',
      'severity', 'gate', 'pass', 'block', 'release', 'approve',
    ]) {
      assert.doesNotMatch(body, new RegExp(forbidden, 'i'), `the plan can name ${forbidden}`);
    }
    assert.match(body, /\.strict\(\)/);
  });

  test('the agent is never shown an exclusion, exactly as the designer is not', () => {
    // Doc 14 §3: QA tests the approved baseline. A test written for a feature
    // nobody bought is a defect raised against work that was never owed.
    assert.match(plan, /\.in\('inclusion', \['included', 'optional'\]\)/);
    assert.doesNotMatch(plan, /'excluded'/);
  });

  test('a superseded baseline is not planned against', () => {
    // The scope can move between the freeze and the claim. Planning against
    // a superseded baseline is testing the wrong project.
    assert.match(plan, /baseline\.status !== 'active'/);
  });

  test('a scope item the model invented fails the run rather than the insert', () => {
    assert.match(plan, /const known = new Set\(testable\.map/);
    assert.match(plan, /are not in this baseline/);
  });
});

describe('C6. customer success prepares the conversation, and has none', () => {
  const crm = read('src/modules/crm/schema.ts');
  const checkIn = workflowSlice('CHECK_IN_BRIEF');

  test('preparing a check-in is internal work; having it is not', () => {
    // Doc 17 §22 lists the check-in itself under customer success
    // COMMUNICATION, which is ADM-61 §3 `client_facing` and stays with a
    // person. This drafts what they will raise and sends nothing.
    assert.match(checkIn, /agentKey: 'customer_success'/);
    assert.match(checkIn, /workClass: 'internal_plan'/);
  });

  test("all seven of Doc 17 §18's responsibilities, and no eighth", () => {
    const at = crm.indexOf('export const CHECK_IN_KINDS');
    const body = crm.slice(at, crm.indexOf('] as const', at));
    const found = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual(found, [
      'confirm_access', 'confirm_use', 'unresolved_issue', 'training_need',
      'feedback_to_collect', 'renewal_timing', 'possible_new_work',
    ]);
  });

  test('and nothing a brief could promise with', () => {
    // §18's last line: "Never promise free work outside contract/policy."
    // ADM-22 is the same prohibition from the other side — every price is a
    // human's — and §24's health weights are the Admin's, so there is no
    // score either. `possible_new_work` NAMES an opportunity; naming is all.
    const at = crm.indexOf('export const checkInBriefSchema');
    assert.ok(at > 0, 'the brief schema was not found — the parser drifted');
    const body = crm.slice(at, crm.indexOf('export type CheckInBrief', at));
    for (const forbidden of [
      'price', 'amount', 'cost', 'discount', 'free', 'included',
      'score', 'health', 'promise', 'commit', 'deadline', 'due', 'send', 'recipient',
    ]) {
      assert.doesNotMatch(body, new RegExp(forbidden, 'i'), `the brief can name ${forbidden}`);
    }
    assert.match(body, /\.strict\(\)/);
  });

  test('reviewing the support history means reading it, not recalling it', () => {
    // Doc 17 §18: "Review support history." The rows go over with their ids
    // and come back on the points, so a citation is checkable.
    assert.match(checkIn, /\.from\('maintenance_items'\)/);
    assert.match(checkIn, /const known = new Set\(history\.map/);
    assert.match(checkIn, /are not in this project's history/);
  });

  test('a handover that is not accepted has no Day 0 to prepare for', () => {
    assert.match(checkIn, /handover\.status !== 'accepted'/);
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
