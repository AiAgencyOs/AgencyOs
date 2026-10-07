import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';

// agent-run.ts reaches @/lib/env, whose eager public-variable parse needs these set before the (dynamic) imports below. Placeholders only.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

const { costFor, recordRunUsageCost } = await import('../app/api/jobs/run/usage-cost.ts');
const { recordModelCall } = await import('../app/api/jobs/run/agent-run.ts');
const { HANDLERS, HANDLER_JOB_KIND, SUBSCRIPTIONS } = await import('../src/lib/events/catalog.ts');
const { dispatchToolUnderPolicy } = await import('../src/modules/agents/policy-enforcement.ts');
const { handleRouteQaOutcome } = await import('../src/modules/orchestrator/qa-outcome.ts');
const { STALE_BUILD_REQUEST_AFTER, sweepStaleOrchestratorRecords } = await import('../src/modules/orchestrator/sweeps.ts');

/**
 * The Orchestrator's writers have callers: every model call's cost, every refused tool call, the QA outcome handler and the sweeps. The database
 * half (leases on start_task, the QA event triggers) is proved by scripts/verify-phase5-wiring.sql; this proves the TypeScript half, with fakes for
 * the database client.
 */

type Call = { fn: string; args: Record<string, unknown> };
// the fake client is structurally typed on purpose: the tests care what was asked of the doors, not what the generated types say
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdmin = any;

const PROJECT = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';

function costAdmin(options: { run?: { agent_key: string; input: unknown } | null; answer?: unknown; throwOnRpc?: boolean; throwOnRun?: boolean } = {}) {
  const calls: Call[] = [];
  const admin = {
    schema(name: string) {
      if (name === 'ai') {
        return {
          from() {
            return {
              select() {
                return {
                  eq() {
                    return {
                      maybeSingle: async () => {
                        if (options.throwOnRun) throw new Error('database unreachable');
                        return { data: options.run === undefined ? { agent_key: 'frontend_developer', input: { projectId: PROJECT, taskId: TASK } } : options.run, error: null };
                      },
                    };
                  },
                };
              },
              insert: async () => ({ error: null }),
            };
          },
        };
      }
      return {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          if (options.throwOnRpc) throw new Error('rpc exploded');
          calls.push({ fn, args });
          return { data: options.answer ?? [{ outcome: 'recorded', usage_id: 'u1' }], error: null };
        },
      };
    },
  };
  return { admin: admin as AnyAdmin, calls };
}

function silenced<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const original = console.error;
  const logs: string[] = [];
  console.error = (line: unknown) => { logs.push(String(line)); };
  return fn().then((result) => ({ result, logs })).finally(() => { console.error = original; });
}

