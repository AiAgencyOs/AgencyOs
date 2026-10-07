import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The post-launch Sales discovery workflow, run against a STAND-IN model and a STAND-IN database. NOTHING here ran on a real model. What is proved is the ORDER
 * (read for the job's organization, ask, validate, then write), the REFUSALS (a shape that is not the schema, a price, a discount, a commitment, a secret, a
 * citation of a record the facts do not contain, no citation at all) and WHERE it writes: ONE service-only door, never a deal, a quote or a qualification.
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

const { PHASE_EIGHT_SALES_WORKFLOWS } = await import('../app/api/jobs/run/phase-eight-sales-workflows.ts');
const { definitionFor } = await import('../src/modules/agents/registry.ts');

function makeAdmin() {
  return {
    schema: (s: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        events.push(`rpc:${s}.${fn}`);
        rpcCalls.push({ schema: s, fn, args });
        return { data: rpcAnswer[fn] ?? [{ outcome: 'drafted' }], error: null };
      },
      from: (table: string) => {
        const rows = tables[`${s}.${table}`] ?? [];
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'in', 'order', 'limit']) chain[m] = () => chain;
        chain.update = () => chain;
        chain.eq = (column: string, value: unknown) => { readFilters.push({ table: `${s}.${table}`, column, value }); return chain; };
        chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
        chain.then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
        return chain;
      },
    }),
  };
}
const ctxFor = (payload: Record<string, unknown>) =>
  ({ admin: makeAdmin(), job: { id: 'job-1', organization_id: 'org-1', payload, correlation_id: 'c', attempts: 0, max_attempts: 5 }, agent: { key: 'sales', autonomy_level: 'L1', default_model: 'm' } }) as never;
const usage = { inputTokens: 1, outputTokens: 1, costMinor: 0 };
const answer = (json: unknown) => { modelResult = { ok: true, json, usage, stepCount: 1 }; };
const wf = PHASE_EIGHT_SALES_WORKFLOWS[0]!;
const secret = () => `api_key=${'x'.repeat(20)}`;

const OPP = '00000000-0000-4000-8000-0000000000b1';
const T1 = '00000000-0000-4000-8000-0000000000a1';
const CI = '00000000-0000-4000-8000-0000000000c1';
const STRANGER = '00000000-0000-4000-8000-0000000000ff';

const reset = () => {
  events.length = 0; rpcCalls = []; readFilters = []; rpcAnswer = {}; modelResult = null; lastPrompt = '';
  tables = {
    'sales.phase_eight_opportunities': [{ id: OPP, project_id: 'p-1', kind: 'change_request', need: 'The client has asked twice for a loyalty points programme', urgency: 'normal', status: 'qualified' }],
    'projects.projects': [{ name: 'Shop' }],
    'projects.support_tickets': [{ id: T1, title: 'Loyalty points request', classification: 'change_request', status: 'closed' }],
    'projects.cs_check_ins': [{ id: CI, kind: 'adoption', outcome: 'spoke about loyalty' }],
  };
  rpcAnswer.customer_health_status = [{ status: 'stable' }];
};
const brief = (over: Record<string, unknown> = {}) => ({
  summary: 'The client wants a loyalty programme for returning customers and has raised it twice.',
  questions: ['How do returning customers buy today?', 'Who would administer a loyalty programme?'],
  citedTicketIds: [T1],
  citedCheckInIds: [CI],
  ...over,
});

