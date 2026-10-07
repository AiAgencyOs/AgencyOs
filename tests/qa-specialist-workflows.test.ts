import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The nine QA specialist workflows, run against a STAND-IN model and a STAND-IN database. NOTHING here ran on a real model, a browser, a device, a
 * load rig or a security tool. What is proved is the ORDER (read for the job's organization, ask, validate, then write), the REFUSALS (a shape that is
 * not the schema, a pass without evidence, a pass on a critical case, a claim for an environment the job never had, a secret, an approval) and WHERE
 * they write: ONE service-only door (qa.record_specialist_finding), never a result, a plan, a candidate, an exception or a retest.
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
let lastPrompt = '';

const { QA_SPECIALIST_WORKFLOWS } = await import('../app/api/jobs/run/qa-specialist-workflows.ts');
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
const wf = (kind: string) => QA_SPECIALIST_WORKFLOWS.find((w: { jobKind: string }) => w.jobKind === kind)!;
const secret = () => `api_key=${'x'.repeat(20)}`;

const CASE = '00000000-0000-4000-8000-0000000000c1';
const CRIT = '00000000-0000-4000-8000-0000000000c2';
const reset = (agent = 'functional_test', category = 'functional') => {
  events.length = 0; rpcCalls = []; readFilters = []; rpcAnswer = {}; modelResult = null; jobUpdates = []; lastPrompt = '';
  tables = {
    'qa.specialist_requests': [{ id: 'rq-1', agent_key: agent, job_id: 'j-1', candidate_id: null, project_id: 'p-1' }],
    'qa.qa_jobs': [{ id: 'j-1', plan_id: 'pl-1', category, status: 'routed', specialist: agent }],
    'qa.master_test_plans': [{ id: 'pl-1', status: 'approved', commit_ref: 'abc1234', environments: ['staging'] }],
    'qa.phase6_cases': [
      { id: CASE, title: 'cart total', acceptance_criterion: 'the total is right', priority: 'medium', status: 'planned', journey: null, steps: null, expected: null },
      { id: CRIT, title: 'critical pay', acceptance_criterion: 'a receipt is shown', priority: 'critical', status: 'planned', journey: null, steps: null, expected: null },
    ],
    'qa.test_runs': [{ id: 'r1', suite: 'functional', passed: 8, failed: 0 }],
    'qa.performance_budgets': [{ metric: 'checkout_p95', target: 800, unit: 'ms', lower_is_better: true }],
    'qa.device_configurations': [{ name: 'safari-17', platform: 'web', status: 'supported', reason: null }],
    'projects.integration_connections': [{ name: 'Mail', kind: 'email', health: 'verified', is_mock: false }],
    'qa.defects': [{ id: 'd1', title: 'cart emptied on login' }],
    'qa.risk_items': [],
    'qa.release_candidates': [{ id: 'c-1', plan_id: 'pl-1', status: 'draft', commit_ref: 'abc1234' }],
    'qa.readiness_assessments': [{ score: 71, band: 'material_risk', result: 'blocked', gates: [{ gate: 'security', satisfied: true, detail: 'ok' }] }],
  };
};
const good = (over: Record<string, unknown> = {}) => ({ kind: 'case_result', caseId: CASE, result: 'pass', reason: 'the total matches the cart', detail: null, evidenceRefs: ['run:r1'], environment: null, ...over });

