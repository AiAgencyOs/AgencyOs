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

/**
 * A schema body with its own prose removed.
 *
 * Every "this field must not exist" test below scans a slice of source, and a
 * schema that EXPLAINS why a field is absent contains the word it forbids. The
 * doc-comment on `language` says "no confidence, because nothing would read
 * one" — and that sentence failed the check it was written to describe. Same
 * trap the migration prose stripper exists for, one file over.
 */
const withoutProse = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');

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
    // The property, not the shape it had. This asserted the loop
    // `for (const kind of AGENT_JOB_KINDS)`, which was how the runner read
    // every agent kind — and also how it starved every kind after the first
    // busy one. What it was really about is that the runner reads all of
    // them rather than one constant, and that is what is asserted now.
    assert.match(route, /p_kinds: \[\.\.\.AGENT_JOB_KINDS\]/);
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

  test('and the same reading returns the language — Doc 08 §8', () => {
    // §12's own flow is PARSE CONTENT → LANGUAGE → INTENT, so the language is
    // asked for in the SAME call. A second model call per message to answer a
    // question the first one was already looking at pays twice for one
    // reading.
    //
    // A tag, or two joined for a mixed message — §8's "Support mixed-language
    // messages such as Hinglish" is `hi-en`, which says WHICH two. No
    // enumeration: which languages this agency works in is configuration
    // nobody has given, so the pattern constrains shape and not membership.
    assert.match(crm, /language: z\n?\s*\.string\(\)/);
    assert.match(crm, /\^\[a-z\]\{2,3\}\(-\[a-z\]\{2,3\}\)\?\$/);
    assert.match(intent, /language: validated\.data\.language/);
  });

  test('and no confidence, because nothing would read one', () => {
    // §8 says "Store detected language/confidence where useful". Nothing here
    // branches on uncertainty, and G-130 and G-133 are both the record of what
    // a column with no consumer does — it reads as checked.
    const at = crm.indexOf('export const messageIntentSchema');
    const body = withoutProse(crm.slice(at, crm.indexOf('export type MessageIntent', at)));
    for (const forbidden of ['confidence', 'certainty', 'probability', 'translat']) {
      assert.doesNotMatch(body, new RegExp(forbidden, 'i'), `the reading can name ${forbidden}`);
    }
  });

  test('and saying one is safe because the schema cannot say anything else', () => {
    // Business rules §5: never "treat a client's word as a fact". The label is
    // safe to write precisely because no field beside it can move a status,
    // accept a proposal, or draft the reply that would.
    const at = crm.indexOf('export const messageIntentSchema');
    assert.ok(at > 0, 'the intent schema was not found — the parser drifted');
    const body = withoutProse(crm.slice(at, crm.indexOf('export type MessageIntent', at)));
    for (const forbidden of ['status', 'accept', 'approve', 'reply', 'confidence', 'score', 'action']) {
      assert.doesNotMatch(body, new RegExp(forbidden, 'i'), `the reading can name ${forbidden}`);
    }
    assert.match(body, /\.strict\(\)/);
  });

  test('the run writes the two labels and their author, and no fourth column', () => {
    // If this ever writes a status too, the paragraph above stops being true
    // and no database guard would notice — nothing forbids sales updating a
    // lead. The absence is the control, so the absence is what is tested.
    // Anchored past the job settles, which also call `.update(` — the first
    // match in this workflow is `jobs.update(settledSucceeded)`, not this one.
    const at = intent.indexOf(".from('conversation_messages')\n      .update(");
    assert.ok(at > 0, 'the message write was not found — the workflow drifted');
    const written = intent.slice(at, intent.indexOf('})', at));
    const columns = [...written.matchAll(/(\w+):/g)].map((m) => m[1]).sort();
    // Three now: Doc 08 §8's language came back from the same call, and §12's
    // flow puts LANGUAGE before INTENT. Still nothing that moves a status.
    assert.deepStrictEqual(columns, ['intent', 'intent_by_agent', 'language']);
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

describe('C7. the package says what it owes, and never holds it', () => {
  const projects = read('src/modules/projects/schema.ts');
  const pack = workflowSlice('HANDOVER_PACKAGE');

  test('listing what a package owes is draft work; delivering it is not', () => {
    // Doc 17 is fifteen pages about one act, and that act is §3's
    // `delivery_approval` — the one an agent may never perform alone.
    assert.match(pack, /agentKey: 'handover'/);
    assert.match(pack, /workClass: 'draft'/);
  });

  test("the seven kinds handover_items has always had, and no eighth", () => {
    // Shared with the package on purpose, so an obligation and the evidence
    // that meets it are the same kind of thing rather than two lists kept in
    // step by hand.
    const at = projects.indexOf('export const HANDOVER_KINDS');
    const body = projects.slice(at, projects.indexOf('] as const', at));
    const found = [...body.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual(found, [
      'artifact', 'repository', 'deployment', 'documentation',
      'credential', 'invoice', 'warranty',
    ]);
  });

  test('and no field the artifact itself could go in', () => {
    // §9's "Repository/access transfer through secure mechanisms" is the
    // sharpest case: ADM-61 §5 makes writing a client credential one of the
    // five absolutes. An agent that can only ever say "this package owes a
    // credential" is not near that line.
    const at = projects.indexOf('export const handoverPackageSchema');
    assert.ok(at > 0, 'the package schema was not found — the parser drifted');
    const body = projects.slice(at, projects.indexOf('export type HandoverPackage', at));
    for (const forbidden of [
      'reference', 'url', 'link', 'credential', 'password', 'secret', 'token',
      'key', 'transfer', 'status', 'deliver', 'approve', 'date',
    ]) {
      assert.doesNotMatch(body, new RegExp(forbidden, 'i'), `the package can name ${forbidden}`);
    }
    assert.match(body, /\.strict\(\)/);
  });

  test('what was agreed and what was produced both go over', () => {
    // §9's first two entries are the approved scope and the UI baseline. A
    // package listed from the project's name alone would be a guess.
    assert.match(pack, /\.from\('scope_items'\)/);
    assert.match(pack, /\.from\('deliverables'\)/);
  });

  test('a package already delivered is not given a checklist', () => {
    assert.match(pack, /handover\.status !== 'preparing'/);
  });
});

describe('C8. the qualifier reads what is there, and counts nothing', () => {
  const crm = read('src/modules/crm/schema.ts');
  const qualify = workflowSlice('QUALIFICATION_READ');

  test('noticing what a conversation already says is read work', () => {
    // Doc 09 §9: "The Sales Agent should not interrogate the lead with a rigid
    // checklist when the conversation already provides the answer." Nothing is
    // drafted, nothing is planned and nothing reaches the client.
    assert.match(qualify, /workClass: 'read'/);
  });

  test('and it is the SALES agent, not the one whose name fits', () => {
    // `lead_qualifier` has a row in `ai.agents`, no definition in the
    // registry, and G-125's closure condition 11: it "is not accidentally
    // enabled as an unimplemented independent runtime agent". Doc 09 §9 and
    // §11 both name the Sales Agent for this anyway.
    assert.match(qualify, /agentKey: 'sales'/);
    assert.doesNotMatch(workflowCode, /agentKey: 'lead_qualifier'/);
    assert.doesNotMatch(workflowCode, /agentKey: 'proposal_drafter'/);
  });

  test("all fifteen of Doc 09 §9's areas, and no sixteenth", () => {
    const at = crm.indexOf('export const QUALIFICATION_AREAS');
    const body = crm.slice(at, crm.indexOf('] as const', at));
    const found = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual(found, [
      'what_to_build', 'service_type', 'target_users', 'platforms',
      'core_features', 'integrations', 'design_expectations', 'timeline',
      'budget', 'urgency', 'decision_maker', 'existing_assets',
      'special_requirements', 'language', 'trust_concerns', 'payment_expectations',
    ]);
  });

  test('and neither number Document 09 asks for', () => {
    // §10's score: ADM-88 answered it, and `crm.leads.score` is a permanently
    // null column carrying that answer as its comment.
    //
    // §9's budget: recorded as the sentence it was said in. Parsing "maybe
    // around two lakh, depends" into 200000 is treating a client's word as a
    // fact — one of business rules §5's five absolutes.
    const at = crm.indexOf('export const qualificationCoverageSchema');
    assert.ok(at > 0, 'the coverage schema was not found — the parser drifted');
    const body = crm.slice(at, crm.indexOf('export type QualificationCoverage', at));
    for (const forbidden of [
      'score', 'weight', 'rank', 'band', 'amount', 'minor', 'budgetminor',
      'confidence', 'status', 'recommend', 'pursue', 'qualified',
    ]) {
      assert.doesNotMatch(body, new RegExp(forbidden, 'i'), `the reading can name ${forbidden}`);
    }
    assert.match(body, /\.strict\(\)/);
  });

  test('a fully qualified lead is not re-read for ever', () => {
    // Every inbound message queues this, so a workflow that does not converge
    // is a model call per message for the life of the lead.
    assert.match(qualify, /if \(open\.length === 0\)/);
    assert.match(qualify, /fully qualified/);
  });

  test('an area already answered is dropped, and the rest are still written', () => {
    // This used to FAIL the run when the model named a covered area. A model
    // handed the whole transcript reads the whole transcript, so it restates
    // as a matter of course: on the owner's first real conversation three runs
    // failed this way and one job burned four attempts. What that cost was the
    // areas it did find. The duplicate row is refused by the unique index
    // anyway — thoroughness is not an error.
    assert.match(qualify, /const openSet = new Set\(open\)/);
    assert.match(qualify, /const fresh = validated\.data\.covered\.filter\(\(c\) => openSet\.has\(c\.area\)\)/);
    assert.doesNotMatch(qualify, /restates \$\{/);
  });

  test('and an empty reading is a real answer', () => {
    // `.min(1)` on the array would make "this message answered nothing new"
    // a schema failure, which is the commonest honest outcome.
    const at = crm.indexOf('export const qualificationCoverageSchema');
    const body = crm.slice(at, crm.indexOf('export type QualificationCoverage', at));
    assert.doesNotMatch(body, /\.min\(1[^)]*\)\s*,?\s*\}\)/);
    assert.match(body, /\.max\(QUALIFICATION_AREAS\.length\)/);
  });
});

describe("C9. an objection is recorded, and the agency's answer is not the agent's", () => {
  const sales = read('src/modules/sales/schema.ts');
  const objection = workflowSlice('OBJECTION_READ');

  test('naming an objection is read work', () => {
    assert.match(objection, /agentKey: 'sales'/);
    assert.match(objection, /workClass: 'read'/);
  });

  test("all four of Doc 09 §19's kinds, and no fifth", () => {
    const at = sales.indexOf('export const OBJECTION_KINDS');
    const body = sales.slice(at, sales.indexOf('] as const', at));
    const found = [...body.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual(found, ['price', 'trust', 'timeline', 'feature']);
  });

  test('and no field the agency\'s answer could go in', () => {
    // §19 asks the CRM to store five things and this schema can express two.
    // §13 defines a response as offering an approved structure, requesting an
    // Admin exception, or presenting evidence — each a commitment to a client,
    // so ADM-61 §3 `client_facing`, and the payment structures §3 `money`.
    //
    // §21's nine limits are Admin-configurable and unconfigured, so no
    // discount, no amount, no floor, no cap.
    const at = sales.indexOf('export const objectionReadingSchema');
    assert.ok(at > 0, 'the objection schema was not found — the parser drifted');
    const body = sales.slice(at, sales.indexOf('export type ObjectionReading', at));
    for (const forbidden of [
      'response', 'answer', 'reply', 'offer', 'discount', 'amount', 'price',
      'minor', 'outcome', 'next', 'deadline', 'limit', 'approve',
    ]) {
      assert.doesNotMatch(body, new RegExp(forbidden, 'i'), `the reading can name ${forbidden}`);
    }
    assert.match(body, /\.strict\(\)/);
  });

  test('the workflow writes neither an answer nor a number', () => {
    // The row rule refuses an agent-authored answer regardless. This is why it
    // never has to: there is nothing here to refuse.
    const at = objection.indexOf(".from('objections')\n      .insert(");
    assert.ok(at > 0, 'the objection write was not found — the workflow drifted');
    const written = objection.slice(at, objection.indexOf('})', at));
    const columns = [...written.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
    // `round` is written from a variable rather than a literal key, so the
    // ^\s*(\w+): scan does not see it. Asserted separately rather than by
    // loosening the scan, which is what makes the list exhaustive.
    assert.deepStrictEqual(columns, [
      'concern', 'kind', 'lead_id', 'message_id', 'organization_id',
      'proposal_id', 'raised_by_agent',
    ]);
    assert.match(written, /\bround,/);
  });

  test('the round is read, not counted from a cached number', () => {
    // Two objections in one tick would both read a stale count. The unique
    // index on (lead_id, round) turns that race into a refusal rather than
    // two rows both called round 3 — and the workflow says so.
    // Asserted on the code, not on the comment that explains it —
    // `workflowSlice` strips comments, so a claim about prose here can only
    // ever fail. The property is that the round comes from a SELECT of the
    // highest existing round, not from a counter.
    assert.match(objection, /\.order\('round', \{ ascending: false \}\)/);
    assert.match(objection, /const round = \(\(sofar \?\? \[\]\)\[0\]\?\.round \?\? 0\) \+ 1/);
  });
});

describe('C10. the one client-facing thing any agent does', () => {
  const crm = read('src/modules/crm/schema.ts');
  const compose = workflowSlice('FOLLOW_UP_DRAFT');
  const worker = read('src/modules/crm/follow-up-worker.ts');

  test('and there are exactly two, each with a decision behind it', () => {
    // ADM-61 §4 recorded the ADM-11 follow-ups as "the only path in AgencyOS
    // where something reaches a client unread". **ADM-91 (2026-08-22) widened
    // that** to a reply inside a conversation the client started — the owner's
    // words, "ai agent khud kare".
    //
    // So the count is two, not one, and this test is the reason a third would
    // be noticed: another `client_facing` workflow is a decision somebody has
    // to make, not a workflow somebody adds.
    const declared = [...workflowCode.matchAll(/workClass: '(\w+)'/g)].map((m) => m[1]);
    assert.equal(
      declared.filter((c) => c === 'client_facing').length,
      2,
      'the number of client_facing workflows changed — which ADM permits the new one?',
    );
    assert.match(compose, /workClass: 'client_facing'/);
    assert.match(workflowSlice('CLIENT_REPLY'), /workClass: 'client_facing'/);
    for (const forbidden of ['money', 'delivery_approval']) {
      assert.equal(declared.includes(forbidden), false, `a workflow declares ${forbidden} work`);
    }
  });

  test('a follow-up an agent writes carries no number', () => {
    // A price is a number, a promised date is a number, a discount is a
    // number. ADM-22 forbids the first and ADM-61 §5 the second — and the
    // database refuses a digit outright, because at a surface that sends
    // unread text to a client a rule a constraint can check beats a rule a
    // prompt asks for.
    const at = crm.indexOf('export const followUpDraftSchema');
    assert.ok(at > 0, 'the draft schema was not found — the parser drifted');
    const body = withoutProse(crm.slice(at, crm.indexOf('export type FollowUpDraft', at)));
    assert.match(body, /\.regex\(\/\^\[\^0-9\]\*\$\//);
    assert.match(body, /\.max\(300/);
    // Scanned as FIELD NAMES, not as substrings of the whole body: this
    // schema's own error message says "No numbers: not a price, not a date,
    // not a discount", so a substring scan fails on the sentence that
    // describes the rule. Same trap as the doc-comment above, one layer in —
    // prose stripping does not remove a string literal, and should not.
    const fields = [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    assert.deepStrictEqual(fields, ['body']);
    assert.match(body, /\.strict\(\)/);
  });

  test('and a contact whose language nobody knows gets no draft at all', () => {
    // Guessing is how a Hindi-speaking client gets a nudge in a language they
    // did not choose. The placeholder goes instead, which is what every
    // follow-up so far has said.
    assert.match(compose, /if \(!language\)/);
    assert.match(compose, /no language is recorded/);
  });

  test('the switch is what decides, and the fallback is unconditional', () => {
    // ADM-11 permits this; permitting is not switching it on for an agency
    // that has not asked. Anything unusual — no draft, no setting, an
    // unreadable organization — sends the placeholder.
    assert.match(worker, /agent_writes_follow_ups/);
    assert.match(worker, /if \(error \|\| !org\?\.agent_writes_follow_ups\) return FOLLOW_UP_BODY;/);
    assert.match(worker, /return row\?\.drafted_body\?\.trim\(\) \|\| FOLLOW_UP_BODY;/);
  });

  test('and the send never waits on a model call', () => {
    // Asked when the sequence is SCHEDULED, not when it is due, so the
    // composer has the whole gap to answer. A follow-up that did not go out
    // because a model call was slow would be a regression on every follow-up
    // sent so far.
    assert.match(worker, /p_type: 'followup\.due'/);
    const scheduling = worker.slice(worker.indexOf("p_type: 'followup.due'"));
    assert.match(scheduling.slice(0, 600), /console\.error/);
  });
});

describe('C11. what the client told us once — Doc 05 §5, §19', () => {
  const crm = read('src/modules/crm/schema.ts');
  const intent = workflowSlice('MESSAGE_INTENT');
  const compose = workflowSlice('FOLLOW_UP_DRAFT');

  test('the memory layer finally has a producer and a reader', () => {
    // `ai.memory_records`, its constraints and `ai.recall` have existed since
    // 2026-08-21 with nothing in the application writing or reading one —
    // the tables-with-no-code state G-011 exists to prevent. Both halves land
    // together, because either alone is that state wearing a different face.
    assert.match(intent, /\.from\('memory_records'\)/);
    assert.match(compose, /rpc\('recall'/);
  });

  test('and the strongest thing it can record is "they said this, here"', () => {
    // §17: "Prefer explicit client statements over inferred preferences" and
    // "Never allow an AI hallucination to silently become a permanent client
    // fact." The row's own constraints are what make that true — an explicit
    // memory must name its source, and an agent may never write `verified` —
    // so the workflow writes the only combination it is allowed.
    assert.match(intent, /confidence: 'explicit'/);
    assert.match(intent, /source_kind: 'crm\.conversation_message'/);
    assert.match(intent, /source_id: message\.id/);
    assert.doesNotMatch(intent, /confidence: 'verified'/);
  });

  test('a durable fact is quoted, not characterised', () => {
    const at = crm.indexOf('    clientFact: z');
    assert.ok(at > 0, 'the clientFact field was not found — the parser drifted');
    const body = withoutProse(crm.slice(at, crm.indexOf('  })\n  .strict();', at)));
    const fields = [...body.matchAll(/^\s{8}(\w+):/gm)].map((m) => m[1]).sort();
    assert.deepStrictEqual(fields, ['fact', 'kind']);
    // Nullable, because most messages state no durable fact and a schema that
    // demands one on every message is a schema that gets one invented.
    assert.match(body, /\.nullable\(\)/);
  });

  test('a memory that fails to save does not lose the reading that succeeded', () => {
    // The label is written first and the memory after, best-effort. A thread
    // whose message was read is a thread that was read, whatever happened to
    // the note about it.
    const memoryAt = intent.indexOf(".from('memory_records')");
    const labelAt = intent.indexOf(".from('conversation_messages')\n      .update(");
    assert.ok(labelAt > 0 && memoryAt > labelAt, 'the memory is written before the label');
    assert.match(intent, /messageIntent\.memory/);
  });

  test('and the composer is told only a little of it', () => {
    // Doc 05 §20: "Never send the entire project history by default."
    assert.match(compose, /p_limit: 8/);
    assert.match(compose, /p_scope: 'lead'/);
  });
});

describe('C12. the queue is ordered by age, not by list position', () => {
  const claim = read('supabase/migrations/20260822280000_a_queue_is_ordered_by_age_not_by_list_position.sql');

  test('the runner asks the queue one question, not eleven', () => {
    // It looped over AGENT_JOB_KINDS and took the first with a queued row.
    // That was harmless with one kind and starving with eleven: while any
    // `message.intent` was queued — one per inbound client message — nothing
    // listed below it was ever claimed.
    assert.match(route, /rpc\('claim_agent_job'/);
    assert.doesNotMatch(route, /for \(const kind of AGENT_JOB_KINDS\)/);
    assert.match(route, /p_kinds: \[\.\.\.AGENT_JOB_KINDS\]/);
  });

  test('and the ordering is age, with no reference to the caller\'s list', () => {
    // `array_position(p_kinds, kind)` would reintroduce exactly the defect
    // under a different name.
    assert.match(claim, /order by priority, run_at, id/);
    assert.doesNotMatch(claim, /array_position/);
  });

  test('one job per invocation is unchanged', () => {
    // Claiming more would leave rows `running` that nothing in this tick will
    // settle — the property the loop version also had, and the only one worth
    // keeping from it.
    assert.match(claim, /limit 1\n\s*for update skip locked/);
  });

  test('and claim_jobs is left alone', () => {
    // It is correct for what it does, G-119's batch-size lesson lives in it,
    // and it has other callers. A second entry point beside it rather than a
    // rewrite of it, because re-emitting a function is how a branch gets
    // silently dropped (D16).
    assert.doesNotMatch(claim, /create or replace function core\.claim_jobs/);
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
