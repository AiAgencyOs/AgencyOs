import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

/**
 * The Phase 9B changes to the finance workflows and the cron sweep, against a STAND-IN model and database (nothing here ran on a real model):
 * a paused agent does no work and its job goes back to the queue (an unreadable pause fails closed); a proposal is written with ONE validated handoff
 * payload built from the request's own rows; a pause that lands mid-run stops the write and requeues; the sweep calls only its two runner doors.
 */

const events: string[] = [];
let modelResult: unknown = null;
let rpcAnswer: Record<string, unknown> = {};
let rpcError: Record<string, string> = {};
let rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let tables: Record<string, Record<string, unknown>[]> = {};

mock.module('../app/api/jobs/run/agent-run.ts', {
  namedExports: {
    settledSucceeded: { status: 'succeeded' },
    openRun: async () => { events.push('openRun'); return 'run-1'; },
    finishRun: async (_a: unknown, _r: unknown, status: string) => { events.push(`finishRun:${status}`); },
    succeedRun: async () => { events.push('succeedRun'); },
    failJob: async (_a: unknown, _j: unknown, reason: string) => { events.push(`failJob:${reason}`); },
    callModel: async () => { events.push('model'); return modelResult; },
  },
});

const { PHASE_NINE_WORKFLOWS } = await import('../app/api/jobs/run/phase-nine-workflows.ts');
const { AgentsPaused } = await import('../src/lib/ai/run-gates.ts');
const { sweepFinancePhaseNineB } = await import('../src/modules/orchestrator/sweeps.ts');

const ORG = '00000000-0000-4000-8000-0000000000e1';
const PROJECT = '00000000-0000-4000-8000-0000000000f1';
const REQ = '00000000-0000-4000-8000-000000000091';
const REQUESTER = '00000000-0000-4000-8000-0000000000b1';
const CLIENT = '00000000-0000-4000-8000-0000000000c9';
const INV = '00000000-0000-4000-8000-0000000000a1';

const POSITION = { result: 'blocked', totals: { contractMinor: 100000 }, milestones: [], blockers: [{ code: 'unverified_money', reason: 'x', ref: null }] };

function makeAdmin() {
  return {
    schema: (s: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        events.push(`rpc:${fn}`);
        rpcCalls.push({ fn, args });
        if (fn in rpcError) return { data: null, error: { message: rpcError[fn] } };
        if (fn in rpcAnswer) return { data: rpcAnswer[fn], error: null };
        if (fn === 'project_close_position') return { data: POSITION, error: null };
        if (fn === 'invoice_outstanding_minor') return { data: 12000, error: null };
        return { data: [{ outcome: 'proposed' }], error: null };
      },
      from: (table: string) => {
        const rows = tables[`${s}.${table}`] ?? [];
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'in', 'order', 'limit', 'eq']) chain[m] = () => chain;
        chain.update = () => chain;
        chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
        chain.then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
        return chain;
      },
    }),
  };
}
const ctx = (agentKey: string) =>
  ({ admin: makeAdmin(), job: { id: 'job-1', organization_id: ORG, payload: { requestId: REQ }, correlation_id: 'corr-9', attempts: 1, max_attempts: 5 }, agent: { key: agentKey, autonomy_level: 'L1', default_model: 'm' }, correlationId: 'c', workClass: 'draft' }) as never;
const usage = { inputTokens: 1, outputTokens: 1, costMinor: 0 };
const wf = (kind: string) => PHASE_NINE_WORKFLOWS.find((w: { jobKind: string }) => w.jobKind === kind)!;
const flag = { kind: 'anomaly_flag', summary: 'a submission claims money no verified payment matches', detail: null, evidenceRefs: [`invoice:${INV}`], submissionId: null, draftBody: null, amountMinor: null, exceptionKind: null };

const reset = (agent = 'finance_reconciliation', invoiceId: string | null = null) => {
  events.length = 0; rpcCalls = []; rpcAnswer = {}; rpcError = {}; modelResult = { ok: true, json: { proposals: [flag] }, usage, stepCount: 1 };
  tables = {
    'finance.finance_agent_requests': [{ id: REQ, agent_key: agent, project_id: PROJECT, invoice_id: invoiceId, requested_by: REQUESTER }],
    'projects.projects': [{ id: PROJECT, name: 'Acme web', currency: 'INR', client_account_id: CLIENT }],
    'finance.invoices': [{ id: INV, number: 'INV-1', status: 'overdue', total_minor: 30000, due_at: '2026-09-01T00:00:00Z' }],
    'finance.payment_submissions': [], 'finance.payments': [], 'finance.finance_exceptions': [], 'finance.waivers': [], 'projects.milestones': [],
  };
};

