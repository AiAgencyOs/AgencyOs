import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The three Phase 9 finance-agent workflows, run against a STAND-IN model and a STAND-IN database. NOTHING here ran on a real model. What is proved is the
 * ORDER (read for the job's organization, ask, validate, then write), the REFUSALS (a shape that is not the schema, a figure that is not the database's
 * balance, a claim that money arrived, a promised concession, a record the model was never shown) and WHERE they write: ONE service-only door
 * (finance.record_finance_proposal), never a payment, a refund, a waiver, an invoice, a message or a close.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
/** Source with its comments removed: a comment may NAME a forbidden door to say it is not used. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const events: string[] = [];
let modelResult: unknown = null;
let rpcAnswer: Record<string, unknown> = {};
let rpcCalls: { schema: string; fn: string; args: Record<string, unknown> }[] = [];
let readFilters: { table: string; column: string; value: unknown }[] = [];
let tables: Record<string, Record<string, unknown>[]> = {};
let jobUpdates: Record<string, unknown>[] = [];
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

const { PHASE_NINE_WORKFLOWS } = await import('../app/api/jobs/run/phase-nine-workflows.ts');
const { definitionFor } = await import('../src/modules/agents/registry.ts');

const INV = '00000000-0000-4000-8000-0000000000a1';
const PAY = '00000000-0000-4000-8000-0000000000c1';

function makeAdmin() {
  return {
    schema: (s: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        events.push(`rpc:${s}.${fn}`);
        rpcCalls.push({ schema: s, fn, args });
        if (fn in rpcAnswer) return { data: rpcAnswer[fn], error: null };
        if (fn === 'project_close_position') return { data: POSITION, error: null };
        if (fn === 'invoice_outstanding_minor') return { data: 12000, error: null };
        return { data: [{ outcome: 'proposed' }], error: null };
      },
      from: (table: string) => {
        const rows = tables[`${s}.${table}`] ?? [];
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'in', 'order', 'limit']) chain[m] = () => chain;
        chain.update = (v: Record<string, unknown>) => { jobUpdates.push(v); return chain; };
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
const wf = (kind: string) => PHASE_NINE_WORKFLOWS.find((w: { jobKind: string }) => w.jobKind === kind)!;

const POSITION = {
  result: 'blocked',
  totals: { contractMinor: 100000, verifiedNetMinor: 30000, outstandingMinor: 70000 },
  milestones: [{ name: 'M1', plannedMinor: 30000, invoicedMinor: 30000, verifiedNetMinor: 30000, waivedMinor: 0, outstandingMinor: 0, unverifiedMinor: 0 }],
  blockers: [{ code: 'unverified_money', reason: 'Payments are recorded but not verified.' }],
};

const reset = (agent = 'finance_reconciliation', invoiceId: string | null = null) => {
  events.length = 0; rpcCalls = []; readFilters = []; rpcAnswer = {}; modelResult = null; jobUpdates = []; lastPrompt = '';
  tables = {
    'finance.finance_agent_requests': [{ id: 'rq-1', agent_key: agent, project_id: 'p-1', invoice_id: invoiceId }],
    'projects.projects': [{ id: 'p-1', name: 'Acme web', currency: 'INR' }],
    'finance.invoices': [{ id: INV, number: 'INV-1', status: 'overdue', total_minor: 30000, due_at: '2026-09-01T00:00:00Z' }],
    'finance.payment_submissions': [{ id: 's-1', invoice_id: INV, status: 'pending_verification', amount_minor: 12000, reference: 'UTR1' }],
    'finance.payments': [{ id: PAY, invoice_id: INV, amount_minor: 12000, status: 'captured', verified_at: null }],
    'finance.finance_exceptions': [],
    'finance.waivers': [],
    'projects.milestones': [{ id: 'm-1', name: 'M1' }],
  };
};
const flag = (over: Record<string, unknown> = {}) => ({ kind: 'anomaly_flag', summary: 'a submission claims money no verified payment matches', detail: null, evidenceRefs: [`invoice:${INV}`, `payment:${PAY}`], submissionId: null, draftBody: null, amountMinor: null, exceptionKind: null, ...over });

describe('the three workflows come from one factory', () => {
  test('one job kind and one agent each, all draft work, all agents the registry defines', () => {
    assert.deepEqual(PHASE_NINE_WORKFLOWS.map((w: { jobKind: string }) => w.jobKind), ['finance.finance_reconciliation.propose', 'finance.finance_communication.propose', 'finance.finance_close.propose']);
    for (const w of PHASE_NINE_WORKFLOWS) {
      assert.equal(w.workClass, 'draft');
      assert.ok(definitionFor(w.agentKey), `${w.agentKey} is defined in the registry`);
      assert.equal(definitionFor(w.agentKey)?.moneyAuthority, 'none');
      assert.deepEqual(definitionFor(w.agentKey)?.tools, []);
      assert.equal(w.jobKind, `finance.${w.agentKey}.propose`);
    }
  });
  test('their job kinds collide with no other workflow', () => {
    const kinds = ['workflows.ts', 'development-workflows.ts', 'acquisition-workflows.ts', 'specialist-workflows.ts', 'qa-specialist-workflows.ts']
      .flatMap((f) => [...read(`app/api/jobs/run/${f}`).matchAll(/^\s*jobKind: '([a-z_.]+)',/gm)].map((m) => m[1]!));
    for (const w of PHASE_NINE_WORKFLOWS) assert.ok(!kinds.includes(w.jobKind), w.jobKind);
  });
  test('workflows.ts is NOT edited by this file: the parent appends the spread (reported)', () => {
    const src = read('app/api/jobs/run/workflows.ts');
    assert.ok(!src.includes('PHASE_NINE_WORKFLOWS') || /\.\.\.PHASE_NINE_WORKFLOWS/.test(src), 'either absent, or wired as ONE spread');
  });
  test('the source writes ONLY through the proposal door and never touches money, an invoice, a message or a close', () => {
    const src = code('app/api/jobs/run/phase-nine-workflows.ts');
    const rpcs = [...src.matchAll(/\.rpc\('([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(rpcs, ['project_close_position', 'invoice_outstanding_minor', 'record_finance_proposal']);
    for (const forbidden of ['verify_payment', 'record_manual_payment', 'record_refund', 'request_refund', 'decide_waiver', 'request_waiver', 'close_project_finances', 'close_period', 'issue_invoice', 'void_invoice',
      'accept_finance_proposal', 'sendClientMessage', '.insert(', '.upsert(', '.delete(']) {
      assert.ok(!src.includes(forbidden), `the workflow must not use ${forbidden}`);
    }
    assert.equal([...src.matchAll(/\.update\(/g)].length, 1, 'the only update is settling its own core.jobs row');
  });
});

describe('order and reads: read, model, validate, write', () => {
  test('a valid flag is written through the one door, after the model and never before', async () => {
    reset();
    answer({ proposals: [flag()] });
    const r = await wf('finance.finance_reconciliation.propose').run(ctxFor('finance_reconciliation', { requestId: 'rq-1' }));
    assert.equal(r.status, 'succeeded');
    const interesting = events.filter((e) => e.startsWith('rpc:finance.record') || ['openRun', 'model', 'succeedRun'].includes(e));
    assert.deepEqual(interesting, ['openRun', 'model', 'rpc:finance.record_finance_proposal', 'succeedRun']);
    const writes = rpcCalls.filter((c) => c.fn === 'record_finance_proposal');
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.args.p_request_id, 'rq-1');
    assert.equal(writes[0]!.args.p_organization_id, 'org-1');
    assert.equal(writes[0]!.args.p_agent_key, 'finance_reconciliation');
    assert.equal(writes[0]!.args.p_kind, 'anomaly_flag');
    assert.equal(jobUpdates.length, 1);
  });
  test('every read is scoped to the JOB\'s organization, never one the payload names', async () => {
    reset();
    answer({ proposals: [flag()] });
    await wf('finance.finance_reconciliation.propose').run(ctxFor('finance_reconciliation', { requestId: 'rq-1', organizationId: 'org-ATTACKER' }));
    assert.ok(readFilters.length >= 6);
    for (const f of readFilters.filter((x) => x.column === 'organization_id')) assert.equal(f.value, 'org-1');
    assert.ok(!readFilters.some((f) => f.value === 'org-ATTACKER'));
    assert.ok(readFilters.some((f) => f.table === 'finance.finance_agent_requests' && f.column === 'organization_id'));
  });
  test('the model is shown the database\'s position and balance, not a figure the workflow computed', async () => {
    reset('finance_communication', INV);
    answer({ proposals: [{ kind: 'reminder_draft', summary: 'Reminder', detail: null, evidenceRefs: [], submissionId: null, draftBody: 'Invoice INV-1 is past due. Please pay the balance of INR 120.00.', amountMinor: 12000, exceptionKind: null }] });
    const r = await wf('finance.finance_communication.propose').run(ctxFor('finance_communication', { requestId: 'rq-1' }));
    assert.equal(r.status, 'succeeded');
    assert.match(lastPrompt, /Position result: blocked/);
    assert.match(lastPrompt, /outstanding balance is 12000 minor units/);
    assert.ok(rpcCalls.some((c) => c.fn === 'project_close_position') && rpcCalls.some((c) => c.fn === 'invoice_outstanding_minor'));
  });
  test('a redelivered run is a good answer: already_proposed settles the job', async () => {
    reset();
    answer({ proposals: [flag()] });
    rpcAnswer.record_finance_proposal = [{ outcome: 'already_proposed' }];
    const r = await wf('finance.finance_reconciliation.propose').run(ctxFor('finance_reconciliation', { requestId: 'rq-1' }));
    assert.equal(r.status, 'succeeded');
    assert.equal(r.alreadyProposed, 1);
  });
});

describe('what is refused before anything is written', () => {
  const run = async (agent: string, proposals: unknown[], invoiceId: string | null = null) => {
    reset(agent, invoiceId);
    answer({ proposals });
    const r = await wf(`finance.${agent}.propose`).run(ctxFor(agent, { requestId: 'rq-1' }));
    return { r, wrote: rpcCalls.filter((c) => c.fn === 'record_finance_proposal').length };
  };
  test('a shape that is not the schema', async () => {
    reset();
    answer({ proposals: [{ ...flag(), verified: true }] });
    const r = await wf('finance.finance_reconciliation.propose').run(ctxFor('finance_reconciliation', { requestId: 'rq-1' }));
    assert.equal(r.status, 'failed');
    assert.equal(rpcCalls.filter((c) => c.fn === 'record_finance_proposal').length, 0);
  });
  test('evidence the model was never shown', async () => {
    const { r, wrote } = await run('finance_reconciliation', [flag({ evidenceRefs: ['invoice:00000000-0000-4000-8000-0000000fffff'] })]);
    assert.equal(r.status, 'failed');
    assert.match(String(r.reason), /not in the facts/);
    assert.equal(wrote, 0);
  });
  test('one bad proposal refuses the whole answer', async () => {
    const { r, wrote } = await run('finance_reconciliation', [flag(), flag({ summary: 'second', evidenceRefs: ['nonsense'] })]);
    assert.equal(r.status, 'failed');
    assert.equal(wrote, 0);
  });
  test('a reminder quoting a balance that is not the database\'s', async () => {
    const { r, wrote } = await run('finance_communication', [{ kind: 'reminder_draft', summary: 'x', detail: null, evidenceRefs: [], submissionId: null, draftBody: 'Please pay INR 300.00.', amountMinor: 30000, exceptionKind: null }], INV);
    assert.equal(r.status, 'failed');
    assert.match(String(r.reason), /real outstanding balance/);
    assert.equal(wrote, 0);
  });
  test('a reminder that claims payment or promises a waiver', async () => {
    for (const body of ['We have received your payment, thank you.', 'We can waive the fee if you pay today.']) {
      const { r, wrote } = await run('finance_communication', [{ kind: 'reminder_draft', summary: 'x', detail: null, evidenceRefs: [], submissionId: null, draftBody: body, amountMinor: 12000, exceptionKind: null }], INV);
      assert.equal(r.status, 'failed', body);
      assert.equal(wrote, 0);
    }
  });
  test('a close agent that declares the project closed', async () => {
    const { r, wrote } = await run('finance_close', [{ kind: 'close_readiness_note', summary: 'The project is now financially closed.', detail: null, evidenceRefs: [], submissionId: null, draftBody: null, amountMinor: null, exceptionKind: null }]);
    assert.equal(r.status, 'failed');
    assert.equal(wrote, 0);
  });
  test('an agent writing another agent\'s kind', async () => {
    const { r, wrote } = await run('finance_close', [flag()]);
    assert.equal(r.status, 'failed');
    assert.equal(wrote, 0);
  });
  test('the door refusing is a failure, and nothing is reported as proposed', async () => {
    reset();
    answer({ proposals: [flag()] });
    rpcAnswer.record_finance_proposal = [{ outcome: 'wrong_organization' }];
    const r = await wf('finance.finance_reconciliation.propose').run(ctxFor('finance_reconciliation', { requestId: 'rq-1' }));
    assert.equal(r.status, 'failed');
    assert.match(String(r.reason), /wrong_organization/);
    assert.ok(!events.includes('succeedRun'));
  });
  test('a provider outage corrupts nothing: the job fails and no door is called', async () => {
    reset();
    modelResult = { ok: false, kind: 'no_provider', detail: 'no provider', stepCount: 0 };
    const r = await wf('finance.finance_reconciliation.propose').run(ctxFor('finance_reconciliation', { requestId: 'rq-1' }));
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'AI_PROVIDER_NOT_CONFIGURED');
    assert.equal(rpcCalls.filter((c) => c.fn === 'record_finance_proposal').length, 0);
  });
  test('a request for another agent, a missing request and a missing payload', async () => {
    reset('finance_close');
    answer({ proposals: [flag()] });
    const wrong = await wf('finance.finance_reconciliation.propose').run(ctxFor('finance_reconciliation', { requestId: 'rq-1' }));
    assert.equal(wrong.status, 'failed');
    reset();
    tables['finance.finance_agent_requests'] = [];
    const gone = await wf('finance.finance_reconciliation.propose').run(ctxFor('finance_reconciliation', { requestId: 'rq-1' }));
    assert.equal(gone.status, 'succeeded');
    assert.equal(gone.outcome, 'gone');
    const bad = await wf('finance.finance_reconciliation.propose').run(ctxFor('finance_reconciliation', {}));
    assert.equal(bad.status, 'failed');
  });
});