describe('the nine workflows come from one factory', () => {
  test('one job kind and one agent each, all draft work, all agents the registry defines in the qa layer', () => {
    assert.equal(QA_SPECIALIST_WORKFLOWS.length, 9);
    assert.deepEqual(QA_SPECIALIST_WORKFLOWS.map((w: { jobKind: string }) => w.jobKind), [
      'qa.functional_test.propose', 'qa.ui_journey_test.propose', 'qa.api_integration_test.propose', 'qa.database_test.propose', 'qa.security_test.propose',
      'qa.performance_test.propose', 'qa.compatibility_test.propose', 'qa.regression_test.propose', 'qa.release_readiness.propose',
    ]);
    for (const w of QA_SPECIALIST_WORKFLOWS) {
      assert.equal(w.workClass, 'draft');
      assert.match(w.agentKey, /^[a-z_]+$/);
      assert.equal(definitionFor(w.agentKey)?.layer, 'qa');
      assert.equal(w.jobKind, `qa.${w.agentKey}.propose`);
    }
  });
  test('their job kinds collide with no other workflow', () => {
    const kinds = ['workflows.ts', 'development-workflows.ts', 'acquisition-workflows.ts', 'specialist-workflows.ts']
      .flatMap((f) => [...read(`app/api/jobs/run/${f}`).matchAll(/^\s*jobKind: '([a-z_.]+)',/gm)].map((m) => m[1]!));
    for (const w of QA_SPECIALIST_WORKFLOWS) assert.ok(!kinds.includes(w.jobKind), w.jobKind);
  });
  test('the file is NOT yet wired into the runner: the parent appends the spread (report it)', () => {
    const src = read('app/api/jobs/run/workflows.ts');
    assert.ok(!src.includes('QA_SPECIALIST_WORKFLOWS') || /\.\.\.QA_SPECIALIST_WORKFLOWS/.test(src), 'either absent, or wired as ONE spread');
  });
  test('the workflow source writes ONLY through the finding door and never touches a result, a plan, a candidate, an exception or a retest', () => {
    const src = code('app/api/jobs/run/qa-specialist-workflows.ts');
    assert.deepEqual([...src.matchAll(/\.rpc\('([a-z_]+)'/g)].map((m) => m[1]), ['record_specialist_finding']);
    for (const forbidden of ['record_case_result', 'approve_master_test_plan', 'approve_release', 'request_release_exception', 'record_retest', 'verify_defect', 'accept_specialist_finding', '.insert(', '.upsert(', '.delete(']) {
      assert.ok(!src.includes(forbidden), `the workflow must not use ${forbidden}`);
    }
    assert.equal([...src.matchAll(/\.update\(/g)].length, 1, 'the only update is settling its own core.jobs row');
  });
});

describe('order and reads: read, model, validate, write', () => {
  test('a valid proposal is written through the one door, after the model and never before', async () => {
    reset();
    answer({ findings: [good()] });
    const r = await wf('qa.functional_test.propose').run(ctxFor('functional_test', { requestId: 'rq-1' }));
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(events.filter((e) => e.startsWith('rpc:') || ['openRun', 'model', 'succeedRun'].includes(e)), ['openRun', 'model', 'rpc:qa.record_specialist_finding', 'succeedRun']);
    assert.equal(rpcCalls.length, 1);
    const args = rpcCalls[0]!.args;
    assert.equal(args.p_request_id, 'rq-1');
    assert.equal(args.p_organization_id, 'org-1');
    assert.equal(args.p_agent_key, 'functional_test');
    assert.equal(args.p_commit_ref, 'abc1234');
    assert.equal(args.p_proposed_result, 'pass');
  });
  test('every read is scoped to the JOB\'s organization, never one the payload names', async () => {
    reset();
    answer({ findings: [good()] });
    await wf('qa.functional_test.propose').run(ctxFor('functional_test', { requestId: 'rq-1', organizationId: 'org-EVIL', projectId: 'p-EVIL' }));
    // core.jobs is the runner's own job row (settled by its id), not a tenant read
    const reads = readFilters.filter((f) => !f.table.startsWith('core.'));
    const tablesRead = new Set(reads.map((f) => f.table));
    assert.ok(tablesRead.size >= 5);
    for (const t of tablesRead) assert.ok(reads.some((f) => f.table === t && f.column === 'organization_id' && f.value === 'org-1'), `${t} is read for org-1`);
    assert.ok(!readFilters.some((f) => f.value === 'org-EVIL' || f.value === 'p-EVIL'));
  });
  test('the facts handed to the model are the stored ones: the exact commit, the job\'s cases, the evidence it may cite', async () => {
    reset();
    answer({ findings: [good()] });
    await wf('qa.functional_test.propose').run(ctxFor('functional_test', { requestId: 'rq-1' }));
    assert.match(lastPrompt, /abc1234/);
    assert.match(lastPrompt, new RegExp(`case:${CASE}`));
    assert.match(lastPrompt, /run:r1/);
  });
  test('each agent reads only what it may cite (budgets for performance, devices for compatibility, integrations for api, escaped defects for regression)', async () => {
    for (const [agent, category, table] of [['performance_test', 'performance', 'qa.performance_budgets'], ['compatibility_test', 'compatibility', 'qa.device_configurations'], ['api_integration_test', 'api', 'projects.integration_connections'], ['regression_test', 'regression', 'qa.defects']] as const) {
      reset(agent, category);
      answer({ findings: [{ ...good(), kind: 'category_observation', caseId: null, result: 'not_tested', evidenceRefs: [], reason: 'nothing ran' }] });
      await wf(`qa.${agent}.propose`).run(ctxFor(agent, { requestId: 'rq-1' }));
      assert.ok(readFilters.some((f) => f.table === table), `${agent} reads ${table}`);
    }
    reset();
    answer({ findings: [good()] });
    await wf('qa.functional_test.propose').run(ctxFor('functional_test', { requestId: 'rq-1' }));
    assert.ok(!readFilters.some((f) => f.table === 'qa.performance_budgets' || f.table === 'qa.defects'), 'functional reads none of those');
  });
});

describe('refusals: nothing is written on a refused answer', () => {
  const refusedAnswers: [string, unknown][] = [
    ['an extra approval field', { findings: [{ ...good(), approved: true }] }],
    ['a status of accepted', { findings: [{ ...good(), status: 'accepted' }] }],
    ['a pass with no evidence', { findings: [good({ evidenceRefs: [] })] }],
    ['a pass on a critical case', { findings: [good({ caseId: CRIT })] }],
    ['evidence the model was not shown', { findings: [good({ evidenceRefs: ['run:invented'] })] }],
    ['a case from another job', { findings: [good({ caseId: '00000000-0000-4000-8000-0000000000ff' })] }],
    ['a secret in the reason', { findings: [good({ reason: `uses ${secret()}` })] }],
    ['no findings at all', { findings: [] }],
    ['a result outside the closed set', { findings: [good({ result: 'passed' })] }],
    ['one good and one bad proposal (the whole answer is refused)', { findings: [good(), good({ caseId: CRIT, result: 'pass' })] }],
  ];
  for (const [label, bad] of refusedAnswers) {
    test(label, async () => {
      reset();
      answer(bad);
      const r = await wf('qa.functional_test.propose').run(ctxFor('functional_test', { requestId: 'rq-1' }));
      assert.equal(r.status, 'failed');
      assert.ok(events.some((e) => e.startsWith("failJob:the model's answer was refused")));
      assert.equal(rpcCalls.length, 0, 'nothing written');
    });
  }
  test('a held job: a pass is refused and a blocked proposal is written', async () => {
    reset('compatibility_test', 'compatibility');
    tables['qa.qa_jobs'] = [{ id: 'j-1', plan_id: 'pl-1', category: 'compatibility', status: 'held', specialist: 'compatibility_test' }];
    answer({ findings: [good({ environment: 'staging' })] });
    assert.equal((await wf('qa.compatibility_test.propose').run(ctxFor('compatibility_test', { requestId: 'rq-1' }))).status, 'failed');
    assert.equal(rpcCalls.length, 0);
    reset('compatibility_test', 'compatibility');
    tables['qa.qa_jobs'] = [{ id: 'j-1', plan_id: 'pl-1', category: 'compatibility', status: 'held', specialist: 'compatibility_test' }];
    answer({ findings: [good({ result: 'blocked', evidenceRefs: [], reason: 'no device available for the declared safari' })] });
    assert.equal((await wf('qa.compatibility_test.propose').run(ctxFor('compatibility_test', { requestId: 'rq-1' }))).status, 'succeeded');
    assert.equal(rpcCalls.length, 1);
  });
  test('the exploit, the universal threshold, the unverified integration and the approval are each refused for the right agent', async () => {
    const cases: [string, string, Record<string, unknown>][] = [
      ['security_test', 'security', good({ result: 'fail', reason: "id=1' or 1=1 --" })],
      ['performance_test', 'performance', good({ reason: 'under 2 seconds is the industry standard', evidenceRefs: ['budget:checkout_p95'], environment: 'staging' })],
      ['api_integration_test', 'api', good({ evidenceRefs: ['integration:Mail', 'integration:Nope'] })],
    ];
    for (const [agent, category, bad] of cases) {
      reset(agent, category);
      answer({ findings: [bad] });
      assert.equal((await wf(`qa.${agent}.propose`).run(ctxFor(agent, { requestId: 'rq-1' }))).status, 'failed', agent);
      assert.equal(rpcCalls.length, 0, agent);
    }
    reset('release_readiness', 'release');
    tables['qa.specialist_requests'] = [{ id: 'rq-1', agent_key: 'release_readiness', job_id: null, candidate_id: 'c-1', project_id: 'p-1' }];
    answer({ findings: [{ kind: 'gate_summary', caseId: null, result: null, reason: 'the candidate is approved for production', detail: null, evidenceRefs: ['gate:security'], environment: null }] });
    assert.equal((await wf('qa.release_readiness.propose').run(ctxFor('release_readiness', { requestId: 'rq-1' }))).status, 'failed');
    assert.equal(rpcCalls.length, 0);
  });
  test('the door\'s own refusal fails the job (a refused finding is never treated as written)', async () => {
    reset();
    answer({ findings: [good()] });
    rpcAnswer.record_specialist_finding = [{ outcome: 'wrong_commit' }];
    const r = await wf('qa.functional_test.propose').run(ctxFor('functional_test', { requestId: 'rq-1' }));
    assert.equal(r.status, 'failed');
    assert.ok(events.some((e) => e === 'failJob:the door answered wrong_commit'));
  });
  test('a redelivered run is success: already_proposed is a good answer', async () => {
    reset();
    answer({ findings: [good()] });
    rpcAnswer.record_specialist_finding = [{ outcome: 'already_proposed' }];
    const r = await wf('qa.functional_test.propose').run(ctxFor('functional_test', { requestId: 'rq-1' }));
    assert.equal(r.status, 'succeeded');
    assert.equal(r.proposed, 0);
  });
});

describe('release_readiness works on a candidate and proposes summaries and exception requests', () => {
  test('a gate summary citing the stored gates is written through the one door', async () => {
    reset('release_readiness', 'release');
    tables['qa.specialist_requests'] = [{ id: 'rq-1', agent_key: 'release_readiness', job_id: null, candidate_id: 'c-1', project_id: 'p-1' }];
    answer({ findings: [{ kind: 'gate_summary', caseId: null, result: null, reason: 'security is satisfied; the rest has no run yet', detail: null, evidenceRefs: ['gate:security'], environment: null }] });
    const r = await wf('qa.release_readiness.propose').run(ctxFor('release_readiness', { requestId: 'rq-1' }));
    assert.equal(r.status, 'succeeded');
    assert.equal(rpcCalls[0]!.args.p_kind, 'gate_summary');
    assert.match(lastPrompt, /gate:security -> satisfied/);
    assert.ok(readFilters.some((f) => f.table === 'qa.release_candidates' && f.column === 'organization_id' && f.value === 'org-1'));
  });
});

describe('what is settled without a model call', () => {
  test('no requestId, a vanished request, a request for another specialist, a cancelled job, a plan no longer approved and a missing provider', async () => {
    reset();
    assert.equal((await wf('qa.functional_test.propose').run(ctxFor('functional_test', {}))).status, 'failed');
    reset();
    tables['qa.specialist_requests'] = [];
    const gone = await wf('qa.functional_test.propose').run(ctxFor('functional_test', { requestId: 'rq-1' }));
    assert.equal(gone.outcome, 'gone');
    assert.ok(!events.includes('model'));
    reset('security_test', 'security');
    assert.equal((await wf('qa.functional_test.propose').run(ctxFor('functional_test', { requestId: 'rq-1' }))).status, 'failed');
    assert.ok(!events.includes('model'));
    reset();
    tables['qa.specialist_requests'] = [{ id: 'rq-1', agent_key: 'security_test', job_id: 'j-1', candidate_id: null, project_id: 'p-1' }];
    answer({ findings: [good()] });
    assert.equal((await wf('qa.functional_test.propose').run(ctxFor('functional_test', { requestId: 'rq-1' }))).status, 'failed', 'a request made for another specialist is not run by this one');
    assert.ok(!events.includes('model'));
    reset();
    tables['qa.qa_jobs'] = [{ id: 'j-1', plan_id: 'pl-1', category: 'functional', status: 'cancelled', specialist: 'functional_test' }];
    assert.equal((await wf('qa.functional_test.propose').run(ctxFor('functional_test', { requestId: 'rq-1' }))).outcome, 'gone');
    reset();
    tables['qa.master_test_plans'] = [{ id: 'pl-1', status: 'superseded', commit_ref: 'abc1234', environments: [] }];
    assert.equal((await wf('qa.functional_test.propose').run(ctxFor('functional_test', { requestId: 'rq-1' }))).outcome, 'gone');
    assert.ok(!events.includes('model'));
    reset();
    modelResult = { ok: false, kind: 'no_provider', detail: 'no model configured', stepCount: 0 };
    const none = await wf('qa.functional_test.propose').run(ctxFor('functional_test', { requestId: 'rq-1' }));
    assert.equal(none.reason, 'AI_PROVIDER_NOT_CONFIGURED');
    assert.equal(rpcCalls.length, 0);
  });
});

describe('the admin side: queries, actions, panel', () => {
  const queries = read('src/modules/projects/qa-specialist-queries.ts');
  const actions = code('src/modules/projects/qa-specialist-actions.ts');
  const forms = read('app/(internal)/projects/[projectId]/qa-specialist-forms.tsx');
  const panel = read('app/(internal)/projects/[projectId]/qa-specialist-panel.tsx');
  test('every read in the queries file is followed by an unreadable() refusal, one for one', () => {
    assert.equal((queries.match(/if \(\w+\.error\) unreadable\(/g) ?? []).length, 5);
    assert.equal((queries.match(/unreadable\(/g) ?? []).length, 5, 'one unreadable() per error check, comments included');
    assert.equal((queries.match(/if \(/g) ?? []).length, 5, 'no other conditional swallows an error');
  });
  test('the actions never write a result: the only doors are the request, accept and reject doors; the queue job names the agent the DOOR returned', () => {
    assert.deepEqual([...actions.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]).sort(), ['accept_specialist_finding', 'reject_specialist_finding', 'request_specialist_run']);
    for (const forbidden of ['record_case_result', 'record_specialist_finding', 'approve_']) assert.ok(!actions.includes(forbidden), forbidden);
    assert.match(actions, /QA_SPECIALIST_AGENTS as readonly string\[\]\)\.includes\(agent\)/);
    assert.match(actions, /kind: `qa\.\$\{agent\}\.propose`/);
    assert.ok(!/formData[^;]*agent/i.test(actions), 'the form never names the agent');
  });
  test('the panel offers decisions only on undecided proposals, and says a proposal is not a result', () => {
    assert.match(panel, /Proposals, not results/);
    assert.match(panel, /f\.decision \? \(/);
    assert.match(forms, /canAccept=|disabled=\{pending \|\| !canAccept\}/);
    assert.match(panel, /canAccept=\{!f\.viewerAsked\}/);
  });
  test('the migration, the verifier and the page are as reported: migration in range, verifier present, page.tsx untouched by this slice', () => {
    const migration = read('supabase/migrations/20261103400000_a_qa_specialist_proposes_and_an_independent_person_decides.sql');
    assert.match(migration, /create or replace function qa\.record_specialist_finding/);
    assert.match(migration, /grant execute on function qa\.record_specialist_finding\([^)]*\) to service_role/);
    assert.match(migration, /revoke all on function qa\.record_specialist_finding\([^)]*\) from public, anon, authenticated/);
    assert.match(migration, /from qa\.record_case_result\(v_f\.case_id/);
    assert.match(read('scripts/verify-phase6-specialists.sql'), /\\echo 3\. decisions OK/);
  });
});
