import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { HANDLER_JOB_KIND, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { LOCKED_PAYMENT_STRUCTURE } from '../src/modules/projects/payment-structure.ts';
import {
  assembleBlueprint, blueprintDraftJsonSchema, blueprintDraftSchema, financeGatePhase, findDevelopmentContent,
  renderPlanningContext, type BlueprintDraft,
} from '../src/modules/projects/blueprint.ts';

const read = (p: string) => readFileSync(p, 'utf8');

// Phase 2 Planning §2-§9, §18: the Project Planning Agent drafts the
// operational blueprint; every rule that is not a prompt is checked here, and
// the end-to-end behaviour against the running app is in
// scripts/verify-planning-agent.mjs.

const items = [
  { id: 'item-1', title: 'Customer app: order medicines' },
  { id: 'item-2', title: 'Admin panel: stock and orders' },
];
const payments = [
  { id: 'pm-0', name: 'M1 advance', position: 1 }, { id: 'pm-1', name: 'M2', position: 2 },
  { id: 'pm-2', name: 'M3', position: 3 }, { id: 'pm-3', name: 'M4', position: 4 },
];
const draft = (over: Partial<BlueprintDraft> = {}): BlueprintDraft => ({
  objective: 'Launch a pharmacy ordering app for three stores.',
  deliverables: [
    { scopeItem: 1, name: 'Customer ordering app', applicablePhase: 'phase_5', ownerRole: 'developer', readinessCriteria: 'Customers can place and track an order.', evidenceRequired: 'Demo recording approved by the client.', ambiguityNote: null },
    { scopeItem: 2, name: 'Admin stock and order panel', applicablePhase: 'phase_5', ownerRole: 'developer', readinessCriteria: 'Staff can see orders and update stock.', evidenceRequired: 'Demo recording.', ambiguityNote: null },
  ],
  dependencies: [
    { kind: 'client_asset', description: 'Logo and brand colours', neededByPhase: 'phase_3', ownerRole: 'designer' },
    { kind: 'external_service', description: 'Payment gateway merchant account', neededByPhase: 'phase_5', ownerRole: 'developer' },
  ],
  milestones: [{ name: 'Design approved', kind: 'client_approval', phase: 'phase_4', gateCriteria: 'The client approves the design in writing.' }],
  notes: [{ kind: 'risk', statement: 'Store staff may be slow to provide stock data.', ownerRole: 'project_manager' }],
  clarifications: [],
  ...over,
});
const assemble = (d: BlueprintDraft) => assembleBlueprint(d, { includedItems: items, paymentMilestones: payments });

describe('the shape the model must answer in', () => {
  test('a valid draft parses, and the decoder is shown the whole shape', () => {
    assert.ok(blueprintDraftSchema.safeParse(draft()).success);
    const json = JSON.stringify(blueprintDraftJsonSchema());
    for (const key of ['deliverables', 'dependencies', 'milestones', 'notes', 'clarifications', 'readinessCriteria', 'evidenceRequired']) assert.match(json, new RegExp(key));
  });

  test('there is nowhere to put a price, a date, a task or a table', () => {
    const json = JSON.stringify(blueprintDraftJsonSchema());
    for (const forbidden of ['price', 'amount', 'date', 'deadline', 'task', 'table', 'endpoint', 'schema"', 'code']) {
      assert.doesNotMatch(json, new RegExp(`"${forbidden}`, 'i'), forbidden);
    }
    assert.ok(!blueprintDraftSchema.safeParse({ ...draft(), price: 1 }).success, 'unknown keys are refused');
  });

  test('a finance dependency is not the agent\'s to propose', () => {
    const d = draft();
    (d.dependencies[0] as { kind: string }).kind = 'finance';
    assert.ok(!blueprintDraftSchema.safeParse(d).success);
  });
});

describe('assembling what the door writes', () => {
  test('the happy path: scope items by number become real ids, and the finance gates come from the payment plan', () => {
    const r = assemble(draft());
    assert.ok(r.ok);
    if (!r.ok) return;
    const b = r.blueprint as { deliverables: Array<{ scopeItemId: string }>; milestones: Array<{ kind: string; phase: string; paymentMilestoneId?: string }> };
    assert.deepEqual(b.deliverables.map((d) => d.scopeItemId), ['item-1', 'item-2']);
    const gates = b.milestones.filter((m) => m.kind === 'finance_gate');
    assert.deepEqual(gates.map((g) => g.paymentMilestoneId), ['pm-0', 'pm-1', 'pm-2', 'pm-3']);
    assert.deepEqual(gates.map((g) => g.phase), ['phase_2', 'phase_4', 'phase_5', 'phase_6']);
    assert.equal(r.summary.financeGates, 4);
  });

  test('a phase that has work but no milestone gets one, so the plan validates', () => {
    const r = assemble(draft());
    assert.ok(r.ok);
    if (!r.ok) return;
    const phases = (r.blueprint as { milestones: Array<{ phase: string; kind: string }> }).milestones.filter((m) => m.kind !== 'finance_gate').map((m) => m.phase);
    assert.ok(phases.includes('phase_5'), 'phase_5 carries both deliverables and must be sequenced');
    assert.equal(r.summary.addedPhaseMilestones, 1);
  });

  test('what the client owes is the project manager\'s to collect, whatever the model wrote', () => {
    const r = assemble(draft({ dependencies: [{ kind: 'client_access', description: 'Play Store account access', neededByPhase: 'phase_6', ownerRole: 'developer' }] }));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal((r.blueprint as { dependencies: Array<{ ownerRole: string }> }).dependencies[0]!.ownerRole, 'project_manager');
  });

  test('every included scope item must be covered, and the model is told which one it missed', () => {
    const r = assemble(draft({ deliverables: [draft().deliverables[0]!] }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.problems.join(' '), /2 \(Admin panel: stock and orders\)/);
  });

  test('a scope item number outside the list cannot become a deliverable for something nobody agreed to', () => {
    const d = draft();
    d.deliverables.push({ ...d.deliverables[0]!, scopeItem: 9, name: 'Loyalty programme' });
    const r = assemble(d);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.problems.join(' '), /scopeItem 9 is not in the list/);
  });

  test('development-level content is refused, wherever it hides', () => {
    for (const text of [
      'Design the database schema for orders', 'Create a table for medicines', 'Define the API endpoint contract', 'Implement the checkout function',
      'Unit tests for the cart', 'Use React and Postgres', 'Draw the ER diagram', '```sql select 1```',
    ]) {
      const r = assemble(draft({ objective: text }));
      assert.equal(r.ok, false, text);
    }
    const r = assemble(draft({ notes: [{ kind: 'risk', statement: 'We will write the SQL migration first.', ownerRole: null }] }));
    assert.equal(r.ok, false);
  });

  test('but what a client genuinely owes is not mistaken for engineering', () => {
    for (const text of [
      'The client provides their payment gateway API keys', 'Logo, brand colours and the store address', 'Access to the Play Store developer account',
      'Written approval of the design direction', 'Stock list in a spreadsheet',
    ]) assert.equal(findDevelopmentContent(text), null, text);
  });

  test('the payment gate phase follows the locked 30/20/30/20 structure', () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(financeGatePhase), ['phase_2', 'phase_4', 'phase_5', 'phase_6', 'phase_7']);
  });

  test('the model is shown the scope by number, what is excluded, and what onboarding already holds', () => {
    const text = renderPlanningContext({
      projectName: 'Pharmacy app', projectType: 'mobile', scopeVersion: 2,
      includedItems: [{ title: 'Customer app', detail: 'order and track', acceptanceCriteria: 'order placed' }],
      excludedTitles: ['Marketing'], onboarding: [{ label: 'Logo', status: 'received' }], paymentMilestones: payments,
    });
    assert.match(text, /1\. Customer app — order and track \[accepted when: order placed\]/);
    assert.match(text, /EXPLICITLY EXCLUDED.*Marketing/);
    assert.match(text, /- Logo: received/);
    assert.doesNotMatch(text, /%|₹|\d{4,}/, 'no percentage or amount reaches the planner');
  });
});

