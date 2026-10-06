import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runBuild, type RunPlan } from '../src/modules/projects/build-runner.ts';
import { buildReportSchema, reportExecutor, signBuildReport, verifyBuildReport, type BuildReport } from '../src/modules/projects/github-build.ts';

/**
 * Proven here against fakes: the dispatch request, the signature rules, the report schema and what the runner does with a report. NOT proven:
 * the live GitHub API and a real workflow run, which need the owner's repository, token and workflow.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const ENV = { BUILD_REPORT_SECRET: 'whsec_test_secret_value' };
const ID = '11111111-1111-4111-8111-111111111111';
const RQ = '22222222-2222-4222-8222-222222222222';
const SHA = 'b'.repeat(64);

function report(over: Partial<BuildReport> = {}): BuildReport {
  return {
    requestId: RQ, deliverableId: ID, commit: 'abc1234def',
    stages: ['source', 'env', 'install', 'lint_type', 'test', 'build'].map((name) => ({ name: name as 'build', status: 'passed' as const, duration_ms: 10 })),
    artifact: { sha256: SHA, type: 'web_bundle', storageRef: 's3://b/app.zip', sizeBytes: 5, distributable: true },
    smoke: null, fingerprint: { node: '22', os: 'ubuntu' }, command: 'npm run build', runUrl: 'https://github.com/acme/shop-app/actions/runs/1', ...over,
  };
}

describe('the build is dispatched only by the governed git writer', () => {
  const ACTIONS = read('src/modules/projects/phase-five-actions.ts');
  const WRITER = read('src/modules/projects/git-write-service.ts');
  test('the build action asks the governed writer, never GitHub directly, and carries the EXACT commit as an input', () => {
    assert.match(ACTIONS, /triggerBuild\(\{/);
    assert.match(ACTIONS, /inputs: \{ commit: requested\.commit_ref/);
    assert.doesNotMatch(read('src/modules/projects/github-build.ts') + ACTIONS, /api\.github\.com/);
  });
  test('the writer passes the inputs to the workflow dispatch and records the trigger only after GitHub accepted it', () => {
    assert.match(WRITER, /\.\.\.\(parsed\.data\.inputs \? \{ inputs: parsed\.data\.inputs \} : \{\}\)/);
    assert.ok(WRITER.indexOf('dispatchWorkflow({') < WRITER.indexOf("action: 'build_triggered'"));
  });
  test('a refused dispatch settles the request as dispatch_failed, so it is not left waiting for a report that will never come', () => {
    assert.match(ACTIONS, /p_status: 'dispatch_failed'/);
  });
  test('without a linked workflow file or the report secret, the action records the environment_missing blocker instead of pretending', () => {
    assert.match(ACTIONS, /workflowFile && process\.env\.BUILD_REPORT_SECRET/);
    assert.match(ACTIONS, /boundBuildExecutor\(\)/);
  });
});

describe('the signature', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  const ts = String(Math.floor(now.getTime() / 1000));
  const body = JSON.stringify(report());
  const sig = signBuildReport(ENV.BUILD_REPORT_SECRET, ts, body);
  const verify = (over: Partial<Parameters<typeof verifyBuildReport>[0]> = {}) => verifyBuildReport({ secret: ENV.BUILD_REPORT_SECRET, rawBody: body, signature: sig, timestamp: ts, now, ...over });
  test('a correct signature over the raw body passes, with or without the sha256= prefix', () => {
    assert.deepEqual(verify(), { ok: true });
    assert.deepEqual(verify({ signature: `sha256=${sig}` }), { ok: true });
  });
  test('a tampered body, a wrong secret, a different timestamp and a missing header are refused', () => {
    assert.deepEqual(verify({ rawBody: body.replace('abc1234def', 'fff9999000') }), { ok: false, reason: 'bad_signature' });
    assert.deepEqual(verify({ secret: 'another' }), { ok: false, reason: 'bad_signature' });
    assert.deepEqual(verify({ signature: null }), { ok: false, reason: 'missing' });
    assert.deepEqual(verify({ timestamp: null }), { ok: false, reason: 'missing' });
    assert.deepEqual(verify({ signature: 'zz' }), { ok: false, reason: 'bad_signature' });
  });
  test('a captured report cannot be replayed later', () => {
    assert.deepEqual(verify({ now: new Date(now.getTime() + 10 * 60_000) }), { ok: false, reason: 'stale' });
    assert.deepEqual(verify({ now: new Date(now.getTime() - 10 * 60_000) }), { ok: false, reason: 'stale' });
  });
});

describe('the report', () => {
  test('a valid report parses; an extra field, a bad commit and a bad hash do not', () => {
    assert.ok(buildReportSchema.safeParse(report()).success);
    assert.equal(buildReportSchema.safeParse({ ...report(), approved: true }).success, false);
    assert.equal(buildReportSchema.safeParse({ ...report(), commit: 'main' }).success, false);
    assert.equal(buildReportSchema.safeParse({ ...report(), artifact: { ...report().artifact!, sha256: 'abc' } }).success, false);
    assert.equal(buildReportSchema.safeParse({ ...report(), stages: [] }).success, false);
  });
  const plan = () => {
    const records: Parameters<RunPlan['record']>[0][] = [];
    const smokes: Parameters<NonNullable<RunPlan['recordSmoke']>>[0][] = [];
    const arts: unknown[] = [];
    const p: RunPlan = {
      deliverableId: ID, commit: 'abc1234def', environment: 'review', maxAttempts: 1,
      record: async (a) => { records.push(a); return { outcome: 'recorded', runId: 'run-1' }; },
      recordSmoke: async (a) => { smokes.push(a); },
      recordArtifact: async (a) => { arts.push(a); },
    };
    return { p, records, smokes, arts };
  };
  test('a clean report is a recorded success with its artifact, and no smoke result becomes NOT_TESTED', async () => {
    const { p, records, smokes, arts } = plan();
    const r = await runBuild(reportExecutor(report()), p);
    assert.equal(r.status, 'succeeded');
    assert.equal(records[0]!.artifactSha256, SHA);
    assert.equal(records[0]!.fingerprint.run_url, 'https://github.com/acme/shop-app/actions/runs/1');
    assert.equal(arts.length, 1);
    assert.equal(smokes[0]!.result, 'not_tested');
  });
  test('a failed stage is a failure of that class; a transient one is NOT retried (a retry is a new request)', async () => {
    const stages = report().stages.map((s) => (s.name === 'test' ? { ...s, status: 'failed' as const } : s));
    const a = plan();
    assert.equal((await runBuild(reportExecutor(report({ stages })), a.p)).failureClass, 'test_failed');
    const t = plan();
    const transient = report().stages.map((s) => (s.name === 'install' ? { ...s, status: 'failed' as const, transient: true } : s));
    const r = await runBuild(reportExecutor(report({ stages: transient })), t.p);
    assert.equal(r.attempts, 1);
    assert.equal(t.records.length, 1);
  });
  test('a report that omits a stage did not run it; one with no artifact is artifact_missing, never a pass', async () => {
    const missing = plan();
    const r1 = await runBuild(reportExecutor(report({ stages: report().stages.filter((s) => s.name !== 'lint_type') })), missing.p);
    assert.equal(r1.status, 'failed');
    const none = plan();
    const r2 = await runBuild(reportExecutor(report({ artifact: null })), none.p);
    assert.equal(r2.failureClass, 'artifact_missing');
  });
  test('a smoke pass is recorded only with its checks and evidence', async () => {
    const good = plan();
    await runBuild(reportExecutor(report({ smoke: { result: 'passed', checks: [{ name: 'launch' }], evidenceUrl: 'https://ci.example.test/smoke' } })), good.p);
    assert.equal(good.smokes[0]!.result, 'passed');
    const bare = plan();
    await runBuild(reportExecutor(report({ smoke: { result: 'passed', checks: [] } })), bare.p);
    assert.equal(bare.smokes[0]!.result, 'blocked');
  });
  test('a build command that deploys is blocked before anything is recorded', async () => {
    const { p, records } = plan();
    const r = await runBuild(reportExecutor(report({ command: 'vercel deploy --prod' })), p);
    assert.equal(r.status, 'blocked');
    assert.equal(records.length, 0);
  });
});

describe('the endpoint and the service', () => {
  const ROUTE = read('app/api/builds/report/route.ts');
  const SERVICE = read('src/modules/projects/build-report-service.ts');
  test('the route refuses before it parses: configured, then signed, then fresh, then valid', () => {
    assert.ok(ROUTE.indexOf('BUILD_REPORT_SECRET') < ROUTE.indexOf('verifyBuildReport('));
    assert.ok(ROUTE.indexOf('verifyBuildReport(') < ROUTE.indexOf('JSON.parse(rawBody)'));
    assert.ok(ROUTE.indexOf('JSON.parse(rawBody)') < ROUTE.indexOf('buildReportSchema.safeParse'));
    assert.ok(ROUTE.indexOf('buildReportSchema.safeParse') < ROUTE.indexOf('recordBuildReport('));
    assert.match(ROUTE, /status: 503/);
    assert.doesNotMatch(ROUTE, /NextResponse\.json\([^)]*secret/);
  });
  test('the service accepts a report only for the open request on that deliverable, commit AND request id, and settles it once', () => {
    assert.match(SERVICE, /open_build_request_for/);
    assert.match(SERVICE, /request\.request_id !== report\.requestId/);
    assert.match(SERVICE, /settle_build_request/);
    assert.match(SERVICE, /maxAttempts: 1/);
  });
});
