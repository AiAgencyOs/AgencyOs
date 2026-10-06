import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The nine development specialist workflows, run against a STAND-IN model and a STAND-IN database. Nothing here ran on a real model, and none of these
 * agents has repository access: what is proved is the ORDER (read for the job's organization, ask, validate, then write), the REFUSALS (a task not routed
 * to the agent, a plan outside the task's paths, a forbidden action, missing evidence, an answer outside the schema) and WHERE they write (one
 * service-only door, never code, a test result or an approval).
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const events: string[] = [];
let modelResult: unknown = null;
let rpcAnswer: Record<string, unknown> = {};
let rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let readFilters: { table: string; column: string; value: unknown }[] = [];
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

const { DEVELOPMENT_SPECIALIST_WORKFLOWS } = await import('../app/api/jobs/run/development-specialist-workflows.ts');
const { definitionFor } = await import('../src/modules/agents/registry.ts');
const { buildExecutionEnvelope } = await import('../src/modules/orchestrator/development-route.ts');
const proposals = await import('../src/modules/projects/specialist-proposals.ts');

function makeAdmin() {
  return {
    schema: (s: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        events.push(`rpc:${s}.${fn}`);
        rpcCalls.push({ fn, args });
        return { data: rpcAnswer[fn] ?? [{ outcome: 'recorded' }], error: null };
      },
      from: (table: string) => {
        const rows = tables[`${s}.${table}`] ?? [];
        events.push(`read:${s}.${table}`);
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'in', 'is', 'order', 'limit', 'update']) chain[m] = () => chain;
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
const wf = (agent: string) => DEVELOPMENT_SPECIALIST_WORKFLOWS.find((w: { agentKey: string }) => w.agentKey === agent)!;
const secret = () => `api_key=${'x'.repeat(20)}`;
const DEFECT = '11111111-1111-4111-8111-111111111111';

const PATHS: Record<string, string[]> = {
  frontend_developer: ['src/ui'], backend_developer: ['src/api'], database_developer: ['supabase/migrations'], mobile_developer: ['mobile/lib'], integration: ['src/integrations'],
  devops_build: ['scripts/build'], security_review: ['src/auth'], bug_fix: ['src/cart'], refactor_performance: ['src/perf'],
};
const FILE: Record<string, string> = {
  frontend_developer: 'src/ui/button.tsx', backend_developer: 'src/api/pay.ts', database_developer: 'supabase/migrations/20261103800000_cart.sql', mobile_developer: 'mobile/lib/main.dart',
  integration: 'src/integrations/maps.ts', devops_build: 'scripts/build/run.sh', security_review: 'src/auth/session.ts', bug_fix: 'src/cart/total.ts', refactor_performance: 'src/perf/index.ts',
};

/** Seed the stand-in database for one agent: a task assigned to it, its routed handoff carrying a real execution envelope. */
function reset(agent = 'frontend_developer') {
  events.length = 0; rpcCalls = []; readFilters = []; rpcAnswer = {}; modelResult = null;
  const envelope = buildExecutionEnvelope({
    task: { id: 't-1', title: 'Pay by card', acceptanceCriteria: 'A declined card shows why' },
    planId: 'plan-1', organizationId: 'org-1', projectId: 'p-1', baselineId: 'base-1', destination: agent, routingReason: 'the plan assigned it',
    riskLevel: 'medium', affectedPaths: PATHS[agent],
  });
  tables = {
    'projects.tasks': [{ id: 't-1', project_id: 'p-1', title: 'Pay by card', description: 'Card payments', acceptance_criteria: 'A declined card shows why', status: 'todo', required_capability: agent, risk_level: 'medium', affected_paths: PATHS[agent] }],
    'ai.handoffs': [{ id: 'h-1', to_agent: agent, context: { envelope: JSON.parse(JSON.stringify(envelope)) } }],
    'projects.phase_five_agent_state': [],
    'qa.defects': [{ id: DEFECT, title: 'cart total wrong' }],
  };
}
const goodFor = (agent: string): Record<string, unknown> => {
  const base = {
    outcome: 'proposal', summary: 'Plan the change in small, reviewable steps.', plannedFiles: [FILE[agent]], plannedTests: ['tests/one.test.ts'], risks: ['a regression nearby'],
    evidencePlan: [...(definitionFor(agent)?.verification.requiredEvidence ?? [])],
  };
  if (agent === 'database_developer') return { ...base, migrations: [FILE[agent]] };
  if (agent === 'bug_fix') return { ...base, defectId: DEFECT, rootCause: 'rounding before summing' };
  if (agent === 'security_review') return { ...base, plannedFiles: [], findings: [{ severity: 'high', path: 'src/auth/session.ts', description: 'cookie is not httpOnly' }] };
  if (agent === 'refactor_performance') return { ...base, measurement: { metric: 'p95 ms', baseline: '420', target: '300' } };
  if (agent === 'mobile_developer') return { ...base, target: 'Flutter' };
  return base;
};
const run = (agent: string, payload: Record<string, unknown> = { taskId: 't-1' }) => wf(agent).run(ctxFor(agent, payload));
const nothingWritten = () => assert.equal(rpcCalls.length, 0);

describe('registration', () => {
  test('nine workflows, one per specialist, all draft work, each for a registry development agent', () => {
    assert.equal(DEVELOPMENT_SPECIALIST_WORKFLOWS.length, 9);
    assert.deepEqual(DEVELOPMENT_SPECIALIST_WORKFLOWS.map((w: { agentKey: string }) => w.agentKey), [...proposals.DEVELOPMENT_SPECIALIST_KEYS]);
    for (const w of DEVELOPMENT_SPECIALIST_WORKFLOWS) {
      assert.equal(w.workClass, 'draft');
      assert.equal(w.jobKind, `development.${w.agentKey}.propose`);
      assert.equal(definitionFor(w.agentKey)?.layer, 'development');
      assert.match(w.agentKey, /^[a-z_]+$/);
      assert.match(w.systemPrompt, /only PROPOSE/);
    }
  });
  test('their job kinds collide with no other workflow', () => {
    const others = readdirSync(fileURLToPath(new URL('../app/api/jobs/run/', import.meta.url))).filter((f) => f.endsWith('workflows.ts') && f !== 'development-specialist-workflows.ts');
    const taken = new Set(others.flatMap((f) => [...read(`app/api/jobs/run/${f}`).matchAll(/^\s*jobKind: '([a-z_.]+)',/gm)].map((m) => m[1])));
    for (const w of DEVELOPMENT_SPECIALIST_WORKFLOWS) assert.ok(!taken.has(w.jobKind), w.jobKind);
    assert.equal(new Set(DEVELOPMENT_SPECIALIST_WORKFLOWS.map((w: { jobKind: string }) => w.jobKind)).size, 9);
  });
  test('all nine come from one factory, not nine copies', () => {
    const src = read('app/api/jobs/run/development-specialist-workflows.ts');
    assert.equal([...src.matchAll(/async run\(ctx\)/g)].length, 1);
    assert.equal([...src.matchAll(/jobKind:/g)].length, 1);
  });
});

for (const agent of proposals.DEVELOPMENT_SPECIALIST_KEYS) {
  describe(`${agent}: read, model, validate, write`, () => {
    test('a valid proposal is written through the one door, after the model and never before', async () => {
      reset(agent);
      answer(goodFor(agent));
      const r = await run(agent);
      assert.equal(r.status, 'succeeded', JSON.stringify(r));
      assert.deepEqual(events.filter((e) => !e.startsWith('read:')), ['openRun', 'model', 'rpc:projects.record_specialist_proposal', 'succeedRun']);
      assert.ok(events.findIndex((e) => e.startsWith('read:')) < events.indexOf('openRun'), 'every read happens before the run opens');
      assert.equal(rpcCalls.length, 1);
      assert.deepEqual(Object.keys(rpcCalls[0]!.args).sort(), [
        'p_agent_key', 'p_detail', 'p_evidence_plan', 'p_handoff_id', 'p_organization_id', 'p_outcome', 'p_planned_files', 'p_planned_tests', 'p_risks', 'p_run_id', 'p_summary', 'p_task_id',
      ]);
      assert.equal(rpcCalls[0]!.args.p_agent_key, agent);
      assert.equal(rpcCalls[0]!.args.p_organization_id, 'org-1');
      assert.equal(rpcCalls[0]!.args.p_handoff_id, 'h-1');
    });
  });
}

describe('what it reads, and for whom', () => {
  test('every read is for the JOB\'s organization, never one the payload names', async () => {
    reset('backend_developer');
    answer(goodFor('backend_developer'));
    await run('backend_developer', { taskId: 't-1', organizationId: 'org-EVIL' });
    const tablesRead = new Set(readFilters.map((f) => f.table));
    for (const t of ['projects.tasks', 'ai.handoffs', 'projects.phase_five_agent_state']) {
      assert.ok(tablesRead.has(t), `${t} is read`);
      assert.ok(readFilters.some((f) => f.table === t && f.column === 'organization_id' && f.value === 'org-1'), `${t} is read for org-1`);
    }
    assert.ok(!readFilters.some((f) => f.value === 'org-EVIL'));
  });
  test('a bug fix is shown only the defects linked to its task, for the job\'s organization', async () => {
    reset('bug_fix');
    answer(goodFor('bug_fix'));
    await run('bug_fix');
    assert.ok(readFilters.some((f) => f.table === 'qa.defects' && f.column === 'task_id' && f.value === 't-1'));
    assert.ok(readFilters.some((f) => f.table === 'qa.defects' && f.column === 'organization_id' && f.value === 'org-1'));
  });
  test('the handoff is read for this task and this agent', async () => {
    reset('integration');
    answer(goodFor('integration'));
    await run('integration');
    assert.ok(readFilters.some((f) => f.table === 'ai.handoffs' && f.column === 'subject_id' && f.value === 't-1'));
    assert.ok(readFilters.some((f) => f.table === 'ai.handoffs' && f.column === 'to_agent' && f.value === 'integration'));
    assert.ok(readFilters.some((f) => f.table === 'ai.handoffs' && f.column === 'subject_type' && f.value === 'development_task'));
  });
});

describe('a task that cannot be worked on is not given to the model', () => {
  const noModel = () => { assert.ok(!events.includes('model')); assert.ok(!events.includes('openRun')); nothingWritten(); };
  test('no payload', async () => {
    reset();
    assert.equal((await run('frontend_developer', {})).status, 'failed');
    noModel();
  });
  test('a task of another organization (not found for this one) is settled', async () => {
    reset();
    tables['projects.tasks'] = [];
    const r = await run('frontend_developer');
    assert.equal(r.status, 'succeeded');
    assert.equal(r.outcome, 'gone');
    noModel();
  });
  test('a cancelled task', async () => {
    reset();
    tables['projects.tasks'] = [{ id: 't-1', project_id: 'p-1', status: 'cancelled', required_capability: 'frontend_developer', affected_paths: [] }];
    assert.equal((await run('frontend_developer')).outcome, 'gone');
    noModel();
  });
  test('a task assigned to a different specialist', async () => {
    reset();
    assert.equal((await run('backend_developer')).status, 'failed');
    assert.ok(events.some((e) => e.startsWith('failJob:the task is assigned to frontend_developer, not backend_developer')));
    noModel();
  });
  test('a task that was never routed (no handoff: held, refused or not yet routed)', async () => {
    reset();
    tables['ai.handoffs'] = [];
    const r = await run('frontend_developer');
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'not routed');
    noModel();
  });
  test('a handoff with no envelope, or an envelope for another task or agent, or one carrying a secret', async () => {
    reset();
    tables['ai.handoffs'] = [{ id: 'h-1', to_agent: 'frontend_developer', context: {} }];
    assert.equal((await run('frontend_developer')).reason, 'bad envelope');
    noModel();
    reset();
    const row = tables['ai.handoffs']![0] as { context: { envelope: Record<string, unknown> } };
    row.context.envelope.taskId = 't-other';
    assert.equal((await run('frontend_developer')).reason, 'bad envelope');
    noModel();
    reset();
    const row2 = tables['ai.handoffs']![0] as { context: { envelope: Record<string, unknown> } };
    row2.context.envelope.intent = `uses ${'sk-' + 'a'.repeat(24)}`;
    assert.equal((await run('frontend_developer')).reason, 'bad envelope');
    noModel();
  });
  test('a missing provider is settled honestly', async () => {
    reset();
    modelResult = { ok: false, kind: 'no_provider', detail: 'no model configured', stepCount: 0 };
    const r = await run('frontend_developer');
    assert.equal(r.reason, 'AI_PROVIDER_NOT_CONFIGURED');
    nothingWritten();
  });
});

