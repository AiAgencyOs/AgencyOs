import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { NOT_CONFIGURED_CODE, notConfiguredExecutor, resolveDeploymentExecutor } from '../src/modules/projects/deployment-executor.ts';
import { handleOpenPhaseSeven, handleRunDeployment } from '../src/modules/projects/phase-seven-handlers.ts';

/**
 * Phase 7 runner jobs against a scripted database. The deployment executor is NOT configured: after the deployment is RECORDED as approved, the job stores an
 * honest blocker. It must never record a start or a success, and a replay must not record a second deployment or a second blocker.
 */

type Call = { fn: string; args: Record<string, unknown> };
function stubAdmin(script: { rpc: Record<string, unknown>; rows?: Record<string, unknown> }) {
  const calls: Call[] = [];
  const admin = {
    schema: () => ({
      from: (table: string) => {
        const row = script.rows?.[table] ?? null;
        const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: row, error: null }), limit: async () => ({ data: Array.isArray(row) ? row : row ? [row] : [], error: null }) };
        return chain;
      },
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        if (!(fn in script.rpc)) return { data: null, error: { message: `unexpected rpc ${fn}` } };
        return { data: script.rpc[fn], error: null };
      },
    }),
  };
  return { admin: admin as never, calls };
}
const job = (subjectId: string | null, eventType = 'project.deployment_approved') => ({ id: 'j1', organization_id: 'org-1', correlation_id: null, payload: { eventType, subjectId } }) as never;

describe('the deployment executor seam', () => {
  test('the only executor is "not configured": it deploys nothing and says so', async () => {
    assert.equal(resolveDeploymentExecutor(), notConfiguredExecutor);
    assert.equal(notConfiguredExecutor.kind, 'not_configured');
    const out = await notConfiguredExecutor.execute({ deploymentId: 'd', planId: 'p', projectId: 'x', commitRef: 'abc', artifactSha256: 'a'.repeat(64), environment: 'production' });
    assert.equal(out.status, 'blocked');
    assert.equal(out.status === 'blocked' && out.code, NOT_CONFIGURED_CODE);
    assert.match(out.status === 'blocked' ? out.detail : '', /Nothing was deployed/);
    assert.match(NOT_CONFIGURED_CODE, /^[a-z_]+$/);
  });
});