describe('1. a model call\'s cost is recorded, and says where its number came from', () => {
  test('a figure from the Admin\'s price is estimated; no figure is unknown, never zero', () => {
    assert.deepEqual(costFor({ inputTokens: 10, outputTokens: 5, costMinor: 250 }), { source: 'estimated', costUsd: 2.5 });
    assert.deepEqual(costFor({ inputTokens: 10, outputTokens: 5, costMinor: 0 }), { source: 'unknown', costUsd: null });
    assert.deepEqual(costFor({ inputTokens: 10, outputTokens: 5, costMinor: Number.NaN }), { source: 'unknown', costUsd: null });
  });

  test('a run on a project writes the cost through record_usage_cost, with its task, model and tokens', async () => {
    const { admin, calls } = costAdmin();
    await recordRunUsageCost(admin, { runId: 'r1', providerId: 'openrouter', model: 'm-1', usage: { inputTokens: 100, outputTokens: 50, costMinor: 250 } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.fn, 'record_usage_cost');
    assert.deepEqual(calls[0]!.args, {
      p_project_id: PROJECT, p_agent_key: 'frontend_developer', p_cost_source: 'estimated', p_cost_usd: 2.5, p_task_id: TASK,
      p_provider: 'openrouter', p_model: 'm-1', p_input_tokens: 100, p_output_tokens: 50,
    });
  });

  test('an unknown cost stays NULL', async () => {
    const { admin, calls } = costAdmin();
    await recordRunUsageCost(admin, { runId: 'r1', providerId: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costMinor: 0 } });
    assert.equal(calls[0]!.args.p_cost_source, 'unknown');
    assert.equal(calls[0]!.args.p_cost_usd, null);
  });

  test('a run with no project (or no id, or no usage) has nothing to charge and writes nothing', async () => {
    const usage = { inputTokens: 1, outputTokens: 1, costMinor: 5 };
    const none = costAdmin({ run: { agent_key: 'sales', input: { conversationId: 'c' } } });
    await recordRunUsageCost(none.admin, { runId: 'r1', providerId: 'p', model: 'm', usage });
    const noRun = costAdmin({ run: null });
    await recordRunUsageCost(noRun.admin, { runId: 'r1', providerId: 'p', model: 'm', usage });
    const noId = costAdmin();
    await recordRunUsageCost(noId.admin, { runId: null, providerId: 'p', model: 'm', usage });
    await recordRunUsageCost(noId.admin, { runId: 'r1', providerId: 'p', model: 'm', usage: null });
    assert.equal(none.calls.length + noRun.calls.length + noId.calls.length, 0);
  });

  test('a task id that is not a uuid is not sent', async () => {
    const { admin, calls } = costAdmin({ run: { agent_key: 'x', input: { projectId: PROJECT, taskId: 'not-a-uuid' } } });
    await recordRunUsageCost(admin, { runId: 'r1', providerId: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costMinor: 5 } });
    assert.equal(calls[0]!.args.p_task_id, null);
  });

  test('a failure to write the cost never fails the run: a throw, an error answer and a refusal are all swallowed (and logged)', async () => {
    for (const options of [{ throwOnRpc: true }, { throwOnRun: true }, { answer: [{ outcome: 'task_not_in_project' }] }]) {
      const { admin } = costAdmin(options);
      const { logs } = await silenced(() => recordRunUsageCost(admin, { runId: 'r1', providerId: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costMinor: 5 } }));
      assert.equal(logs.length, 1, JSON.stringify(options));
      assert.match(logs[0] ?? '', /recordRunUsageCost/);
    }
  });

  test('recordModelCall (the one place every model turn passes) records the cost, and a cost failure leaves the step count untouched', async () => {
    const { admin, calls } = costAdmin();
    const args = {
      organizationId: 'o', runId: 'r1', seq: 3, providerId: 'openrouter',
      request: { model: 'm-1', system: 's', messages: [], schemaName: 'x', effort: 'low' },
      result: { ok: true as const, data: { json: {}, model: 'm-1', usage: { inputTokens: 9, outputTokens: 4, costMinor: 12 } } },
      latencyMs: 5,
    };
    assert.equal(await recordModelCall(admin, args), 4);
    assert.equal(calls.filter((c) => c.fn === 'record_usage_cost').length, 1);

    const broken = costAdmin({ throwOnRpc: true });
    const { result } = await silenced(() => recordModelCall(broken.admin, args));
    assert.equal(result, 4, 'the agent run carries on');
  });

  test('a failed model call has no usage and so no cost record', async () => {
    const { admin, calls } = costAdmin();
    await recordModelCall(admin, {
      organizationId: 'o', runId: 'r1', seq: 0, providerId: 'p',
      request: { model: 'm', system: 's', messages: [], schemaName: 'x', effort: 'low' },
      result: { ok: false as const, error: { code: 'PROVIDER_ERROR', message: 'boom', correlationId: 'c' } },
      latencyMs: 1,
    });
    assert.equal(calls.length, 0);
  });
});

