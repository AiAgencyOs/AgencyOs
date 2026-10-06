import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The Documentation and Test Automation agents' workflows, run against a STAND-IN model and a STAND-IN database. Nothing here ran on a real model:
 * what is proved is the ORDER (read for the job's organization, ask, validate, then write), the REFUSALS (an answer that is not strictly the
 * schema, a claim without its evidence, a connection said to work that does not, a secret) and WHERE they write (one service-only door each, never a
 * report, a run or an 'implemented' document).
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

const { SPECIALIST_WORKFLOWS } = await import('../app/api/jobs/run/specialist-workflows.ts');
const { definitionFor } = await import('../src/modules/agents/registry.ts');
const drafts = await import('../src/modules/projects/specialist-drafts.ts');

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
const wf = (kind: string) => SPECIALIST_WORKFLOWS.find((w: { jobKind: string }) => w.jobKind === kind)!;
const reset = () => {
  events.length = 0; rpcCalls = []; readFilters = []; rpcAnswer = {}; modelResult = null;
  tables = {
    'projects.projects': [{ id: 'p-1', name: 'Shop' }],
    'projects.integration_connections': [
      { name: 'WhatsApp', kind: 'whatsapp', health: 'verified', is_mock: false },
      { name: 'Maps', kind: 'maps', health: 'configured', is_mock: false },
    ],
    'projects.technical_documents': [{ kind: 'api', title: 'Checkout API', status: 'implemented' }],
    'qa.test_runs': [{ suite: 'functional', passed: 8, failed: 1 }, { suite: 'functional', passed: 1, failed: 5 }],
    'qa.defects': [{ id: 'd-1' }],
    'projects.deliverables': [{ id: 'b-1', version: 2 }],
    'projects.deliverable_details': [{ commit_ref: 'abc1234' }],
    'projects.tasks': [{ id: 't-1', project_id: 'p-1', title: 'Pay by card', description: 'Card payments', acceptance_criteria: 'A declined card shows why', status: 'todo' }],
    'projects.test_case_drafts': [],
  };
};
const secret = () => `api_key=${'x'.repeat(20)}`;

const goodDoc = {
  title: 'Integrations overview',
  kind: 'architecture',
  sections: [{ heading: 'Messaging', claims: [{ statement: 'WhatsApp is verified by an adapter check.', evidenceRef: 'integration:WhatsApp' }] }],
};

describe('the two workflows are registered for specialists the registry defines', () => {
  test('one job kind and one agent each, both draft work', () => {
    assert.deepEqual(SPECIALIST_WORKFLOWS.map((w: { jobKind: string; agentKey: string }) => [w.jobKind, w.agentKey]), [
      ['documentation.draft', 'documentation'], ['test_automation.propose_cases', 'test_automation'],
    ]);
    for (const w of SPECIALIST_WORKFLOWS) {
      assert.equal(w.workClass, 'draft');
      assert.equal(definitionFor(w.agentKey)?.layer, 'development');
      assert.match(w.agentKey, /^[a-z_]+$/);
    }
  });
  test('the runner claims them through ONE appended spread', () => {
    const src = read('app/api/jobs/run/workflows.ts');
    assert.match(src, /\.\.\.DEVELOPMENT_WORKFLOWS, \.\.\.SPECIALIST_WORKFLOWS\]/);
    assert.match(src, /import \{ SPECIALIST_WORKFLOWS \} from '\.\/specialist-workflows'/);
  });
  test('their job kinds collide with no other workflow', () => {
    const kinds = ['workflows.ts', 'development-workflows.ts', 'acquisition-workflows.ts', 'specialist-workflows.ts']
      .flatMap((f) => [...read(`app/api/jobs/run/${f}`).matchAll(/^\s*jobKind: '([a-z_.]+)',/gm)].map((m) => m[1]));
    assert.equal(new Set(kinds).size, kinds.length);
  });
});