describe('the finance automation pause in the workflow', () => {
  test('a paused agent does no work: it throws AgentsPaused before any model call or write, so the runner requeues the job', async () => {
    reset();
    rpcAnswer.finance_automation_is_paused = true;
    await assert.rejects(() => wf('finance.finance_reconciliation.propose').run(ctx('finance_reconciliation')), (e: unknown) => e instanceof AgentsPaused);
    assert.ok(!events.includes('model') && !events.includes('openRun'));
    assert.equal(rpcCalls.filter((c) => c.fn === 'record_finance_proposal').length, 0);
    assert.deepEqual(rpcCalls[0], { fn: 'finance_automation_is_paused', args: { p_organization_id: ORG, p_agent_key: 'finance_reconciliation' } });
  });
  test('an unreadable pause fails closed: the job fails and nothing runs', async () => {
    reset();
    rpcError.finance_automation_is_paused = 'boom';
    const r = await wf('finance.finance_reconciliation.propose').run(ctx('finance_reconciliation'));
    assert.equal(r.status, 'failed');
    assert.match(String(r.reason), /pause/);
    assert.ok(!events.includes('model'));
  });
  test('not paused: the run proceeds', async () => {
    reset();
    rpcAnswer.finance_automation_is_paused = false;
    const r = await wf('finance.finance_reconciliation.propose').run(ctx('finance_reconciliation'));
    assert.equal(r.status, 'succeeded');
  });
  test('a pause that lands mid-run: the door answers automation_paused, the workflow throws AgentsPaused with the run, and does not report success', async () => {
    reset();
    rpcAnswer.record_finance_proposal = [{ outcome: 'automation_paused' }];
    await assert.rejects(() => wf('finance.finance_reconciliation.propose').run(ctx('finance_reconciliation')), (e: unknown) => e instanceof AgentsPaused && (e as { runId: string | null }).runId === 'run-1');
    assert.ok(!events.includes('succeedRun'));
  });
});

describe('the handoff payload the workflow sends', () => {
  test('every proposal goes to the door with one handoff built from the request rows', async () => {
    reset();
    const r = await wf('finance.finance_reconciliation.propose').run(ctx('finance_reconciliation'));
    assert.equal(r.status, 'succeeded');
    const w = rpcCalls.filter((c) => c.fn === 'record_finance_proposal');
    assert.equal(w.length, 1);
    const h = w[0]!.args.p_handoff as Record<string, unknown>;
    assert.equal(h.organizationId, ORG);
    assert.equal(h.projectId, PROJECT);
    assert.equal(h.requestId, REQ);
    assert.equal(h.clientAccountId, CLIENT);
    assert.equal(h.agentKey, 'finance_reconciliation');
    assert.equal(h.kind, 'anomaly_flag');
    assert.deepEqual(h.evidenceRefs, [`invoice:${INV}`]);
    assert.equal(h.financialState, 'blocked');
    assert.equal(h.correlationId, 'corr-9');
    assert.deepEqual(h.retry, { attempt: 1, maxAttempts: 5 });
    assert.deepEqual(h.approvals, { requestedBy: REQUESTER, independentReviewRequired: true });
    assert.deepEqual(h.policy, { ref: 'phase9.finance-agent', moneyAuthority: 'none' });
  });
  test('a reminder names the request invoice and the database balance, not the model figure', async () => {
    reset('finance_communication', INV);
    modelResult = { ok: true, usage, stepCount: 1, json: { proposals: [{ kind: 'reminder_draft', summary: 'Reminder', detail: null, evidenceRefs: [], submissionId: null, draftBody: 'Invoice INV-1 is past due. Please pay the balance of INR 120.00.', amountMinor: 12000, exceptionKind: null }] } };
    const r = await wf('finance.finance_communication.propose').run(ctx('finance_communication'));
    assert.equal(r.status, 'succeeded');
    const h = rpcCalls.find((c) => c.fn === 'record_finance_proposal')!.args.p_handoff as Record<string, unknown>;
    assert.equal(h.invoiceId, INV);
    assert.equal(h.expectedAmountMinor, 12000);
  });
  test('a request with no requester cannot produce a valid handoff: the job fails before the door', async () => {
    reset();
    tables['finance.finance_agent_requests'] = [{ id: REQ, agent_key: 'finance_reconciliation', project_id: PROJECT, invoice_id: null, requested_by: null }];
    const r = await wf('finance.finance_reconciliation.propose').run(ctx('finance_reconciliation'));
    assert.equal(r.status, 'failed');
    assert.match(String(r.reason), /handoff/);
    assert.equal(rpcCalls.filter((c) => c.fn === 'record_finance_proposal').length, 0);
  });
});

describe('the Phase 9B cron sweep', () => {
  test('it calls exactly its two runner doors and reports what they answered', async () => {
    const calls: string[] = [];
    const admin = { schema: () => ({ rpc: async (fn: string) => { calls.push(fn); return { data: fn === 'sweep_reconciliation_due' ? [{ due_recorded: 1, opened: 1, waiting: 0 }] : [{ checked: 3, flagged: 1 }], error: null }; } }) };
    const r = await sweepFinancePhaseNineB(admin as never);
    assert.deepEqual(calls.sort(), ['sweep_payment_account_checks', 'sweep_reconciliation_due']);
    assert.deepEqual(r, { reconciliationOpened: 1, submissionsChecked: 3, submissionsFlagged: 1 });
  });
  test('a failing door is logged and never throws into the tick; both failing is null', async () => {
    const admin = { schema: () => ({ rpc: async () => ({ data: null, error: { message: 'down' } }) }) };
    assert.equal(await sweepFinancePhaseNineB(admin as never), null);
    const thrower = { schema: () => ({ rpc: async () => { throw new Error('x'); } }) };
    assert.equal(await sweepFinancePhaseNineB(thrower as never), null);
  });
});
