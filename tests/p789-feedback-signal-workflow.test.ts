import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The Customer Success feedback-signal workflow (P7-CS-05), run against a STAND-IN model and a STAND-IN database. NOTHING here ran on a real model. What is
 * proved is the ORDER (read for the job's organization, ask, validate, then write), the REFUSALS (a shape that is not the schema, a price, a refund, a secret, a
 * citation the facts do not contain, a signal the cited rows do not support) and WHERE it writes: ONE service-only door that stores a DRAFT.
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

const { P789_FEEDBACK_SIGNAL_WORKFLOWS } = await import('../app/api/jobs/run/p789-feedback-signal-workflow.ts');
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
  ({ admin: makeAdmin(), job: { id: 'job-1', organization_id: 'org-1', payload, correlation_id: 'c', attempts: 0, max_attempts: 5 }, agent: { key: 'customer_success', autonomy_level: 'L1', default_model: 'm' } }) as never;
const usage = { inputTokens: 1, outputTokens: 1, costMinor: 0 };
const answer = (json: unknown) => { modelResult = { ok: true, json, usage, stepCount: 1 }; };
const wf = P789_FEEDBACK_SIGNAL_WORKFLOWS[0]!;
const secret = () => `api_key=${'x'.repeat(20)}`;

const PROJECT = '00000000-0000-4000-8000-0000000000d1';
const FN = '00000000-0000-4000-8000-0000000000a1';
const FP = '00000000-0000-4000-8000-0000000000a2';
const STRANGER = '00000000-0000-4000-8000-0000000000ff';

const reset = () => {
  events.length = 0; rpcCalls = []; readFilters = []; rpcAnswer = {}; modelResult = null; lastPrompt = '';
  tables = {
    'projects.projects': [{ name: 'Shop' }],
    'projects.client_feedback': [
      { id: FN, sentiment: 'negative', source: 'call', body: 'checkout was confusing and slow' },
      { id: FP, sentiment: 'positive', source: 'email', body: 'the catalogue is lovely' },
    ],
  };
};
const signal = (over: Record<string, unknown> = {}) => ({
  signal: 'complaint',
  summary: 'The client found the checkout confusing and slow when they called.',
  citedFeedbackIds: [FN],
  ...over,
});
const calls = (fn: string) => rpcCalls.filter((c) => c.fn === fn).length;