describe('P704: the approved plan is RECORDED, then the executor answers with a blocker - never a success', () => {
  const plan = { id: 'plan-1', project_id: 'proj-1', commit_ref: 'abc1234', artifact_sha256: 'a'.repeat(64), environment: 'production' };
  test('a fresh approval records the deployment and then an honest blocker', async () => {
    const { admin, calls } = stubAdmin({ rows: { p7_deployment_plans: plan }, rpc: { request_deployment: [{ outcome: 'requested', deployment_id: 'dep-1' }], record_deployment_blocker: [{ outcome: 'blocked' }] } });
    const result = await handleRunDeployment(admin, job('plan-1'));
    assert.equal(result.status, 'succeeded');
    assert.equal(result.status === 'succeeded' && result.outcome, 'blocked_no_executor');
    assert.deepEqual(calls.map((c) => c.fn), ['request_deployment', 'record_deployment_blocker']);
    assert.equal(calls[0]?.args.p_idempotency_key, 'approval:plan-1');
    assert.equal(calls[1]?.args.p_code, NOT_CONFIGURED_CODE);
    assert.match(String(calls[1]?.args.p_detail), /Nothing was deployed/);
  });
  test('it never calls the progress door: no start, no success, no validation is fabricated', async () => {
    const { admin, calls } = stubAdmin({ rows: { p7_deployment_plans: plan }, rpc: { request_deployment: [{ outcome: 'requested', deployment_id: 'dep-1' }], record_deployment_blocker: [{ outcome: 'blocked' }] } });
    await handleRunDeployment(admin, job('plan-1'));
    assert.ok(!calls.some((c) => /progress|validation|complete/.test(c.fn)), calls.map((c) => c.fn).join(','));
  });
  test('P704-T011: a duplicate approval event records no second deployment and no second blocker', async () => {
    const { admin, calls } = stubAdmin({ rows: { p7_deployment_plans: plan }, rpc: { request_deployment: [{ outcome: 'already_requested', deployment_id: 'dep-1' }] } });
    const result = await handleRunDeployment(admin, job('plan-1'));
    assert.equal(result.status === 'succeeded' && result.outcome, 'already_requested');
    assert.deepEqual(calls.map((c) => c.fn), ['request_deployment']);
  });
  test('an approval that no longer holds (a changed candidate) deploys nothing', async () => {
    const { admin, calls } = stubAdmin({ rows: { p7_deployment_plans: plan }, rpc: { request_deployment: [{ outcome: 'not_approved', deployment_id: null }] } });
    const result = await handleRunDeployment(admin, job('plan-1'));
    assert.equal(result.status === 'succeeded' && result.outcome, 'not_approved');
    assert.deepEqual(calls.map((c) => c.fn), ['request_deployment']);
  });
  test('a door that does not answer is a retryable failure, not a success', async () => {
    const { admin } = stubAdmin({ rows: { p7_deployment_plans: plan }, rpc: {} });
    const result = await handleRunDeployment(admin, job('plan-1'));
    assert.equal(result.status, 'failed');
  });
  test('the job organization scopes every read: a plan of another organization is "gone"', async () => {
    const { admin, calls } = stubAdmin({ rows: {}, rpc: { request_deployment: [{ outcome: 'requested', deployment_id: 'x' }] } });
    const result = await handleRunDeployment(admin, job('plan-9'));
    assert.equal(result.status === 'succeeded' && result.outcome, 'gone');
    assert.equal(calls.length, 0);
  });
  test('a closed ROLLBACK incident redeploys the still-approved plan under its own key; a closed code incident does nothing', async () => {
    const rollback = stubAdmin({ rows: { p7_incidents: { id: 'inc-1', project_id: 'proj-1', recovery_path: 'rollback' }, p7_deployment_plans: plan }, rpc: { p7_deployment_approved: true, request_deployment: [{ outcome: 'requested', deployment_id: 'dep-2' }], record_deployment_blocker: [{ outcome: 'blocked' }] } });
    const r1 = await handleRunDeployment(rollback.admin, job('inc-1', 'project.deployment_incident_closed'));
    assert.equal(r1.status === 'succeeded' && r1.outcome, 'blocked_no_executor');
    assert.equal(rollback.calls.find((c) => c.fn === 'request_deployment')?.args.p_idempotency_key, 'redeploy:inc-1');
    const code = stubAdmin({ rows: { p7_incidents: { id: 'inc-2', project_id: 'proj-1', recovery_path: 'code' } }, rpc: {} });
    const r2 = await handleRunDeployment(code.admin, job('inc-2', 'project.deployment_incident_closed'));
    assert.equal(r2.status === 'succeeded' && r2.outcome, 'not_a_rollback');
    assert.equal(code.calls.length, 0);
  });
});

describe('P701: the workspace opens through the door, which decides', () => {
  test('each door answer is reported as it is', async () => {
    for (const [answer, outcome] of [['ready', 'ready'], ['waiting_m4_verification', 'waiting_m4_verification'], ['candidate_not_current', 'candidate_not_current'], ['already_started', 'already_started'], ['phase_six_incomplete', 'not_ready']] as const) {
      const { admin } = stubAdmin({ rows: { projects: { id: 'proj-1' } }, rpc: { open_phase_seven: [{ outcome: answer, phase_seven_id: 'x' }] } });
      const result = await handleOpenPhaseSeven(admin, job('proj-1', 'project.m4_payment_verified'));
      assert.equal(result.status, 'succeeded', answer);
      assert.equal(result.status === 'succeeded' && result.outcome, outcome, answer);
    }
  });
  test('a project of another organization is never opened, and an unknown door answer is retried', async () => {
    const { admin, calls } = stubAdmin({ rows: {}, rpc: { open_phase_seven: [{ outcome: 'ready' }] } });
    const gone = await handleOpenPhaseSeven(admin, job('proj-9', 'project.m4_payment_verified'));
    assert.equal(gone.status === 'succeeded' && gone.outcome, 'gone');
    assert.equal(calls.length, 0);
    const odd = stubAdmin({ rows: { projects: { id: 'p' } }, rpc: { open_phase_seven: [{ outcome: 'surprise' }] } });
    assert.equal((await handleOpenPhaseSeven(odd.admin, job('p', 'project.m4_payment_verified'))).status, 'failed');
  });
});
