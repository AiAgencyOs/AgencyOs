import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The Phase 8 part B workflows against a STAND-IN model and a STAND-IN database. Nothing here ran on a real model. Proved: the ORDER (read for the
 * job's organization, ask, validate, write), the REFUSALS and WHERE they write: one service-only door each, never a QA result, a commit, a release,
 * an invoice, a reminder send, an amount or a payment verification.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const events: string[] = [];
let modelResult: unknown = null;
let rpcAnswer: Record<string, unknown> = {};
let rpcCalls: { schema: string; fn: string; args: Record<string, unknown> }[] = [];
let readFilters: { table: string; column: string; value: unknown }[] = [];
let tables: Record<string, Record<string, unknown>[]> = {};
let lastPrompt = '';

mock.module('../app/api/jobs/run/agent-run.ts', {
  namedExports: {
    settledSucceeded: { status: 'succeeded' },
    openRun: async () => { events.push('openRun'); return 'run-1'; },
    finishRun: async (_a: unknown, _r: unknown, status: string) => { events.push(`finishRun:${status}`); },
    succeedRun: async () => { events.push('succeedRun'); },
    failJob: async (_a: unknown, _j: unknown, reason: string) => { events.push(`failJob:${reason}`); },
    callModel: async (_c: unknown, _w: unknown, messages: { content: string }[]) => { events.push('model'); lastPrompt = messages[0]?.content ?? ''; return modelResult; },
  },
});

const { PHASE_EIGHT_ENG_WORKFLOWS } = await import('../app/api/jobs/run/phase-eight-eng-workflows.ts');
const { definitionFor } = await import('../src/modules/agents/registry.ts');

function makeAdmin() {
  return {
    schema: (s: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        events.push(`rpc:${s}.${fn}`);
        rpcCalls.push({ schema: s, fn, args });
        return { data: rpcAnswer[fn] ?? [{ outcome: 'proposed' }], error: null };
      },
      from: (table: string) => {
        const rows = tables[`${s}.${table}`] ?? [];
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'in', 'order', 'limit', 'update']) chain[m] = () => chain;
        chain.eq = (column: string, value: unknown) => { readFilters.push({ table: `${s}.${table}`, column, value }); return chain; };
        chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
        chain.then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
        return chain;
      },
    }),
  };
}
const ctxFor = (agentKey: string, payload: Record<string, unknown>) =>
  ({ admin: makeAdmin(), job: { id: 'job-1', organization_id: 'org-1', payload, correlation_id: 'c', attempts: 0, max_attempts: 5 }, agent: { key: agentKey, autonomy_level: 'L1', default_model: 'm' }, correlationId: 'c', workClass: 'draft' }) as never;
const usage = { inputTokens: 1, outputTokens: 1, costMinor: 0 };
const answer = (json: unknown) => { modelResult = { ok: true, json, usage, stepCount: 1 }; };
const wf = (kind: string) => PHASE_EIGHT_ENG_WORKFLOWS.find((w: { jobKind: string }) => w.jobKind === kind)!;
const secret = () => `api_key=${'x'.repeat(20)}`;
const COMMIT = 'a'.repeat(40);

const reset = () => {
  events.length = 0; rpcCalls = []; readFilters = []; rpcAnswer = {}; modelResult = null; lastPrompt = '';
  tables = {
    'projects.maintenance_agent_requests': [{ id: 'rq-1', agent_key: 'bug_fix', work_item_id: 'w-1' }],
    'projects.maintenance_work_items': [{ id: 'w-1', project_id: 'p-1', kind: 'patch', area: 'backend', title: 'Fix cart', description: null, status: 'fix_submitted', sensitive: false, commit_ref: COMMIT, fix_summary: 'guard', defect_id: 'd-1', change_request_id: null, ticket_id: null }],
    'qa.defects': [{ id: 'd-1', title: 'cart crash', reproduction: 'add item', expected: null, actual: null }],
    'finance.maintenance_billing_requests': [{ id: 'fq-1', kind: 'payment_reminder', plan_id: null, change_request_id: null, invoice_id: 'inv-1', client_account_id: 'a-1' }],
    'finance.invoices': [{ id: 'inv-1', number: 'INV-0042', status: 'issued', currency: 'INR' }],
    'core.client_accounts': [{ id: 'a-1', name: 'Acme' }],
    'projects.maintenance_plans': [{ id: 'pl-1', name: 'AMC', accepted_proposal_id: 'sp-1' }],
    'sales.proposal_items': [{ description: 'Annual maintenance', quantity: 1 }],
  };
};
const goodPlan = (over: Record<string, unknown> = {}) => ({ summary: 'Guard the null cart', steps: ['reproduce', 'add a guard'], risks: ['regression in checkout'], needsScopeChange: false, recommendsSecurityReview: false, evidenceRefs: ['defect:d-1'], ...over });