describe('documentation: what it reads, asks, validates and writes', () => {
  test('a valid, evidenced draft is written through the one door, after the model and never before', async () => {
    reset();
    answer(goodDoc);
    const r = await wf('documentation.draft').run(ctxFor('documentation', { projectId: 'p-1' }));
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(events.filter((e) => e.startsWith('rpc:') || ['openRun', 'model', 'succeedRun'].includes(e)), ['openRun', 'model', 'rpc:projects.record_documentation_draft', 'succeedRun']);
    assert.equal(rpcCalls.length, 1);
    const call = rpcCalls[0]!;
    assert.equal(call.args.p_kind, 'architecture');
    assert.match(String(call.args.p_body), /\(evidence: integration:WhatsApp\)/);
    assert.deepEqual(Object.keys(call.args).sort(), ['p_body', 'p_kind', 'p_project_id', 'p_title']);
  });
  test('every record it reads is scoped to the JOB\'s organization, never one the payload names', async () => {
    reset();
    answer(goodDoc);
    await wf('documentation.draft').run(ctxFor('documentation', { projectId: 'p-1', organizationId: 'org-EVIL' }));
    const reads = readFilters.filter((f) => !f.table.startsWith('core.'));
    assert.ok(reads.length >= 7);
    const tablesRead = new Set(reads.map((f) => f.table));
    for (const t of tablesRead) assert.ok(reads.some((f) => f.table === t && f.column === 'organization_id' && f.value === 'org-1'), `${t} is read for org-1`);
    assert.ok(!readFilters.some((f) => f.value === 'org-EVIL'));
  });
  test('the facts handed to the model are the stored ones, with the LATEST run per suite', async () => {
    const facts = {
      projectName: 'Shop', commit: 'abc1234', openDefects: 1,
      integrations: [{ name: 'Maps', kind: 'maps', health: 'configured', isMock: false }],
      documents: [], testSuites: [{ suite: 'functional', passed: 8, failed: 1 }],
    };
    const text = drafts.renderDocumentationFacts(facts);
    assert.match(text, /integration:Maps -> configured/);
    assert.match(text, /tests:functional -> 8 passed, 1 failed/);
    assert.deepEqual(drafts.evidenceRefsOf(facts), ['commit:abc1234', 'integration:Maps', 'tests:functional', 'defects:open']);
  });
  test('a claim that a configured integration works is refused, and nothing is written', async () => {
    reset();
    answer({ ...goodDoc, sections: [{ heading: 'Maps', claims: [{ statement: 'Maps is live and working.', evidenceRef: 'integration:Maps' }] }] });
    const r = await wf('documentation.draft').run(ctxFor('documentation', { projectId: 'p-1' }));
    assert.equal(r.status, 'failed');
    assert.ok(events.some((e) => e.startsWith('failJob:the model\'s answer was refused')));
    assert.equal(rpcCalls.length, 0);
  });
  test('a configured integration may be described as configured', async () => {
    reset();
    answer({ ...goodDoc, sections: [{ heading: 'Maps', claims: [{ statement: 'Maps has credentials set but has not been checked.', evidenceRef: 'integration:Maps' }] }] });
    assert.equal((await wf('documentation.draft').run(ctxFor('documentation', { projectId: 'p-1' }))).status, 'succeeded');
  });
  test('a claim citing evidence it was not shown is refused', async () => {
    reset();
    answer({ ...goodDoc, sections: [{ heading: 'x', claims: [{ statement: 'The checkout has a refund endpoint.', evidenceRef: 'document:Refund API' }] }] });
    assert.equal((await wf('documentation.draft').run(ctxFor('documentation', { projectId: 'p-1' }))).status, 'failed');
    assert.equal(rpcCalls.length, 0);
  });
  test('an answer outside the strict schema is refused: an extra status field, an invented kind, no claims', async () => {
    for (const bad of [{ ...goodDoc, status: 'implemented' }, { ...goodDoc, kind: 'integration' }, { ...goodDoc, sections: [{ heading: 'h', claims: [] }] }]) {
      reset();
      answer(bad);
      assert.equal((await wf('documentation.draft').run(ctxFor('documentation', { projectId: 'p-1' }))).status, 'failed');
      assert.equal(rpcCalls.length, 0);
    }
  });
  test('a secret value in a claim is refused', async () => {
    reset();
    answer({ ...goodDoc, sections: [{ heading: 'h', claims: [{ statement: `Set ${secret()} in the environment.`, evidenceRef: 'integration:WhatsApp' }] }] });
    assert.equal((await wf('documentation.draft').run(ctxFor('documentation', { projectId: 'p-1' }))).status, 'failed');
    assert.equal(rpcCalls.length, 0);
  });
  test('"exists" from the door is success (never overwritten); any other refusal fails the job', async () => {
    reset();
    answer(goodDoc);
    rpcAnswer.record_documentation_draft = [{ outcome: 'exists' }];
    assert.equal((await wf('documentation.draft').run(ctxFor('documentation', { projectId: 'p-1' }))).status, 'succeeded');
    reset();
    answer(goodDoc);
    rpcAnswer.record_documentation_draft = [{ outcome: 'refused' }];
    assert.equal((await wf('documentation.draft').run(ctxFor('documentation', { projectId: 'p-1' }))).status, 'failed');
  });
  test('no payload, a vanished project and a missing provider are each settled honestly', async () => {
    reset();
    assert.equal((await wf('documentation.draft').run(ctxFor('documentation', {}))).status, 'failed');
    reset();
    tables['projects.projects'] = [];
    const gone = await wf('documentation.draft').run(ctxFor('documentation', { projectId: 'p-1' }));
    assert.equal(gone.status, 'succeeded');
    assert.ok(!events.includes('model'));
    reset();
    modelResult = { ok: false, kind: 'no_provider', detail: 'no model configured', stepCount: 0 };
    const none = await wf('documentation.draft').run(ctxFor('documentation', { projectId: 'p-1' }));
    assert.equal(none.reason, 'AI_PROVIDER_NOT_CONFIGURED');
  });
});