describe('a model answer that tries to do more than propose leaves nothing but a refused run', () => {
  async function refused(agent: string, answerJson: unknown, expect: RegExp) {
    reset(agent);
    answer(answerJson);
    const r = await run(agent);
    assert.equal(r.status, 'failed', JSON.stringify(r));
    assert.ok(events.some((e) => e.startsWith("failJob:the model's answer was refused")), events.join(' | '));
    assert.ok(events.some((e) => e === 'finishRun:failed'));
    assert.match(String(r.reason), expect);
    nothingWritten();
    assert.ok(!events.includes('succeedRun'));
  }
  test('widening scope to files outside the task\'s affected paths', async () => {
    await refused('frontend_developer', { ...goodFor('frontend_developer'), plannedFiles: ['src/ui/button.tsx', 'src/api/pay.ts'] }, /outside the task's affected paths/);
  });
  test('walking out of the affected path with a parent segment', async () => {
    await refused('frontend_developer', { ...goodFor('frontend_developer'), plannedFiles: ['src/ui/../api/pay.ts'] }, /outside the task's affected paths/);
  });
  test('planning a production deploy', async () => {
    await refused('devops_build', { ...goodFor('devops_build'), summary: 'Build the artifact, then deploy to production.' }, /forbidden action \(deploy\)/);
  });
  test('planning a merge to a protected branch, approving its own work, changing scope, verifying a payment', async () => {
    await refused('backend_developer', { ...goodFor('backend_developer'), plannedTests: ['then merge the branch into main'] }, /\(merge\)/);
    await refused('backend_developer', { ...goodFor('backend_developer'), risks: ['it approves its own work'] }, /\(self_approval\)/);
    await refused('backend_developer', { ...goodFor('backend_developer'), summary: 'Also extend the scope to refunds screens.' }, /\(scope\)/);
    await refused('backend_developer', { ...goodFor('backend_developer'), summary: 'Verify the payment as received.' }, /\(payment\)/);
  });
  test('a secret value, a .env file, a migration planned by a non-database agent', async () => {
    await refused('backend_developer', { ...goodFor('backend_developer'), risks: [`uses ${secret()}`] }, /\(secret\)/);
    await refused('frontend_developer', { ...goodFor('frontend_developer'), plannedFiles: ['src/ui/.env.local'] }, /touches secrets/);
    reset('backend_developer');
    (tables['projects.tasks']![0] as Record<string, unknown>).affected_paths = ['src/api', 'supabase/migrations'];
    answer({ ...goodFor('backend_developer'), plannedFiles: ['supabase/migrations/20261103999999_x.sql'] });
    assert.equal((await run('backend_developer')).status, 'failed');
    nothingWritten();
  });
  test('leaving out required evidence', async () => {
    await refused('frontend_developer', { ...goodFor('frontend_developer'), evidencePlan: ['typecheck', 'lint', 'tests'] }, /required evidence: build/);
  });
  test('fields outside the schema: a status, an approval, a test result, a repository write', async () => {
    for (const extra of [{ status: 'approved' }, { approved: true }, { testResult: 'passed' }, { commit: 'abc1234' }, { diff: '--- a/x' }]) {
      await refused('frontend_developer', { ...goodFor('frontend_developer'), ...extra }, /./);
    }
  });
  test('a bug fix that cites no defect, or a defect not linked to its task', async () => {
    await refused('bug_fix', { ...goodFor('bug_fix'), defectId: null }, /linked to this task/);
    await refused('bug_fix', { ...goodFor('bug_fix'), defectId: '22222222-2222-4222-8222-222222222222' }, /linked to this task/);
  });
  test('a security review that plans an edit, or proposes no findings', async () => {
    await refused('security_review', { ...goodFor('security_review'), plannedFiles: ['src/auth/session.ts'] }, /never edits/);
    await refused('security_review', { ...goodFor('security_review'), findings: [] }, /at least one finding/);
    await refused('security_review', { ...goodFor('security_review'), findings: [{ severity: 'catastrophic', path: 'a', description: 'b' }] }, /./);
  });
  test('a plan for real mobile work on a project that records mobile NOT_REQUIRED', async () => {
    reset('mobile_developer');
    tables['projects.phase_five_agent_state'] = [{ state: 'not_required' }];
    answer(goodFor('mobile_developer'));
    const r = await run('mobile_developer');
    assert.equal(r.status, 'failed');
    assert.match(String(r.reason), /NOT_REQUIRED/);
    nothingWritten();
  });
  test('an agent that is not allowed to say NOT_REQUIRED says it', async () => {
    await refused('frontend_developer', { outcome: 'not_required', summary: 'Nothing to do.', plannedFiles: [], plannedTests: [], risks: [], evidencePlan: [] }, /cannot decide its own task is not required/);
  });
});

describe('the honest NOT_REQUIRED and the other outcomes', () => {
  test('mobile records NOT_REQUIRED honestly when the project has no mobile target', async () => {
    reset('mobile_developer');
    tables['projects.phase_five_agent_state'] = [{ state: 'not_required' }];
    answer({ outcome: 'not_required', summary: 'The project is web only.', plannedFiles: [], plannedTests: [], risks: [], evidencePlan: [] });
    const r = await run('mobile_developer');
    assert.equal(r.status, 'succeeded');
    assert.equal(r.proposalOutcome, 'not_required');
    assert.equal(rpcCalls[0]!.args.p_outcome, 'not_required');
    assert.deepEqual(rpcCalls[0]!.args.p_planned_files, []);
  });
  test('"already_proposed" from the door is success; any other refusal fails the job', async () => {
    reset();
    answer(goodFor('frontend_developer'));
    rpcAnswer.record_specialist_proposal = [{ outcome: 'already_proposed' }];
    assert.equal((await run('frontend_developer')).status, 'succeeded');
    for (const refusal of ['outside_affected_paths', 'forbidden_action', 'not_routed', 'wrong_agent', 'missing_evidence']) {
      reset();
      answer(goodFor('frontend_developer'));
      rpcAnswer.record_specialist_proposal = [{ outcome: refusal }];
      const r = await run('frontend_developer');
      assert.equal(r.status, 'failed', refusal);
      assert.ok(events.includes('finishRun:failed') && !events.includes('succeedRun'));
    }
  });
});

describe('where the workflows can write', () => {
  const src = read('app/api/jobs/run/development-specialist-workflows.ts');
  test('one service-only door, by name, and nothing else', () => {
    assert.deepEqual([...new Set([...src.matchAll(/\.rpc\('([a-z_]+)'/g)].map((m) => m[1]))], ['record_specialist_proposal']);
    assert.equal([...src.matchAll(/\.rpc\(/g)].length, 1);
  });
  test('it never writes a row, a test result, a run, a document, a repository or an approval', () => {
    assert.doesNotMatch(src, /\.insert\(|\.upsert\(|\.delete\(/);
    assert.doesNotMatch(src, /ingest_test_report|test_runs|record_documentation_draft|record_test_case_draft|writeFile|execSync|child_process|spawn\(|\.rpc\('[a-z_]*(approv|verif)/i);
  });
  test('it validates strictly BEFORE it writes', () => {
    assert.ok(src.indexOf('proposalSchema.safeParse') < src.indexOf("rpc('record_specialist_proposal'"));
    assert.ok(src.indexOf('validateProposal(') < src.indexOf("rpc('record_specialist_proposal'"));
    assert.ok(src.indexOf('validateExecutionEnvelope(') < src.indexOf('callModel('));
    assert.match(src, /the model's answer was refused/);
  });
  test('the door is service-role only, writes only proposals, and never touches evidence', () => {
    const sql = read('supabase/migrations/20261103300000_a_specialist_proposes_in_a_record_and_the_database_refuses_what_it_may_not_plan.sql');
    assert.match(sql, /revoke all on function projects\.record_specialist_proposal[^;]*from public, anon, authenticated/);
    assert.match(sql, /grant execute on function projects\.record_specialist_proposal[^;]*to service_role/);
    assert.match(sql, /status\s+text not null default 'proposed' check \(status in \('proposed'\)\)/);
    assert.doesNotMatch(sql, /insert into qa\.|insert into approvals\.|update projects\.tasks/);
  });
  test('the runner claims them only through the parent\'s one spread (reported, not edited here)', () => {
    const wfSrc = read('app/api/jobs/run/workflows.ts');
    assert.doesNotMatch(wfSrc, /DEVELOPMENT_SPECIALIST_WORKFLOWS/, 'the parent appends the spread; this slice does not edit workflows.ts');
  });
});

describe('the Admin action and the panel', () => {
  const actions = read('src/modules/projects/specialist-actions.ts');
  const queries = read('src/modules/projects/specialist-queries.ts');
  const panel = read('app/(internal)/projects/[projectId]/specialist-panel.tsx');
  test('asking reads the task through the caller\'s own session, requires a routed handoff, and the agent is the task\'s, never the caller\'s', () => {
    assert.match(actions, /createClient\(\)/);
    assert.match(actions, /required_capability/);
    assert.match(actions, /from\('handoffs'\)/);
    assert.match(actions, /developmentSpecialistJobKind\(agent\)/);
    assert.doesNotMatch(actions, /formData\.get\('(agent|kind|organizationId)'\)|text\(formData, '(agent|kind|organizationId)'\)/);
    assert.match(actions, /organization_id: context\.organizationId/);
  });
  test('it enqueues a job and writes nothing else', () => {
    assert.equal([...actions.matchAll(/\.insert\(/g)].length, 1);
    assert.match(actions, /schema\('core'\)\.from\('jobs'\)\.insert/);
    assert.doesNotMatch(actions, /specialist_proposals|\.rpc\(|\.update\(|\.delete\(/);
  });
  test('the job kind it queues is the one the workflow claims', () => {
    for (const k of proposals.DEVELOPMENT_SPECIALIST_KEYS) assert.ok(DEVELOPMENT_SPECIALIST_WORKFLOWS.some((w: { jobKind: string }) => w.jobKind === proposals.developmentSpecialistJobKind(k)), k);
  });
  test('the queries guard every read (G-054) and the panel is read-only apart from asking', () => {
    assert.equal([...queries.matchAll(/\.error\) unreadable\(/g)].length, 5);
    assert.equal([...queries.matchAll(/\.schema\(/g)].length, 5);
    assert.doesNotMatch(queries, /\.insert\(|\.update\(|\.delete\(|\.rpc\(|\.upsert\(/);
    assert.match(panel, /Passes the validator/);
    assert.match(panel, /no code, no test result, no approval/);
    assert.doesNotMatch(panel, /<(input|button|form)\b/);
  });
});