describe('the three workflows', () => {
  test('job kinds, agents and work class: all draft, all registered, none collides with another workflow', () => {
    assert.deepEqual(PHASE_EIGHT_ENG_WORKFLOWS.map((w: { jobKind: string }) => w.jobKind), ['maintenance.bug_fix.plan', 'maintenance.regression_test.plan', 'finance.maintenance_billing.propose']);
    for (const w of PHASE_EIGHT_ENG_WORKFLOWS) {
      assert.equal(w.workClass, 'draft');
      assert.ok(definitionFor(w.agentKey), w.agentKey);
    }
    const kinds = ['workflows.ts', 'development-workflows.ts', 'acquisition-workflows.ts', 'specialist-workflows.ts', 'development-specialist-workflows.ts', 'qa-specialist-workflows.ts']
      .flatMap((f) => [...read(`app/api/jobs/run/${f}`).matchAll(/jobKind: [`']([^`']+)[`']/g)].map((m) => m[1]!));
    for (const w of PHASE_EIGHT_ENG_WORKFLOWS) assert.ok(!kinds.includes(w.jobKind), w.jobKind);
  });
  test('the source writes only through its two service doors: no result, commit, release, invoice, payment or send', () => {
    const src = code('app/api/jobs/run/phase-eight-eng-workflows.ts');
    assert.deepEqual([...src.matchAll(/\.rpc\('([a-z_]+)'/g)].map((m) => m[1]).sort(), ['record_maintenance_agent_proposal', 'record_maintenance_billing_proposal']);
    for (const forbidden of ['record_maintenance_qa_result', 'submit_maintenance_fix', 'decide_maintenance_release', 'record_maintenance_release', 'verify_payment', 'record_manual_payment',
      'create_composed_invoice', 'create_change_request_invoice', 'issue_invoice', 'link_maintenance_invoice', 'sendMessage', '.insert(', '.upsert(', '.delete(']) {
      assert.ok(!src.includes(forbidden), `must not use ${forbidden}`);
    }
    assert.equal([...src.matchAll(/\.update\(/g)].length, 1, 'the only update settles its own core.jobs row');
  });
});

describe('the fix plan and the regression plan', () => {
  test('a valid plan is written through the one door, after the model', async () => {
    reset();
    answer(goodPlan());
    const r = await wf('maintenance.bug_fix.plan').run(ctxFor('bug_fix', { requestId: 'rq-1' }));
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(events.filter((e) => e.startsWith('rpc:') || ['openRun', 'model', 'succeedRun'].includes(e)), ['openRun', 'model', 'rpc:projects.record_maintenance_agent_proposal', 'succeedRun']);
    const a = rpcCalls[0]!.args;
    assert.equal(a.p_organization_id, 'org-1');
    assert.equal(a.p_agent_key, 'bug_fix');
    assert.equal(a.p_kind, 'fix_plan');
    assert.equal(a.p_commit_ref, COMMIT);
    assert.match(lastPrompt, /cart crash/);
  });
  test('every read is scoped to the JOB\'s organization, never one the payload names', async () => {
    reset();
    answer(goodPlan());
    await wf('maintenance.bug_fix.plan').run(ctxFor('bug_fix', { requestId: 'rq-1', organizationId: 'org-EVIL' }));
    assert.ok(readFilters.length > 0);
    assert.ok(readFilters.filter((f) => f.column === 'organization_id').every((f) => f.value === 'org-1'));
    assert.ok(!readFilters.some((f) => f.value === 'org-EVIL'));
  });
  test('a request for another agent, a missing payload and a closed item do not reach the model', async () => {
    reset();
    assert.equal((await wf('maintenance.regression_test.plan').run(ctxFor('regression_test', { requestId: 'rq-1' }))).status, 'failed');
    reset();
    assert.equal((await wf('maintenance.bug_fix.plan').run(ctxFor('bug_fix', {}))).status, 'failed');
    reset();
    tables['projects.maintenance_work_items']![0]!.status = 'released';
    const r = await wf('maintenance.bug_fix.plan').run(ctxFor('bug_fix', { requestId: 'rq-1' }));
    assert.equal(r.outcome, 'gone');
    assert.ok(!events.includes('model') && !events.some((e) => e.startsWith('rpc:')));
  });
  test('an answer that is not the schema, claims a result, or cites a stray reference writes nothing and fails the job', async () => {
    for (const bad of [{ summary: 'x' }, goodPlan({ approved: true }), goodPlan({ steps: ['all tests passed'] }), goodPlan({ evidenceRefs: ['defect:other'] }), goodPlan({ summary: secret() })]) {
      reset();
      answer(bad);
      const r = await wf('maintenance.bug_fix.plan').run(ctxFor('bug_fix', { requestId: 'rq-1' }));
      assert.equal(r.status, 'failed');
      assert.ok(!events.some((e) => e.startsWith('rpc:')), 'nothing written');
      assert.ok(events.some((e) => e.startsWith('failJob:')));
    }
  });
  test('a door refusal fails the job (never a silent success); a redelivery is fine', async () => {
    reset(); answer(goodPlan()); rpcAnswer.record_maintenance_agent_proposal = [{ outcome: 'wrong_commit' }];
    assert.equal((await wf('maintenance.bug_fix.plan').run(ctxFor('bug_fix', { requestId: 'rq-1' }))).status, 'failed');
    reset(); answer(goodPlan()); rpcAnswer.record_maintenance_agent_proposal = [{ outcome: 'already_proposed' }];
    assert.equal((await wf('maintenance.bug_fix.plan').run(ctxFor('bug_fix', { requestId: 'rq-1' }))).status, 'succeeded');
  });
  test('no provider fails the job honestly', async () => {
    reset(); modelResult = { ok: false, kind: 'no_provider', detail: 'none', stepCount: 0 };
    const r = await wf('maintenance.bug_fix.plan').run(ctxFor('bug_fix', { requestId: 'rq-1' }));
    assert.deepEqual([r.status, r.reason], ['failed', 'AI_PROVIDER_NOT_CONFIGURED']);
  });
});

describe('the Finance agent\'s proposal', () => {
  test('a reminder proposal goes through the one door with a narrative and a text, and NO amount', async () => {
    reset();
    answer({ narrative: 'Gentle reminder', reminderText: 'A reminder about INV-0042. Thank you.' });
    const r = await wf('finance.maintenance_billing.propose').run(ctxFor('finance', { requestId: 'fq-1' }));
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(rpcCalls.map((c) => `${c.schema}.${c.fn}`), ['finance.record_maintenance_billing_proposal']);
    assert.deepEqual(Object.keys(rpcCalls[0]!.args).sort(), ['p_agent_key', 'p_narrative', 'p_organization_id', 'p_reminder_text', 'p_request_id']);
    assert.ok(!/balance|amount|total/i.test(Object.keys(rpcCalls[0]!.args).join(',')));
  });
  test('an invoice proposal is built from the quoted items the person priced', async () => {
    reset();
    tables['finance.maintenance_billing_requests'] = [{ id: 'fq-1', kind: 'maintenance_invoice', plan_id: 'pl-1', change_request_id: null, invoice_id: null, client_account_id: 'a-1' }];
    answer({ narrative: 'First annual cycle', reminderText: null });
    const r = await wf('finance.maintenance_billing.propose').run(ctxFor('finance', { requestId: 'fq-1' }));
    assert.equal(r.status, 'succeeded');
    assert.match(lastPrompt, /Annual maintenance/);
  });
  test('an amount, a payment claim or a missing invoice number is refused before any write', async () => {
    for (const bad of [
      { narrative: 'n', reminderText: 'INV-0042 please pay ₹1,180' },
      { narrative: 'n', reminderText: 'INV-0042: we have received your payment' },
      { narrative: 'n', reminderText: 'please pay soon' },
      { narrative: secret(), reminderText: 'INV-0042 reminder' },
    ]) {
      reset(); answer(bad);
      const r = await wf('finance.maintenance_billing.propose').run(ctxFor('finance', { requestId: 'fq-1' }));
      assert.equal(r.status, 'failed');
      assert.ok(!events.some((e) => e.startsWith('rpc:')));
    }
  });
  test('an invoice that is no longer collectible produces no reminder and no model call', async () => {
    reset();
    tables['finance.invoices']![0]!.status = 'paid';
    const r = await wf('finance.maintenance_billing.propose').run(ctxFor('finance', { requestId: 'fq-1' }));
    assert.equal(r.outcome, 'gone');
    assert.ok(!events.includes('model'));
  });
  test('reads are for the job\'s organization', async () => {
    reset(); answer({ narrative: 'n', reminderText: 'INV-0042 reminder' });
    await wf('finance.maintenance_billing.propose').run(ctxFor('finance', { requestId: 'fq-1', organizationId: 'org-EVIL' }));
    assert.ok(readFilters.filter((f) => f.column === 'organization_id').every((f) => f.value === 'org-1'));
  });
});