const goodCases = {
  cases: [
    { name: 'declined card shows the reason', layer: 'api', description: 'A declined card returns the provider reason.', steps: ['post a payment with a declined test card'], expected: 'the response carries the decline reason', coversCriterion: 'A declined card shows why' },
    { name: 'declined card keeps the cart', layer: 'e2e', description: 'The cart survives a decline.', steps: ['pay with a declined card', 'open the cart'], expected: 'the cart still holds the items' },
  ],
};

describe('test automation: proposals only', () => {
  test('each valid case is recorded through the draft door for the task, and nothing else is written', async () => {
    reset();
    answer(goodCases);
    const r = await wf('test_automation.propose_cases').run(ctxFor('test_automation', { taskId: 't-1' }));
    assert.equal(r.status, 'succeeded');
    assert.equal(r.recorded, 2);
    assert.deepEqual(rpcCalls.map((c) => c.fn), ['record_test_case_draft', 'record_test_case_draft']);
    assert.ok(rpcCalls.every((c) => c.args.p_task_id === 't-1'));
    assert.ok(events.indexOf('model') < events.indexOf('rpc:projects.record_test_case_draft'));
  });
  test('the task is read for the job\'s organization', async () => {
    reset();
    answer(goodCases);
    await wf('test_automation.propose_cases').run(ctxFor('test_automation', { taskId: 't-1' }));
    for (const t of ['projects.tasks', 'projects.test_case_drafts']) assert.ok(readFilters.some((f) => f.table === t && f.column === 'organization_id' && f.value === 'org-1'), t);
  });
  test('a task of another organization (not found for this one) is settled without a model call', async () => {
    reset();
    tables['projects.tasks'] = [];
    const r = await wf('test_automation.propose_cases').run(ctxFor('test_automation', { taskId: 't-other' }));
    assert.equal(r.status, 'succeeded');
    assert.ok(!events.includes('model'));
    assert.equal(rpcCalls.length, 0);
  });
  test('a cancelled task is not given proposals', async () => {
    reset();
    tables['projects.tasks'] = [{ id: 't-1', project_id: 'p-1', title: 'x', status: 'cancelled' }];
    const r = await wf('test_automation.propose_cases').run(ctxFor('test_automation', { taskId: 't-1' }));
    assert.equal(r.outcome, 'gone');
    assert.ok(!events.includes('model'));
  });
  test('an answer outside the strict schema is refused before any write', async () => {
    const dup = { cases: [goodCases.cases[0], { ...goodCases.cases[1], name: 'DECLINED CARD SHOWS THE REASON' }] };
    for (const bad of [
      { ...goodCases, result: 'passed' },
      { cases: [{ ...goodCases.cases[0], status: 'passed' }] },
      { cases: [{ ...goodCases.cases[0], layer: 'astral' }] },
      { cases: [] },
      dup,
      { cases: [{ ...goodCases.cases[0], description: `uses ${secret()}` }] },
    ]) {
      reset();
      answer(bad);
      const r = await wf('test_automation.propose_cases').run(ctxFor('test_automation', { taskId: 't-1' }));
      assert.equal(r.status, 'failed');
      assert.equal(rpcCalls.length, 0);
    }
  });
  test('a case already drafted is not an error; a door refusal fails the job', async () => {
    reset();
    answer(goodCases);
    rpcAnswer.record_test_case_draft = [{ outcome: 'already_drafted' }];
    const r = await wf('test_automation.propose_cases').run(ctxFor('test_automation', { taskId: 't-1' }));
    assert.equal(r.status, 'succeeded');
    assert.equal(r.recorded, 0);
    reset();
    answer(goodCases);
    rpcAnswer.record_test_case_draft = [{ outcome: 'bad_input' }];
    assert.equal((await wf('test_automation.propose_cases').run(ctxFor('test_automation', { taskId: 't-1' }))).status, 'failed');
  });
});