describe('2. a refused tool call is audited as a denial, by name and never by value', () => {
  const SECRET = ['sk', 'live', 'abcdefghijklmnop'].join('-');
  function denialAdmin(answer: unknown = [{ outcome: 'recorded' }], throws = false) {
    const calls: Call[] = [];
    const admin = {
      schema() {
        return {
          rpc: async (fn: string, args: Record<string, unknown>) => {
            calls.push({ fn, args });
            if (throws && fn === 'record_tool_dispatch_denial') throw new Error('rpc exploded');
            return { data: fn === 'record_tool_dispatch_denial' ? answer : null, error: null };
          },
        };
      },
    };
    return { admin: admin as AnyAdmin, calls };
  }
  const base = { organizationId: 'org', agentKey: 'sales', agentAutonomy: 'L0' as const, runId: null };

  test('an owner-denied tool on a named project writes tool_not_bound with the argument NAMES only', async () => {
    const { admin, calls } = denialAdmin();
    const policy = { organizationId: 'org', agentKey: 'sales', permissions: new Map([['memory.recall', false]]), assignedProjectIds: [] };
    const result = await dispatchToolUnderPolicy({ ...base, admin, toolName: 'memory.recall', input: { projectId: PROJECT, scope: 'project', note: SECRET }, policy });
    assert.equal(result.ok, false);
    const denial = calls.find((c) => c.fn === 'record_tool_dispatch_denial');
    assert.ok(denial, 'the denial was written');
    assert.equal(denial.args.p_project_id, PROJECT);
    assert.equal(denial.args.p_agent_key, 'sales');
    assert.equal(denial.args.p_tool, 'memory.recall');
    assert.equal(denial.args.p_code, 'tool_not_bound');
    assert.deepEqual(denial.args.p_arg_keys, ['projectId', 'scope', 'note']);
    assert.ok(!JSON.stringify(denial.args).includes(SECRET), 'no argument value reaches the audit');
  });

  test('a project the agent is not assigned to is out_of_scope', async () => {
    const { admin, calls } = denialAdmin();
    const policy = { organizationId: 'org', agentKey: 'sales', permissions: new Map([['memory.recall', true]]), assignedProjectIds: ['99999999-9999-4999-8999-999999999999'] };
    await dispatchToolUnderPolicy({ ...base, admin, toolName: 'memory.recall', input: { projectId: PROJECT, scope: 'project', scopeId: PROJECT }, policy });
    assert.equal(calls.find((c) => c.fn === 'record_tool_dispatch_denial')?.args.p_code, 'out_of_scope');
  });

  test('a tool the agent\'s definition does not bind is refused by the boundary and audited as tool_not_bound', async () => {
    const { admin, calls } = denialAdmin();
    const policy = { organizationId: 'org', agentKey: 'sales', permissions: new Map([['finance.generateInvoice', true]]), assignedProjectIds: [] };
    const result = await dispatchToolUnderPolicy({ ...base, admin, toolName: 'finance.generateInvoice', input: { projectId: PROJECT }, policy });
    assert.equal(result.ok, false);
    assert.equal(calls.find((c) => c.fn === 'record_tool_dispatch_denial')?.args.p_code, 'tool_not_bound');
  });

  test('an agent that is not registered at all is unknown_agent', async () => {
    const { admin, calls } = denialAdmin();
    const policy = { organizationId: 'org', agentKey: 'nobody', permissions: new Map([['memory.recall', true]]), assignedProjectIds: [] };
    await dispatchToolUnderPolicy({ ...base, admin, agentKey: 'nobody', toolName: 'memory.recall', input: { projectId: PROJECT }, policy });
    assert.equal(calls.find((c) => c.fn === 'record_tool_dispatch_denial')?.args.p_code, 'unknown_agent');
  });

  test('a call that names no project has nothing to audit against and writes no denial (the policy refusal row stands)', async () => {
    const { admin, calls } = denialAdmin();
    const policy = { organizationId: 'org', agentKey: 'sales', permissions: new Map([['memory.recall', false]]), assignedProjectIds: [] };
    const result = await dispatchToolUnderPolicy({ ...base, admin, toolName: 'memory.recall', input: { scope: 'organization' }, policy });
    assert.equal(result.ok, false);
    assert.equal(calls.filter((c) => c.fn === 'record_tool_dispatch_denial').length, 0);
    assert.equal(calls.filter((c) => c.fn === 'record_agent_policy_refusal').length, 1);
  });

  test('a denial that cannot be written changes nothing for the caller', async () => {
    const policy = { organizationId: 'org', agentKey: 'sales', permissions: new Map([['memory.recall', false]]), assignedProjectIds: [] };
    for (const broken of [denialAdmin(undefined, true), denialAdmin([{ outcome: 'not_found' }])]) {
      const { result } = await silenced(() => dispatchToolUnderPolicy({ ...base, admin: broken.admin, toolName: 'memory.recall', input: { projectId: PROJECT }, policy }));
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.error.code, 'FORBIDDEN');
    }
  });
});

