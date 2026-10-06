import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BUILD_STAGES, maskSecrets, notConfiguredExecutor, runBuild, type BuildStage, type Executor, type RunPlan, type StageResult } from '../src/modules/projects/build-runner.ts';

/**
 * The runner's decisions against a scripted fake executor. A real toolchain / CI worker is the owner's binding and is the one thing these
 * tests cannot prove; what is proven is the order, the stop-at-first-failure, the classification, the retry rule, the masking and the refusals.
 */
const SHA = 'a'.repeat(64);

function fake(script: Partial<Record<BuildStage, (StageResult | 'throw')[]>>, opts: { sha?: string | null; command?: string } = {}) {
  const seen: BuildStage[] = [];
  const calls: Record<string, number> = {};
  const executor: Executor = {
    async stage(name) {
      seen.push(name);
      const list = script[name] ?? [{ status: 'passed' }];
      const i = calls[name] ?? 0;
      calls[name] = i + 1;
      const next = list[Math.min(i, list.length - 1)]!;
      if (next === 'throw') throw new Error('boom');
      return next;
    },
    async artifactSha256() { return opts.sha === undefined ? SHA : opts.sha; },
    command: () => opts.command ?? 'npm run build',
    fingerprint: () => ({ node: '22', os: 'linux' }),
  };
  return { executor, seen };
}

function plan(overrides: Partial<RunPlan> = {}) {
  const records: Parameters<RunPlan['record']>[0][] = [];
  const failures: Parameters<NonNullable<RunPlan['recordFailure']>>[0][] = [];
  let n = 0;
  const p: RunPlan = {
    deliverableId: 'd1', commit: 'abc1234', environment: 'review',
    record: async (args) => { records.push(args); n += 1; return { outcome: 'recorded', runId: `run-${n}` }; },
    recordFailure: async (a) => { failures.push(a); },
    ...overrides,
  };
  return { p, records, failures };
}

describe('the build runner', () => {
  test('a clean build runs every stage in order and records a verified artifact', async () => {
    const { executor, seen } = fake({});
    const { p, records } = plan();
    const r = await runBuild(executor, p);
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(seen, ['source', 'env', 'install', 'lint_type', 'test', 'build']);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0]!.stages.map((s) => s.name), [...BUILD_STAGES]);
    assert.equal(records[0]!.artifactSha256, SHA);
    assert.equal(records[0]!.fingerprint.commit, 'abc1234');
    assert.equal(records[0]!.idempotencyKey, 'build:d1:abc1234:1');
  });
  test('a compile failure stops there, is classified from the stage, and is NOT retried', async () => {
    const { executor, seen } = fake({ build: [{ status: 'failed', log: 'TS2322' }] });
    const { p, records, failures } = plan();
    const r = await runBuild(executor, p);
    assert.equal(r.status, 'failed');
    assert.equal(r.failureClass, 'compile_failed');
    assert.equal(r.attempts, 1);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.status, 'failed');
    assert.equal(records[0]!.artifactSha256, null);
    assert.equal(seen.at(-1), 'build');
    assert.deepEqual(failures.map((f) => [f.failureClass, f.retry, f.escalate]), [['build_failure', 'never', true]]);
  });
  test('a test failure is a test failure and goes back to the specialist', async () => {
    const { executor } = fake({ test: [{ status: 'failed', log: '3 failing' }] });
    const { p, failures } = plan();
    const r = await runBuild(executor, p);
    assert.equal(r.failureClass, 'test_failed');
    assert.equal(failures[0]!.failureClass, 'test_failure');
  });
  test('a transient install failure is retried on the same commit and then succeeds, linked to the failed attempt', async () => {
    const { executor } = fake({ install: [{ status: 'failed', transient: true, log: 'registry timeout' }, { status: 'passed' }] });
    const { p, records, failures } = plan();
    const r = await runBuild(executor, p);
    assert.equal(r.status, 'succeeded');
    assert.equal(r.attempts, 2);
    assert.equal(records[0]!.failureClass, 'infra_transient');
    assert.equal(records[1]!.retryOf, 'run-1');
    assert.equal(records[1]!.idempotencyKey, 'build:d1:abc1234:2');
    assert.deepEqual(failures.map((f) => f.retry), ['safe']);
  });
  test('retries are bounded: a transient failure that never clears stops at the budget and escalates', async () => {
    const { executor } = fake({ install: [{ status: 'failed', transient: true }] });
    const { p, records, failures } = plan();
    const r = await runBuild(executor, p);
    assert.equal(r.status, 'failed');
    assert.equal(r.attempts, 3);
    assert.equal(records.length, 3);
    assert.equal(failures.at(-1)!.escalate, true);
  });
  test('success with no artifact is artifact_missing, never a pass', async () => {
    const { executor } = fake({}, { sha: null });
    const { p, records } = plan();
    const r = await runBuild(executor, p);
    assert.equal(r.status, 'failed');
    assert.equal(r.failureClass, 'artifact_missing');
    assert.equal(records[0]!.status, 'failed');
    assert.equal(records[0]!.stages.at(-1)!.status, 'failed');
  });
  test('a malformed artifact hash is not an artifact', async () => {
    const { executor } = fake({}, { sha: 'not-a-hash' });
    const { p } = plan();
    assert.equal((await runBuild(executor, p)).failureClass, 'artifact_missing');
  });
  test('a build command that deploys is blocked before anything runs', async () => {
    const { executor, seen } = fake({}, { command: 'vercel deploy --prod' });
    const { p, records } = plan();
    const r = await runBuild(executor, p);
    assert.equal(r.status, 'blocked');
    assert.equal(seen.length, 0);
    assert.equal(records.length, 0);
  });
  test('nothing bound: the honest result is an environment_missing failure, not a fabricated build', async () => {
    const { p, records } = plan();
    const r = await runBuild(notConfiguredExecutor, p);
    assert.equal(r.status, 'failed');
    assert.equal(r.failureClass, 'environment_missing');
    assert.equal(records[0]!.status, 'failed');
    assert.equal(records[0]!.artifactSha256, null);
  });
  test('a door refusal is reported, not claimed as a recorded build', async () => {
    const { executor } = fake({});
    const { p } = plan({ record: async () => ({ outcome: 'build_already_shared', runId: null }) });
    const r = await runBuild(executor, p);
    assert.equal(r.status, 'blocked');
    assert.match(r.detail, /build_already_shared/);
  });
  test('a replayed record (already_recorded) counts as recorded', async () => {
    const { executor } = fake({});
    const { p } = plan({ record: async () => ({ outcome: 'already_recorded', runId: 'run-x' }) });
    assert.equal((await runBuild(executor, p)).status, 'succeeded');
  });
  test('secrets are masked out of everything recorded', async () => {
    const { executor } = fake({ build: [{ status: 'failed', log: 'failed with token=abcdef1234567890 and sk-abcdefghijklmnopqrstuv' }] });
    const { p, failures } = plan();
    const r = await runBuild(executor, p);
    assert.ok(!r.detail.includes('abcdef1234567890') && !r.detail.includes('sk-abcdefghijklmnop'));
    assert.ok(!failures[0]!.detail.includes('sk-abcdefghijklmnop'));
  });
});

