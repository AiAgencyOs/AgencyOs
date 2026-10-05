import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

/**
 * The acquisition agents' workflow, run against a stand-in model and a stand-in database (ADM-113). What is proved here is the ORDER
 * and the REFUSALS: the owner's stop is asked before the model, a stopped channel never reaches the model, the tools the model is
 * offered are exactly the ones that draft, check and ask a person, every call goes through the tenant's permissions, and a model that
 * answers with something that is not a report fails the job rather than succeeding.
 */

type Event = string;
const events: Event[] = [];
let blocked: string | null = null;
let modelAnswer: unknown = { summary: 'Drafted one post and submitted it for approval.', actions: ['draft v-1'] };
let offered: string[] = [];
let toolResults: { name: string; ok: boolean }[] = [];

mock.module('../app/api/jobs/run/agent-run.ts', {
  namedExports: {
    settledSucceeded: { status: 'succeeded' },
    openRun: async () => { events.push('openRun'); return 'run-1'; },
    finishRun: async (_a: unknown, _r: unknown, status: string) => { events.push(`finishRun:${status}`); },
    succeedRun: async () => { events.push('succeedRun'); },
    failJob: async (_a: unknown, _j: unknown, reason: string) => { events.push(`failJob:${reason}`); },
    callModelWithTools: async (_ctx: unknown, _spec: unknown, _msgs: unknown, tools: { name: string }[], _run: unknown, dispatch: (c: { name: string; input: unknown }) => Promise<{ ok: boolean }>) => {
      events.push('model');
      offered = tools.map((t) => t.name);
      for (const t of [...tools.map((x) => x.name), 'crm.sendClientMessage', 'approvals.requestApproval']) {
        const r = await dispatch({ name: t, input: {} });
        toolResults.push({ name: t, ok: r.ok });
      }
      return { ok: true, json: modelAnswer, usage: { inputTokens: 1, outputTokens: 1, costMinor: 0 }, stepCount: 1 };
    },
  },
});
mock.module('@/modules/agents/policy-enforcement', {
  namedExports: {
    dispatchToolUnderPolicy: async (a: { toolName: string; agentKey: string }) => {
      events.push(`policy:${a.toolName}`);
      // the real one goes policy -> boundary (resolveTool) -> dispatch; the boundary refusal is exercised in agent-tools tests
      const { resolveTool } = await import('../src/modules/agents/tools.ts');
      const ok = resolveTool(a.agentKey, a.toolName, 'L1').ok;
      return { ok, error: ok ? undefined : { message: 'refused' } };
    },
  },
});

const { ACQUISITION_WORKFLOWS } = await import('../app/api/jobs/run/acquisition-workflows.ts');

const admin = {
  schema: (s: string) => ({
    rpc: async (fn: string) => { events.push(`rpc:${s}.${fn}`); return { data: blocked, error: null }; },
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit', 'update']) chain[m] = () => chain;
      chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null });
      return chain;
    },
  }),
};
const ctxFor = (agentKey: string, task: unknown) => ({
  admin, job: { id: 'job-1', organization_id: 'org-1', payload: { task }, correlation_id: 'c' }, agent: { key: agentKey, autonomy_level: 'L1', default_model: 'm' }, correlationId: 'c', workClass: 'draft',
}) as never;
const reset = () => { events.length = 0; blocked = null; offered = []; toolResults = []; modelAnswer = { summary: 'Drafted one post and submitted it for approval.', actions: ['draft v-1'] }; };
const wf = (kind: string) => ACQUISITION_WORKFLOWS.find((w) => w.jobKind === kind)!;

describe('lead generation - an acquisition agent runs (ADM-113)', () => {
  test('there is one workflow per agent, each claiming its own job kind', () => {
    assert.deepEqual(ACQUISITION_WORKFLOWS.map((w) => [w.jobKind, w.agentKey]), [
      ['ads.assist', 'ad_manager'], ['email.assist', 'email_outreach'], ['social.assist', 'social_media'], ['marketplace.assist', 'marketplace_opportunity'],
    ]);
    for (const w of ACQUISITION_WORKFLOWS) assert.equal(w.workClass, 'draft');
  });

  test('the stop is asked before the model, and a stopped channel never reaches it', async () => {
    reset();
    blocked = 'channel_paused';
    const r = await wf('social.assist').run(ctxFor('social_media', 'Draft three posts about planning a storefront.'));
    assert.equal(r.status, 'succeeded');
    assert.ok(events.includes('rpc:crm.acquisition_blocked'));
    assert.ok(!events.includes('model') && !events.includes('openRun'));
  });

  test('a clear channel runs: the stop is read first, then the model, and a report is recorded', async () => {
    reset();
    const r = await wf('social.assist').run(ctxFor('social_media', 'Draft three posts about planning a storefront.'));
    assert.equal(r.status, 'succeeded');
    assert.ok(events.indexOf('rpc:crm.acquisition_blocked') < events.indexOf('model'));
    assert.ok(events.includes('succeedRun'));
  });

  test('the model is offered only what dispatches, every call goes through the tenant policy, and a tool the agent does not hold is refused', async () => {
    reset();
    await wf('ads.assist').run(ctxFor('ad_manager', 'Audit the last month and draft a Meta campaign.'));
    assert.ok(offered.includes('ads.draftCampaign') && offered.includes('acquisition.readResults'));
    assert.ok(!offered.includes('crm.sendClientMessage') && !offered.includes('memory.remember'));
    for (const t of offered) assert.ok(events.includes(`policy:${t}`), `${t} skipped the policy`);
    assert.deepEqual(toolResults.filter((t) => t.name === 'crm.sendClientMessage' || t.name === 'approvals.requestApproval').map((t) => t.ok), [false, false]);
    assert.ok(toolResults.filter((t) => offered.includes(t.name)).every((t) => t.ok));
  });

  test('an answer that is not a report fails the job instead of succeeding', async () => {
    reset();
    modelAnswer = { done: true };
    const r = await wf('email.assist').run(ctxFor('email_outreach', 'Score the newest prospects.'));
    assert.equal(r.status, 'failed');
    assert.ok(events.some((e) => e.startsWith('failJob:')) && !events.includes('succeedRun'));
  });

  test('a task that is missing or absurd is refused before anything runs', async () => {
    for (const task of [undefined, '', 'hi', 'x'.repeat(3001)]) {
      reset();
      const r = await wf('marketplace.assist').run(ctxFor('marketplace_opportunity', task));
      assert.equal(r.status, 'failed');
      assert.ok(!events.includes('model') && !events.some((e) => e.startsWith('rpc:')));
    }
  });
});