describe('the discovery workflow', () => {
  test('one job kind, the sales agent, draft work', () => {
    assert.deepEqual(PHASE_EIGHT_SALES_WORKFLOWS.map((w: { jobKind: string }) => w.jobKind), ['sales.draft_discovery_brief']);
    assert.equal(wf.workClass, 'draft');
    assert.equal(wf.agentKey, 'sales');
    assert.ok(definitionFor('sales'));
  });
  test('its job kind collides with no other workflow', () => {
    const kinds = readdirSync(fileURLToPath(new URL('../app/api/jobs/run/', import.meta.url)))
      .filter((f) => f.endsWith('.ts') && f !== 'phase-eight-sales-workflows.ts')
      .flatMap((f) => [...read(`app/api/jobs/run/${f}`).matchAll(/^\s*jobKind: '([a-z_.]+)',/gm)].map((m) => m[1]!));
    assert.ok(!kinds.includes(wf.jobKind));
  });
  test('the source writes ONLY through the one discovery door and never qualifies, hands off, quotes, discounts or opens a deal', () => {
    const src = code('app/api/jobs/run/phase-eight-sales-workflows.ts');
    const rpcs = [...src.matchAll(/\.rpc\('([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(rpcs.filter((n) => n!.startsWith('record_')), ['record_discovery_brief_draft']);
    assert.deepEqual([...new Set(rpcs.filter((n) => !n!.startsWith('record_')))], ['customer_health_status']);
    for (const forbidden of ['qualify_phase_eight_opportunity', 'hand_off_phase_eight_opportunity', 'close_phase_eight_opportunity', 'sales.proposals', 'record_discount_decision', 'set_proposal_pricing', 'draft_proposal', 'send_outbound_message', 'open_renewal', '.insert(', '.delete(', '.upsert(']) {
      assert.ok(!src.includes(forbidden), `the workflow must not use ${forbidden}`);
    }
    assert.equal([...src.matchAll(/\.update\(/g)].length, 1, 'the only update is settling its own core.jobs row');
  });
  test('order: read, model, then the one door, with the job\'s organization and the sales agent', async () => {
    reset();
    answer(brief());
    const r = await wf.run(ctxFor({ opportunityId: OPP }));
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(events.filter((e) => e.startsWith('rpc:') || ['openRun', 'model', 'succeedRun'].includes(e)), ['rpc:projects.customer_health_status', 'openRun', 'model', 'rpc:projects.record_discovery_brief_draft', 'succeedRun']);
    const args = rpcCalls.find((c) => c.fn === 'record_discovery_brief_draft')!.args;
    assert.equal(args.p_organization_id, 'org-1');
    assert.equal(args.p_opportunity_id, OPP);
    assert.equal(args.p_agent_key, 'sales');
    assert.deepEqual(args.p_context_refs, { ticketIds: [T1], checkInIds: [CI] });
    assert.match(lastPrompt, /loyalty points programme/);
  });
  test('every read is scoped to the JOB\'s organization, never one the payload names', async () => {
    reset();
    answer(brief());
    await wf.run(ctxFor({ opportunityId: OPP, organizationId: 'org-2', organization_id: 'org-2' }));
    const orgFilters = readFilters.filter((f) => f.column === 'organization_id');
    assert.ok(orgFilters.length >= 4);
    assert.ok(orgFilters.every((f) => f.value === 'org-1'));
  });
  test('an opportunity in another organization is simply not there: nothing is asked and nothing is written', async () => {
    reset();
    tables['sales.phase_eight_opportunities'] = [];
    const r = await wf.run(ctxFor({ opportunityId: OPP }));
    assert.equal(r.status, 'succeeded');
    assert.equal((r as { outcome?: string }).outcome, 'gone');
    assert.ok(!events.includes('model') && rpcCalls.length === 0);
  });
  for (const status of ['detected', 'suppressed', 'lost', 'accepted']) {
    test(`an opportunity a person has not qualified (${status}) is not worked`, async () => {
      reset();
      tables['sales.phase_eight_opportunities'] = [{ id: OPP, project_id: 'p-1', kind: 'change_request', need: 'x', urgency: 'normal', status }];
      const r = await wf.run(ctxFor({ opportunityId: OPP }));
      assert.equal((r as { outcome?: string }).outcome, 'gone');
      assert.ok(!events.includes('model'));
    });
  }
  test('a payload with no opportunity fails before anything is read', async () => {
    reset();
    const r = await wf.run(ctxFor({}));
    assert.equal(r.status, 'failed');
    assert.ok(events.some((e) => e.startsWith('failJob:')) && !events.includes('model'));
  });
  for (const [what, over] of [
    ['an extra key', { surprise: true }],
    ['a price in the summary', { summary: 'The client wants loyalty points and would pay $2000 for it.' }],
    ['a currency word in a question', { questions: ['Would Rs. 5000 a month be acceptable to you?'] }],
    ['a discount in a question', { questions: ['Would a discount on the first year help you decide?'] }],
    ['a free-work promise', { summary: 'The client wants loyalty points and we will do it free of charge for them.' }],
    ['a secret in the summary', { summary: `The client shared ${secret()} while describing the need.` }],
    ['a ticket the facts do not contain', { citedTicketIds: [STRANGER] }],
    ['a check-in the facts do not contain', { citedCheckInIds: [STRANGER] }],
    ['no citation at all', { citedTicketIds: [], citedCheckInIds: [] }],
    ['a question that is too short', { questions: ['Why?'] }],
    ['no question', { questions: [] }],
  ] as const) {
    test(`refused before any write: ${what}`, async () => {
      reset();
      answer(brief(over));
      const r = await wf.run(ctxFor({ opportunityId: OPP }));
      assert.equal(r.status, 'failed');
      assert.equal(rpcCalls.filter((c) => c.fn === 'record_discovery_brief_draft').length, 0, 'the door is never called');
      assert.ok(events.some((e) => e.startsWith('failJob:the model')));
    });
  }
  test('no provider configured fails honestly and writes nothing', async () => {
    reset();
    modelResult = { ok: false, kind: 'no_provider', detail: 'no key', stepCount: 0 };
    const r = await wf.run(ctxFor({ opportunityId: OPP }));
    assert.equal(r.status, 'failed');
    assert.equal((r as { reason?: string }).reason, 'AI_PROVIDER_NOT_CONFIGURED');
    assert.equal(rpcCalls.filter((c) => c.fn === 'record_discovery_brief_draft').length, 0);
  });
  test('a provider error fails and writes nothing', async () => {
    reset();
    modelResult = { ok: false, kind: 'provider_error', detail: 'upstream 500', stepCount: 1 };
    const r = await wf.run(ctxFor({ opportunityId: OPP }));
    assert.equal(r.status, 'failed');
    assert.equal(rpcCalls.filter((c) => c.fn === 'record_discovery_brief_draft').length, 0);
  });
  test('a door that refuses fails the job instead of reporting success', async () => {
    reset();
    answer(brief());
    rpcAnswer.record_discovery_brief_draft = [{ outcome: 'opportunity_not_qualified' }];
    const r = await wf.run(ctxFor({ opportunityId: OPP }));
    assert.equal(r.status, 'failed');
    assert.ok(!events.includes('succeedRun'));
  });
  test('a retried run is a good answer: already_recorded succeeds', async () => {
    reset();
    answer(brief());
    rpcAnswer.record_discovery_brief_draft = [{ outcome: 'already_recorded' }];
    const r = await wf.run(ctxFor({ opportunityId: OPP }));
    assert.equal(r.status, 'succeeded');
  });
  test('the file is not yet wired into the runner: the parent appends the spread (report it)', () => {
    const src = read('app/api/jobs/run/workflows.ts');
    assert.ok(!src.includes('PHASE_EIGHT_SALES_WORKFLOWS') || /\.\.\.PHASE_EIGHT_SALES_WORKFLOWS/.test(src), 'either absent, or wired as ONE spread');
  });
});