describe('the advance is the FIRST priced milestone, by order - never a position number', () => {
  // Found by driving the whole flow: the installer numbers a plan from 0, and
  // the first drafts of the planner, the PM's payment messages AND the M1-M4
  // invoice generators each assumed a different base - so the "M1" invoice was
  // raised for the SECOND milestone (20%). M1 means "first", whatever the
  // writer numbered it.
  test('the locked structure has four milestones in the order M1..M4, and each gate lands in the phase that completes it', () => {
    assert.deepEqual(LOCKED_PAYMENT_STRUCTURE.map((m) => m.key), ['M1', 'M2', 'M3', 'M4']);
    assert.deepEqual([1, 2, 3, 4].map(financeGatePhase), ['phase_2', 'phase_4', 'phase_5', 'phase_6']);
  });

  test('gates are mapped by the milestone\'s place in the plan, whatever position numbers it carries', () => {
    for (const base of [0, 1, 7]) {
      const plan = payments.map((p, i) => ({ ...p, position: base + i }));
      const r = assembleBlueprint(draft(), { includedItems: items, paymentMilestones: [...plan].reverse() });
      assert.ok(r.ok);
      if (!r.ok) continue;
      const gates = (r.blueprint as { milestones: Array<{ kind: string; phase: string; paymentMilestoneId?: string }> }).milestones.filter((m) => m.kind === 'finance_gate');
      assert.deepEqual(gates.map((g) => g.phase), ['phase_2', 'phase_4', 'phase_5', 'phase_6'], `base ${base}`);
      assert.deepEqual(gates.map((g) => g.paymentMilestoneId), ['pm-0', 'pm-1', 'pm-2', 'pm-3'], `base ${base}`);
    }
  });

  test('both consumers ask "is this the first priced milestone" and never compare a position number', () => {
    const comms = read('src/modules/projects/pm-client-comms.ts');
    assert.match(comms, /isAdvanceMilestone\(admin,/);
    const wf = read('app/api/jobs/run/workflows.ts');
    const at = wf.indexOf('const PLANNING_BLUEPRINT');
    assert.match(wf.slice(at, at + 4000), /isAdvanceMilestone\(admin,/);
    assert.doesNotMatch(wf.slice(at, wf.indexOf('export const AGENT_WORKFLOWS')), /position !== [0-9]/);
  });

  test('the M1-M4 generators pick by ordinal, not by a stored position', () => {
    const svc = read('src/modules/finance/service.ts');
    assert.doesNotMatch(svc, /\.eq\('position', /);
    assert.equal((svc.match(/nthPricedMilestone\(admin, scope, /g) ?? []).length, 3);
  });

  test('the two Phase 5 gates wait on the milestone the Phase 4 invoice bills (the second priced one)', () => {
    const sql = read('supabase/migrations/20261011350000_m2_is_the_second_priced_milestone_not_position_two.sql');
    assert.equal((sql.match(/order by m2\.position, m2\.created_at offset 1 limit 1/g) ?? []).length, 2);
    assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /m\.position = 2/);
  });
});

describe('what is wired, and what it must not do', () => {
  const sql = read('supabase/migrations/20261011300000_the_project_planning_agent_drafts_the_blueprint.sql');
  const workflows = read('app/api/jobs/run/workflows.ts');
  const wf = workflows.slice(workflows.indexOf('const PLANNING_BLUEPRINT: AgentWorkflow'), workflows.indexOf('export const AGENT_WORKFLOWS'));
  const code = wf.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('the advance verified, or a request, starts it; the handler is claimed under its own job kind', () => {
    assert.ok(SUBSCRIPTIONS['invoice.paid']?.includes('project_planning:draftBlueprint'));
    assert.deepEqual(SUBSCRIPTIONS['project.planning_requested'], ['project_planning:draftBlueprint']);
    assert.equal(HANDLER_JOB_KIND['project_planning:draftBlueprint'], 'planning.blueprint');
    assert.match(workflows, /jobKind: 'planning\.blueprint',\s*\n\s*agentKey: 'project_planning',/);
  });

  test('only the advance opens planning, and an existing plan is never replaced', () => {
    assert.match(code, /if \(!advance\) return settle\('a later milestone, not the advance'\)/);
    assert.match(code, /the project already has a plan/);
  });

  test('it drafts and stops: no activation, no approval, no client message, no tools', () => {
    assert.doesNotMatch(code, /activate_project_plan|approve_project_plan|send_outbound_message|sendClientMessage|callModelWithTools/);
    assert.match(code, /agent_draft_blueprint/);
  });

  test('the door is the service role\'s alone, atomic, and refuses any existing plan', () => {
    assert.match(sql, /revoke all on function projects\.agent_draft_blueprint\(uuid, jsonb\) from public, anon, authenticated;/);
    assert.match(sql, /grant execute on function projects\.agent_draft_blueprint\(uuid, jsonb\) to service_role;/);
    assert.match(sql, /if exists \(select 1 from projects\.project_plans pp where pp\.project_id = v_project\.id\) then\s+return query select 'plan_exists'/);
    assert.match(sql, /outside the approved scope/);
  });

  test('the dependency vocabulary gained exactly the three kinds the specification lists, and the client ones stay the PM\'s', () => {
    assert.match(sql, /'client_asset', 'client_approval',\s*\n\s*'external_service', 'internal_output', 'human_approval', 'finance', 'other'/);
    assert.match(sql, /kind not in \('client_information', 'client_access', 'client_asset', 'client_approval'\)\s*\n\s*or owner_role = 'project_manager'/);
  });
});

// ── Planning §10: the planner's question reaches the client through the PM ──
import { isSafeClientQuestion, pmClarificationAsk } from '../src/modules/projects/pm-messages.ts';

describe('what may be put to a client as a planning question', () => {
  test('a single plain question is fine, in any of the client\'s languages', () => {
    for (const q of ['Which stores should the first release cover?', 'Kya aapke paas pehle se delivery partner hai?', 'क्या आपके पास पहले से ऑर्डर देखने वाला कोई व्यक्ति है?']) {
      assert.ok(isSafeClientQuestion(q), q);
    }
  });

  test('a model\'s words that carry money, a promise, a date or a link are held for a person', () => {
    for (const q of [
      'Can you pay 50,000 rupees more?', 'Would a ₹5000 add-on suit you?', 'We can give a 20% discount if you confirm?', 'We guarantee delivery - is that fine?',
      'Can you reply by Monday?', 'See https://example.com - which store?', 'Which? And which? And which?', 'ok?', 'x'.repeat(401),
    ]) assert.equal(isSafeClientQuestion(q), false, q);
  });

  test('the wrapper says it is for planning and keeps the question verbatim', () => {
    assert.match(pmClarificationAsk('en', 'Which stores?'), /so we plan your project properly: Which stores\?$/);
    assert.match(pmClarificationAsk('hinglish', 'Kaun se stores?'), /plan karne ke liye ek chhota sa sawaal: Kaun se stores\?$/);
  });
});

describe('the answer is the client\'s own message, kept for a person to settle', () => {
  const sql = read('supabase/migrations/20261011310000_the_pm_asks_the_planners_question_and_keeps_the_answer.sql');
  const handler = read('src/modules/projects/pm-clarifications.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('both doors are the runner\'s alone, and each demands its evidence', () => {
    assert.match(sql, /revoke all on function projects\.agent_mark_clarification_asked\(uuid, uuid\) from public, anon, authenticated;/);
    assert.match(sql, /revoke all on function projects\.agent_record_clarification_answer\(uuid, uuid\) from public, anon, authenticated;/);
    assert.match(sql, /return 'not_our_message'/);
    assert.match(sql, /return 'not_the_clients_message'/);
    assert.match(sql, /return 'sent_before_the_question'/);
    assert.match(sql, /return 'not_this_projects_thread'/);
  });

  test('the answer text is READ from the message in the database, never passed in', () => {
    assert.match(sql, /v_body := left\(btrim\(coalesce\(v_msg\.body, ''\)\), 2000\)/);
    assert.doesNotMatch(sql, /p_answer/);
  });

  test('the system asks and listens - it never resolves, routes or edits the plan', () => {
    assert.doesNotMatch(handler, /resolve_clarification|route_clarification_to_change_request|activate_project_plan|add_plan_/);
  });

  test('one question at a time, and the next waits for a person', () => {
    assert.match(handler, /waiting_on_the_client/);
    assert.deepEqual(SUBSCRIPTIONS['project.clarification_resolved'], ['projects:askClarification']);
    assert.ok(SUBSCRIPTIONS['message.received']?.includes('projects:readClarificationAnswer'));
  });
});