describe('the feedback-signal workflow', () => {
  test('one job kind, the customer success agent, draft work', () => {
    assert.deepEqual(P789_FEEDBACK_SIGNAL_WORKFLOWS.map((w: { jobKind: string }) => w.jobKind), ['customer_success.draft_feedback_signal']);
    assert.equal(wf.workClass, 'draft');
    assert.equal(wf.agentKey, 'customer_success');
    assert.ok(definitionFor('customer_success'));
  });
  test('its job kind collides with no other workflow', () => {
    const kinds = readdirSync(fileURLToPath(new URL('../app/api/jobs/run/', import.meta.url)))
      .filter((f) => f.endsWith('.ts') && f !== 'p789-feedback-signal-workflow.ts')
      .flatMap((f) => [...read(`app/api/jobs/run/${f}`).matchAll(/^\s*jobKind: '([a-z_.]+)',/gm)].map((m) => m[1]!));
    assert.ok(!kinds.includes(wf.jobKind));
  });
  test('the source writes ONLY through the one signal door and opens no ticket, check-in or opportunity', () => {
    const src = code('app/api/jobs/run/p789-feedback-signal-workflow.ts');
    const rpcs = [...src.matchAll(/\.rpc\('([a-z_0-9]+)'/g)].map((m) => m[1]);
    assert.deepEqual(rpcs, ['p789_record_feedback_signal_draft']);
    for (const forbidden of ['create_check_in', 'open_support_ticket', 'record_phase_eight_opportunity', 'send_outbound_message', 'request_ticket_handoff', '.insert(', '.delete(', '.upsert(']) {
      assert.ok(!src.includes(forbidden), `the workflow must not use ${forbidden}`);
    }
    assert.equal([...src.matchAll(/\.update\(/g)].length, 1, 'the only update is settling its own core.jobs row');
  });
  test('order: read, model, then the one door, with the job\'s organization and the agent key', async () => {
    reset();
    answer(signal());
    const r = await wf.run(ctxFor({ projectId: PROJECT }));
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(events.filter((e) => e.startsWith('rpc:') || ['openRun', 'model', 'succeedRun'].includes(e)), ['openRun', 'model', 'rpc:projects.p789_record_feedback_signal_draft', 'succeedRun']);
    const args = rpcCalls[0]!.args;
    assert.equal(args.p_organization_id, 'org-1');
    assert.equal(args.p_project_id, PROJECT);
    assert.equal(args.p_agent_key, 'customer_success');
    assert.equal(args.p_signal, 'complaint');
    assert.deepEqual(args.p_cited_feedback_ids, [FN]);
    assert.match(lastPrompt, /checkout was confusing/);
  });
  test('every read is scoped to the JOB\'s organization, never one the payload names', async () => {
    reset();
    answer(signal());
    await wf.run(ctxFor({ projectId: PROJECT, organizationId: 'org-2', organization_id: 'org-2' }));
    const orgFilters = readFilters.filter((f) => f.column === 'organization_id');
    assert.ok(orgFilters.length >= 2);
    assert.ok(orgFilters.every((f) => f.value === 'org-1'));
  });
  test('a project that is not there, or has no feedback, asks nothing and writes nothing', async () => {
    reset();
    tables['projects.client_feedback'] = [];
    const r = await wf.run(ctxFor({ projectId: PROJECT }));
    assert.equal(r.status, 'succeeded');
    assert.equal((r as { outcome?: string }).outcome, 'gone');
    assert.ok(!events.includes('model') && rpcCalls.length === 0);
  });
  test('a payload with no project fails before anything is read', async () => {
    reset();
    const r = await wf.run(ctxFor({}));
    assert.equal(r.status, 'failed');
    assert.ok(events.some((e) => e.startsWith('failJob:')) && !events.includes('model'));
  });
  test('citing the same row twice sends it once', async () => {
    reset();
    answer(signal({ citedFeedbackIds: [FN, FN] }));
    await wf.run(ctxFor({ projectId: PROJECT }));
    assert.deepEqual(rpcCalls[0]!.args.p_cited_feedback_ids, [FN]);
  });
  for (const [what, over] of [
    ['an extra key', { surprise: true }],
    ['an unknown signal', { signal: 'rumour' }],
    ['a refund in the summary', { summary: 'The client was unhappy and we should refund the whole first month.' }],
    ['a discount in the summary', { summary: 'The client was unhappy so a discount would settle it quickly.' }],
    ['a price in the summary', { summary: 'The client said checkout was slow and would pay $500 to fix it.' }],
    ['a secret in the summary', { summary: `The client shared ${secret()} while describing the checkout.` }],
    ['a row the facts do not contain', { citedFeedbackIds: [STRANGER] }],
    ['no citation at all', { citedFeedbackIds: [] }],
    ['a complaint resting on positive feedback', { signal: 'complaint', citedFeedbackIds: [FP] }],
    ['praise citing a complaint', { signal: 'praise', citedFeedbackIds: [FP, FN], summary: 'The client praised the catalogue and the checkout both.' }],
    ['a mixed signal citing only one kind', { signal: 'mixed', citedFeedbackIds: [FN], summary: 'The client liked some parts and disliked others overall.' }],
    ['a summary that is too short', { summary: 'slow' }],
  ] as const) {
    test(`refused before any write: ${what}`, async () => {
      reset();
      answer(signal(over));
      const r = await wf.run(ctxFor({ projectId: PROJECT }));
      assert.equal(r.status, 'failed');
      assert.equal(calls('p789_record_feedback_signal_draft'), 0, 'the door is never called');
      assert.ok(events.some((e) => e.startsWith('failJob:the model')));
    });
  }
  test('a mixed signal citing both kinds is accepted', async () => {
    reset();
    answer(signal({ signal: 'mixed', citedFeedbackIds: [FN, FP], summary: 'The client liked the catalogue but found the checkout confusing.' }));
    const r = await wf.run(ctxFor({ projectId: PROJECT }));
    assert.equal(r.status, 'succeeded');
  });
  test('no provider configured fails honestly and writes nothing', async () => {
    reset();
    modelResult = { ok: false, kind: 'no_provider', detail: 'no key', stepCount: 0 };
    const r = await wf.run(ctxFor({ projectId: PROJECT }));
    assert.equal(r.status, 'failed');
    assert.equal((r as { reason?: string }).reason, 'AI_PROVIDER_NOT_CONFIGURED');
    assert.equal(calls('p789_record_feedback_signal_draft'), 0);
  });
  test('a provider error fails and writes nothing', async () => {
    reset();
    modelResult = { ok: false, kind: 'provider_error', detail: 'upstream 500', stepCount: 1 };
    const r = await wf.run(ctxFor({ projectId: PROJECT }));
    assert.equal(r.status, 'failed');
    assert.equal(calls('p789_record_feedback_signal_draft'), 0);
  });
  test('a door that refuses fails the job instead of reporting success', async () => {
    reset();
    answer(signal());
    rpcAnswer.p789_record_feedback_signal_draft = [{ outcome: 'cited_feedback_not_this_projects' }];
    const r = await wf.run(ctxFor({ projectId: PROJECT }));
    assert.equal(r.status, 'failed');
    assert.ok(!events.includes('succeedRun'));
  });
  test('a retried run is a good answer: already_recorded succeeds', async () => {
    reset();
    answer(signal());
    rpcAnswer.p789_record_feedback_signal_draft = [{ outcome: 'already_recorded' }];
    const r = await wf.run(ctxFor({ projectId: PROJECT }));
    assert.equal(r.status, 'succeeded');
  });
  test('the file is not wired into the runner by this change: the parent appends the spread (report it)', () => {
    const src = read('app/api/jobs/run/workflows.ts');
    assert.ok(!src.includes('P789_FEEDBACK_SIGNAL_WORKFLOWS') || /\.\.\.P789_FEEDBACK_SIGNAL_WORKFLOWS/.test(src), 'either absent, or wired as ONE spread');
  });
});

describe('the migration holds the same rules as the module', () => {
  const sql = readdirSync(fileURLToPath(new URL('../supabase/migrations/', import.meta.url))).filter((f) => f.startsWith('20261129200000_')).map((f) => read(`supabase/migrations/${f}`)).join('\n');
  test('the door is service-role only and the review door is not', () => {
    assert.match(sql, /grant execute on function projects\.p789_record_feedback_signal_draft\(uuid, uuid, text, text, text, uuid\[\]\) to service_role;/);
    assert.match(sql, /revoke all on function projects\.p789_review_feedback_signal_draft\(uuid, text, text\) from public, anon, service_role;/);
  });
  test('the refusals the workflow checks are checked again in the database', () => {
    for (const code of ['not_the_customer_success_agent', 'names_a_price', 'contains_secret', 'cited_feedback_not_this_projects', 'a_complaint_cites_negative_feedback', 'praise_cites_no_negative_feedback', 'mixed_cites_both_kinds']) {
      assert.ok(sql.includes(`'${code}'`), code);
    }
  });
});