describe('smoke and artifact records', () => {
  test('an executor with no smoke capability records NOT_TESTED with a reason, never a pass', async () => {
    const { executor } = fake({});
    const smokes: Parameters<NonNullable<RunPlan['recordSmoke']>>[0][] = [];
    const { p } = plan({ recordSmoke: async (a) => { smokes.push(a); } });
    assert.equal((await runBuild(executor, p)).status, 'succeeded');
    assert.equal(smokes.length, 1);
    assert.equal(smokes[0]!.result, 'not_tested');
    assert.match(smokes[0]!.reason ?? '', /no launch\/smoke capability/);
  });
  test('a smoke pass without checks and evidence is downgraded to blocked, not accepted', async () => {
    const { executor } = fake({});
    executor.smoke = async () => ({ result: 'passed', checks: [] });
    const smokes: Parameters<NonNullable<RunPlan['recordSmoke']>>[0][] = [];
    const { p } = plan({ recordSmoke: async (a) => { smokes.push(a); } });
    await runBuild(executor, p);
    assert.equal(smokes[0]!.result, 'blocked');
  });
  test('a real smoke pass with checks and evidence is recorded as passed', async () => {
    const { executor } = fake({});
    executor.smoke = async () => ({ result: 'passed', checks: [{ name: 'launch' }], evidenceUrl: 'https://ci.example.test/smoke/1', deviceTarget: 'chrome' });
    const smokes: Parameters<NonNullable<RunPlan['recordSmoke']>>[0][] = [];
    const { p } = plan({ recordSmoke: async (a) => { smokes.push(a); } });
    await runBuild(executor, p);
    assert.equal(smokes[0]!.result, 'passed');
  });
  test('the artifact is recorded against the recorded run; a failed build records no smoke and no artifact', async () => {
    const ok = fake({});
    ok.executor.artifactInfo = async () => ({ type: 'web_bundle', storageRef: 's3://b/app.zip', sizeBytes: 10, distributable: true });
    const arts: Parameters<NonNullable<RunPlan['recordArtifact']>>[0][] = [];
    const smokes: unknown[] = [];
    const a = plan({ recordArtifact: async (x) => { arts.push(x); }, recordSmoke: async (x) => { smokes.push(x); } });
    await runBuild(ok.executor, a.p);
    assert.deepEqual(arts.map((x) => [x.runId, x.type, x.distributable]), [['run-1', 'web_bundle', true]]);
    const bad = fake({ build: [{ status: 'failed' }] });
    const b = plan({ recordArtifact: async (x) => { arts.push(x); }, recordSmoke: async (x) => { smokes.push(x); } });
    await runBuild(bad.executor, b.p);
    assert.equal(arts.length, 1);
    assert.equal(smokes.length, 1);
  });
});

describe('maskSecrets', () => {
  test('masks the shapes that leak', () => {
    const cases = [
      'sk-abcdefghijklmnopqrstuvwx',
      ['ghp', '_abcdefghijklmnopqrstuvwxyz0123'].join(''),
      ['xo', 'xb-1234567890-abcdefghij'].join(''),
      ['AK', 'IAABCDEFGHIJKLMNOP'].join(''),
      ['ey', 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij'].join(''),
      'postgres://admin:hunter2secret@db.example.com/app',
      'password=correcthorsebattery',
      ['-----BEGIN RSA PRIV', 'ATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIV', 'ATE KEY-----'].join(''),
    ];
    for (const c of cases) assert.ok(!maskSecrets(`log: ${c} end`).includes(c.slice(8, 22)), c);
    assert.equal(maskSecrets('nothing secret here'), 'nothing secret here');
  });
});