describe('3. the QA outcome is wired from the event to the handler', () => {
  test('both event types reach one handler, which has a job kind and is in the catalog', () => {
    assert.deepEqual((SUBSCRIPTIONS as Record<string, readonly string[]>)['project.dev_task_qa_failed'], ['orchestrator:routeQaOutcome']);
    assert.deepEqual((SUBSCRIPTIONS as Record<string, readonly string[]>)['project.dev_task_qa_passed'], ['orchestrator:routeQaOutcome']);
    assert.ok((HANDLERS as readonly string[]).includes('orchestrator:routeQaOutcome'));
    assert.equal((HANDLER_JOB_KIND as Record<string, string>)['orchestrator:routeQaOutcome'], 'development.route_qa_outcome');
  });

  test('the runner claims that job kind and runs the handler; the migration registers both event types and the triggers that emit them', () => {
    const route = readFileSync(new URL('../app/api/jobs/run/route.ts', import.meta.url), 'utf8');
    assert.match(route, /runEventJobs\(admin, QA_OUTCOME_ROUTE_JOB_KIND, handleRouteQaOutcome,/);
    const file = readdirSync(new URL('../supabase/migrations/', import.meta.url)).find((f) => f.startsWith('20261103100000_'));
    assert.ok(file);
    const sql = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
    for (const t of ['project.dev_task_qa_failed', 'project.dev_task_qa_passed']) assert.ok(sql.includes(`('${t}',`), t);
    assert.match(sql, /create trigger task_test_evidence_emit_qa after insert on projects\.task_test_evidence/);
    assert.match(sql, /create trigger defects_emit_task_qa_failed after insert on qa\.defects/);
  });

  // a table-shaped fake: each read answers from `tables`, every write is recorded
  function qaAdmin(tables: Record<string, unknown[]>, options: { failTable?: string; commits?: string[] } = {}) {
    const writes: { table: string; row: Record<string, unknown> }[] = [];
    let commitsAsked = 0;
    const admin = {
      schema(schema: string) {
        return {
          from(table: string) {
            const key = `${schema}.${table}`;
            const rows = () => (tables[key] ?? []) as Record<string, unknown>[];
            const failing = options.failTable === key;
            const reader: Record<string, unknown> = {};
            for (const m of ['select', 'eq', 'in', 'order', 'limit']) reader[m] = () => reader;
            reader.maybeSingle = async () => {
              if (failing) return { data: null, error: { message: 'unreadable' } };
              if (key === 'projects.deliverable_details' && options.commits) {
                const commit = options.commits[Math.min(commitsAsked, options.commits.length - 1)];
                commitsAsked += 1;
                return { data: { commit_ref: commit }, error: null };
              }
              return { data: rows()[0] ?? null, error: null };
            };
            reader.then = (resolve: (v: unknown) => unknown) => Promise.resolve(failing ? { data: null, error: { message: 'unreadable' } } : { data: rows(), error: null }).then(resolve);
            reader.upsert = async (row: Record<string, unknown>) => { writes.push({ table: key, row }); return { error: null }; };
            return reader;
          },
        };
      },
    };
    return { admin: admin as AnyAdmin, writes };
  }
  const job = (eventType: string) => ({ id: 'j', organization_id: 'org', correlation_id: null, payload: { eventType, subjectId: TASK } });
  const task = { id: TASK, project_id: PROJECT, plan_id: 'plan-1', required_capability: 'frontend_developer', risk_level: 'medium', status: 'in_progress' };
  const agents = [{ key: 'bug_fix', enabled: true }, { key: 'frontend_developer', enabled: true }];
  const closedRun = (over: Record<string, unknown>) => ({ id: 'run-1', deliverable_id: 'build-1', status: 'closed', passed: 3, failed: 0, blocked: 0, executed_at: 't', executed_by: null, executed_by_agent: 'test_automation', tester_id: null, ...over });
  const decisionOf = (writes: { table: string; row: Record<string, unknown> }[]) => writes.find((w) => w.table === 'projects.routing_decisions')?.row;
  const outcomeOf = (r: Awaited<ReturnType<typeof handleRouteQaOutcome>>) => (r.status === 'succeeded' ? r.outcome : undefined);

  test('QA failed with a defect routes the fix to the Bug Fix specialist and records the decision', async () => {
    const { admin, writes } = qaAdmin({
      'projects.tasks': [task], 'projects.task_test_evidence': [{ test_run_id: 'run-1' }], 'qa.test_runs': [closedRun({ failed: 1 })],
      'qa.defects': [{ id: 'def-1', status: 'open' }], 'ai.agents': agents,
    });
    const result = await handleRouteQaOutcome(admin, job('project.dev_task_qa_failed'));
    assert.equal(outcomeOf(result), 'routed');
    const decision = decisionOf(writes);
    assert.ok(decision);
    assert.equal(decision.to_agent, 'bug_fix');
    assert.equal(decision.code, 'qa_failed_to_bug_fix');
    assert.equal(decision.task_id, TASK);
    assert.equal(writes.filter((w) => w.table === 'projects.orchestrator_escalations').length, 0);
  });

  test('QA failed without a defect is incomplete work: it goes back to the original specialist', async () => {
    const { admin, writes } = qaAdmin({
      'projects.tasks': [task], 'projects.task_test_evidence': [{ test_run_id: 'run-1' }], 'qa.test_runs': [closedRun({ passed: 1, blocked: 2 })], 'qa.defects': [], 'ai.agents': agents,
    });
    await handleRouteQaOutcome(admin, job('project.dev_task_qa_failed'));
    assert.equal(decisionOf(writes)?.code, 'qa_failed_to_original_specialist');
  });

  test('a failure past the retry budget is refused and escalated to a person', async () => {
    const runs = [1, 2, 3, 4].map((n) => closedRun({ id: `r${n}`, passed: 0, failed: 1, executed_at: `t${n}` }));
    const { admin, writes } = qaAdmin({
      'projects.tasks': [task], 'projects.task_test_evidence': runs.map((r) => ({ test_run_id: r.id })), 'qa.test_runs': runs, 'qa.defects': [{ id: 'd1', status: 'open' }], 'ai.agents': agents,
    });
    const result = await handleRouteQaOutcome(admin, job('project.dev_task_qa_failed'));
    assert.equal(outcomeOf(result), 'refused');
    assert.equal(decisionOf(writes)?.code, 'attempts_exhausted');
    assert.equal(writes.filter((w) => w.table === 'projects.orchestrator_escalations').length, 1);
  });

  test('an event the rows no longer bear out records nothing: QA failed, but the newest run passed', async () => {
    const { admin, writes } = qaAdmin({
      'projects.tasks': [task], 'projects.task_test_evidence': [{ test_run_id: 'run-2' }], 'qa.test_runs': [closedRun({ id: 'run-2', passed: 4 })], 'qa.defects': [], 'ai.agents': agents,
    });
    const result = await handleRouteQaOutcome(admin, job('project.dev_task_qa_failed'));
    assert.equal(outcomeOf(result), 'stale');
    assert.equal(writes.length, 0);
  });

  const passingTables = (over: Record<string, unknown[]> = {}) => ({
    'projects.tasks': [task],
    'projects.task_test_evidence': [{ test_run_id: 'run-2' }],
    'qa.test_runs': [closedRun({ id: 'run-2', passed: 4, executed_by_agent: 'quality_assurance' })],
    'qa.defects': [],
    'projects.deliverable_details': [{ commit_ref: 'abc1234567890' }],
    'projects.deliverables': [{ id: 'build-1' }],
    'projects.routing_decisions': [],
    'projects.task_dependencies': [],
    ...over,
  });

  test('QA passed, independently, on the commit now present: eligible for integration (and never "accepted")', async () => {
    const { admin, writes } = qaAdmin(passingTables());
    const result = await handleRouteQaOutcome(admin, job('project.dev_task_qa_passed'));
    assert.equal(outcomeOf(result), 'routed');
    assert.equal(decisionOf(writes)?.code, 'qa_passed_eligible_for_integration');
    assert.equal(decisionOf(writes)?.to_agent, null);
  });

  test('a pass from the producer is refused as not independent; one with no named verifier is not independent either', async () => {
    const own = qaAdmin(passingTables({ 'qa.test_runs': [closedRun({ id: 'run-2', passed: 4, executed_by_agent: 'frontend_developer' })] }));
    await handleRouteQaOutcome(own.admin, job('project.dev_task_qa_passed'));
    assert.equal(decisionOf(own.writes)?.code, 'qa_not_independent');
    const nobody = qaAdmin(passingTables({ 'qa.test_runs': [closedRun({ id: 'run-2', passed: 4, executed_by_agent: null })] }));
    await handleRouteQaOutcome(nobody.admin, job('project.dev_task_qa_passed'));
    assert.equal(decisionOf(nobody.writes)?.code, 'qa_not_independent');
  });

  test('a pass by a person is attributed to the person; a high-risk task is held for a security review nobody has recorded', async () => {
    const person = qaAdmin(passingTables({ 'qa.test_runs': [closedRun({ id: 'run-2', passed: 4, executed_by: 'u-1', executed_by_agent: null })] }));
    await handleRouteQaOutcome(person.admin, job('project.dev_task_qa_passed'));
    assert.equal(decisionOf(person.writes)?.code, 'qa_passed_eligible_for_integration');
    const risky = qaAdmin(passingTables({ 'projects.tasks': [{ ...task, risk_level: 'high' }] }));
    await handleRouteQaOutcome(risky.admin, job('project.dev_task_qa_passed'));
    assert.equal(decisionOf(risky.writes)?.code, 'security_review_pending');
  });

  test('a pass that covered an older commit than the one now present is held, not reused', async () => {
    const { admin, writes } = qaAdmin(passingTables(), { commits: ['aaaaaaaaaaaaa', 'bbbbbbbbbbbbb'] });
    await handleRouteQaOutcome(admin, job('project.dev_task_qa_passed'));
    assert.equal(decisionOf(writes)?.code, 'stale_qa_pass');
  });

  test('an unreadable table is a retryable failure, never a decision made on a guess', async () => {
    for (const failTable of ['projects.tasks', 'projects.task_test_evidence', 'qa.defects']) {
      const { admin, writes } = qaAdmin({ 'projects.tasks': [task], 'projects.task_test_evidence': [], 'qa.defects': [], 'ai.agents': agents }, { failTable });
      const result = await handleRouteQaOutcome(admin, job('project.dev_task_qa_failed'));
      assert.equal(result.status, 'failed', failTable);
      assert.equal(result.status === 'failed' && result.permanent, false, failTable);
      assert.equal(writes.length, 0, failTable);
    }
  });

  test('a task outside a plan, a vanished task, and an event this handler does not route are each answered without a write', async () => {
    const outside = qaAdmin({ 'projects.tasks': [{ ...task, plan_id: null }] });
    assert.equal(outcomeOf(await handleRouteQaOutcome(outside.admin, job('project.dev_task_qa_failed'))), 'not_mine');
    const gone = qaAdmin({ 'projects.tasks': [] });
    assert.equal(outcomeOf(await handleRouteQaOutcome(gone.admin, job('project.dev_task_qa_failed'))), 'gone');
    const wrong = qaAdmin({});
    const result = await handleRouteQaOutcome(wrong.admin, job('project.something_else'));
    assert.equal(result.status === 'failed' && result.permanent, true);
    assert.equal(outside.writes.length + gone.writes.length + wrong.writes.length, 0);
  });
});

describe('4. the stale-request and lease sweeps ride the cron tick', () => {
  test('the sweep calls expire_stale_build_requests with two hours and then expires leases; a failure is logged and swallowed', async () => {
    const calls: Call[] = [];
    const admin = {
      schema: () => ({
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args });
          return { data: fn === 'expire_stale_build_requests' ? [{ outcome: 'swept', expired: 2 }] : [{ expired: 1 }], error: null };
        },
      }),
    } as AnyAdmin;
    assert.equal(STALE_BUILD_REQUEST_AFTER, '2 hours');
    const swept = await sweepStaleOrchestratorRecords(admin);
    assert.deepEqual(calls.map((c) => c.fn), ['expire_stale_build_requests', 'expire_concurrency_leases']);
    assert.deepEqual(calls[0]!.args, { p_older_than: '2 hours' });
    assert.deepEqual(swept, { buildRequestsExpired: 2, leasesExpired: 1 });

    const broken = { schema: () => ({ rpc: async () => { throw new Error('down'); } }) } as AnyAdmin;
    const { result, logs } = await silenced(() => sweepStaleOrchestratorRecords(broken));
    assert.deepEqual(result, { buildRequestsExpired: null, leasesExpired: null });
    assert.equal(logs.length, 1);
  });

  test('the sweep is called from the tick, after the cron secret is checked and beside its sibling sweeps', () => {
    const route = readFileSync(new URL('../app/api/jobs/run/route.ts', import.meta.url), 'utf8');
    const auth = route.indexOf('authorizeCronRequest(request.headers.get');
    const sibling = route.indexOf('await expireHandoffs(admin);');
    const sweep = route.indexOf('await sweepStaleOrchestratorRecords(admin);');
    assert.ok(auth > 0 && sibling > auth && sweep > sibling, 'authorize, then the sibling sweep, then this one');
  });
});