describe('where the workflows can write', () => {
  const src = read('app/api/jobs/run/specialist-workflows.ts');
  test('only the two service-only draft doors, by name', () => {
    const rpcs = [...src.matchAll(/\.rpc\('([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(rpcs)].sort(), ['record_documentation_draft', 'record_test_case_draft']);
  });
  test('it never ingests a report, writes a run, a result or a document directly, and never says implemented', () => {
    assert.doesNotMatch(src, /ingest_test_report|test_runs'\)\s*\.(insert|upsert)|test_run_cases|record_technical_document|\.insert\(|\.upsert\(|\.delete\(/);
    assert.doesNotMatch(src, /'implemented'|status: 'passed'/);
  });
  test('it validates strictly BEFORE it writes, on both paths', () => {
    assert.ok(src.indexOf('documentationDraftSchema.safeParse') < src.indexOf("rpc('record_documentation_draft'"));
    assert.ok(src.indexOf('testCaseDraftsSchema.safeParse') < src.indexOf("rpc('record_test_case_draft'"));
    assert.match(src, /the model's answer was refused/);
  });
  test('the doors themselves are service-role only and cannot write evidence or an implemented document', () => {
    const sql = read('supabase/migrations/20261102420000_the_test_and_documentation_agents_leave_drafts_never_evidence.sql');
    assert.match(sql, /revoke all on function projects\.record_test_case_draft[^;]*from public, anon, authenticated/);
    assert.match(sql, /grant execute on function projects\.record_test_case_draft[^;]*to service_role/);
    assert.match(sql, /revoke all on function projects\.record_documentation_draft[^;]*from public, anon, authenticated/);
    assert.match(sql, /'partial', null,/);
    assert.doesNotMatch(sql, /insert into qa\./);
  });
});

describe('the pure checks', () => {
  test('documentation: kinds the database derives are not the agent\'s to write', () => {
    assert.deepEqual([...drafts.DOCUMENTATION_DRAFT_KINDS].sort(), ['api', 'architecture', 'database', 'handoff', 'known_limitations', 'other']);
    const sql = read('supabase/migrations/20261102420000_the_test_and_documentation_agents_leave_drafts_never_evidence.sql');
    for (const k of drafts.DOCUMENTATION_DRAFT_KINDS) assert.ok(sql.includes(`'${k}'`), k);
  });
  test('test layers are exactly the ones the database accepts', () => {
    for (const f of ['20261102400000_a_test_result_carries_its_evidence_and_a_defect_has_its_regression_test.sql', '20261102420000_the_test_and_documentation_agents_leave_drafts_never_evidence.sql']) {
      const sql = read(`supabase/migrations/${f}`);
      for (const l of drafts.TEST_CASE_LAYERS) assert.ok(sql.includes(`'${l}'`), `${f} ${l}`);
    }
  });
  test('a mock integration is never documented as working even when its health string says verified', () => {
    const facts = { projectName: 'p', commit: null, openDefects: 0, documents: [], testSuites: [], integrations: [{ name: 'Pay', kind: 'payment', health: 'configured', isMock: true }] };
    const draft = { title: 't', kind: 'api' as const, sections: [{ heading: 'h', claims: [{ statement: 'Payments are implemented.', evidenceRef: 'integration:Pay' }] }] };
    assert.equal(drafts.checkDocumentationDraft(draft, facts).ok, false);
  });
  test('secret detection finds values and ignores variable names', () => {
    assert.equal(drafts.containsSecretValue(secret()), true);
    assert.equal(drafts.containsSecretValue(`Bearer ${'a'.repeat(24)}`), false);
    assert.equal(drafts.containsSecretValue('authorization: ' + 'b'.repeat(24)), true);
    assert.equal(drafts.containsSecretValue('Set RAZORPAY_KEY_ID in the environment.'), false);
  });
});
