import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readFileSync } from 'node:fs';

import { sweepRetentionReviews } from '../src/modules/orchestrator/sweeps.ts';
import { handleFillPhaseEightIntake, handleRoutePhaseSevenTask } from '../src/modules/projects/phase-seven-handlers.ts';

/**
 * Phase 7b runner jobs against a scripted database: the Phase 7 -> Phase 8 seam (the completion event fills Phase 8's intake from the frozen handoff) and the
 * Orchestrator's recorded Phase 7 routing decision. The decisions are the DATABASE doors' and the pure routing rule's; these jobs read under the JOB's
 * organization, call a door, and report. They start, approve and deploy nothing.
 */

type Call = { fn: string; args: Record<string, unknown> };
type Script = { rpc: Record<string, unknown>; rows?: Record<string, unknown>; agents?: { key: string; enabled: boolean }[]; rpcError?: string[] };
function stubAdmin(script: Script) {
  const calls: Call[] = [];
  const reads: { table: string; filters: [string, string][] }[] = [];
  const admin = {
    schema: (schema: string) => ({
      from: (table: string) => {
        const filters: [string, string][] = [];
        reads.push({ table, filters });
        const row = schema === 'ai' ? script.agents : (script.rows?.[table] ?? null);
        const chain = {
          select: () => chain,
          eq: (c: string, v: string) => {
            filters.push([c, v]);
            return chain;
          },
          in: async () => ({ data: row, error: null }),
          maybeSingle: async () => ({ data: row, error: null }),
          limit: async () => ({ data: Array.isArray(row) ? row : row ? [row] : [], error: null }),
        };
        return chain;
      },
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        if (script.rpcError?.includes(fn)) return { data: null, error: { message: 'boom' } };
        if (!(fn in script.rpc)) return { data: null, error: { message: `unexpected rpc ${fn}` } };
        return { data: script.rpc[fn], error: null };
      },
    }),
  };
  return { admin: admin as never, calls, reads };
}
const job = (subjectId: string | null, eventType: string) => ({ id: 'j1', organization_id: 'org-1', correlation_id: null, payload: { eventType, subjectId } }) as never;
const DISABLED = [{ key: 'deployment_agent', enabled: false }, { key: 'release_qa', enabled: false }, { key: 'incident_recovery', enabled: false }];

describe('the Phase 7 -> Phase 8 seam: project.completed fills the intake through the service-role door', () => {
  test('the door is called with the JOB organization and the project; a ready intake is reported honestly', async () => {
    const { admin, calls } = stubAdmin({ rows: { projects: { id: 'proj-1' } }, rpc: { fill_phase_eight_intake: [{ outcome: 'ready', intake_id: 'i', intake_status: 'ready' }] } });
    const result = await handleFillPhaseEightIntake(admin, job('proj-1', 'project.completed'));
    assert.equal(result.status, 'succeeded');
    assert.equal(result.status === 'succeeded' && result.outcome, 'ready');
    assert.deepEqual(calls.map((c) => c.fn), ['fill_phase_eight_intake']);
    assert.deepEqual(calls[0]?.args, { p_organization_id: 'org-1', p_project_id: 'proj-1' });
  });
  test('it starts nothing: no Phase 8 start, no warranty, no waiver is ever called', async () => {
    const { admin, calls } = stubAdmin({ rows: { projects: { id: 'p' } }, rpc: { fill_phase_eight_intake: [{ outcome: 'incomplete' }] } });
    await handleFillPhaseEightIntake(admin, job('p', 'project.completed'));
    assert.ok(!calls.some((c) => /start|waive|warranty|state/.test(c.fn)), calls.map((c) => c.fn).join(','));
  });
  test('incomplete (a named blocker), already_started and not_completed are successes with their own words, never an error', async () => {
    for (const [o, re] of [['incomplete', /blockers/], ['already_started', /frozen/], ['not_completed', /not completed/]] as const) {
      const { admin } = stubAdmin({ rows: { projects: { id: 'p' } }, rpc: { fill_phase_eight_intake: [{ outcome: o }] } });
      const r = await handleFillPhaseEightIntake(admin, job('p', 'project.completed'));
      assert.equal(r.status, 'succeeded', o);
      assert.match(r.detail, re);
    }
  });
  test('a project of another organization is "gone": the door is never called', async () => {
    const { admin, calls, reads } = stubAdmin({ rows: {}, rpc: { fill_phase_eight_intake: [{ outcome: 'ready' }] } });
    const r = await handleFillPhaseEightIntake(admin, job('other', 'project.completed'));
    assert.equal(r.status === 'succeeded' && r.outcome, 'gone');
    assert.equal(calls.length, 0);
    assert.deepEqual(reads[0]?.filters, [['id', 'other'], ['organization_id', 'org-1']]);
  });
  test('an event that names no project, a door that does not answer and an unknown answer are failures (the first permanent)', async () => {
    const none = await handleFillPhaseEightIntake(stubAdmin({ rpc: {} }).admin, job(null, 'project.completed'));
    assert.equal(none.status === 'failed' && none.permanent, true);
    const down = await handleFillPhaseEightIntake(stubAdmin({ rows: { projects: { id: 'p' } }, rpc: {} }).admin, job('p', 'project.completed'));
    assert.equal(down.status === 'failed' && down.permanent, false);
    const odd = await handleFillPhaseEightIntake(stubAdmin({ rows: { projects: { id: 'p' } }, rpc: { fill_phase_eight_intake: [{ outcome: 'what' }] } }).admin, job('p', 'project.completed'));
    assert.equal(odd.status, 'failed');
  });
  test('a replay calls the same idempotent door and changes nothing here (no state is kept by the job)', async () => {
    const script = { rows: { projects: { id: 'p' } }, rpc: { fill_phase_eight_intake: [{ outcome: 'already_started' }] } };
    const a = await handleFillPhaseEightIntake(stubAdmin(script).admin, job('p', 'project.completed'));
    const b = await handleFillPhaseEightIntake(stubAdmin(script).admin, job('p', 'project.completed'));
    assert.deepEqual(a, b);
  });
});

describe('P703: the Orchestrator records where a Phase 7 task would go, and today it is HELD', () => {
  const plan = { id: 'plan-1', project_id: 'proj-1', commit_ref: 'abc1234', artifact_sha256: 'a'.repeat(64) };
  const base = { rows: { p7_deployment_plans: plan, phase_seven: { state: 'waiting_deployment_approval' } }, agents: DISABLED };

  test('an approved deployment is recorded as HELD (agent disabled) with the explained candidates and the envelope', async () => {
    const { admin, calls } = stubAdmin({ ...base, rpc: { p7_deployment_approved: true, record_phase_seven_routing: [{ outcome: 'recorded', decision_id: 'd' }] } });
    const result = await handleRoutePhaseSevenTask(admin, job('plan-1', 'project.deployment_approved'));
    assert.equal(result.status, 'succeeded');
    assert.equal(result.status === 'succeeded' && result.outcome, 'held:agent_disabled');
    const record = calls.find((c) => c.fn === 'record_phase_seven_routing');
    assert.equal(record?.args.p_organization_id, 'org-1');
    assert.equal(record?.args.p_project_id, 'proj-1');
    assert.equal(record?.args.p_task_type, 'deployment_execution');
    assert.equal(record?.args.p_decision_key, 'project.deployment_approved:plan-1');
    assert.equal(record?.args.p_outcome, 'held');
    assert.equal(record?.args.p_to_agent, 'deployment_agent');
    assert.equal(record?.args.p_subject_id, 'plan-1');
    assert.equal((record?.args.p_envelope as { planId: string }).planId, 'plan-1');
    assert.equal(((record?.args.p_candidates as { agent: string; rejected: string | null }[]).find((c) => c.agent === 'deployment_agent'))?.rejected, 'installed but not enabled');
  });
  test('the project, commit and artifact come from the ROW, never from the event payload', async () => {
    const { admin, calls, reads } = stubAdmin({ ...base, rpc: { p7_deployment_approved: true, record_phase_seven_routing: [{ outcome: 'recorded' }] } });
    await handleRoutePhaseSevenTask(admin, { id: 'j', organization_id: 'org-1', correlation_id: null, payload: { eventType: 'project.deployment_approved', subjectId: 'plan-1', projectId: 'FORGED', commitRef: 'FORGED' } } as never);
    const record = calls.find((c) => c.fn === 'record_phase_seven_routing');
    assert.equal(record?.args.p_project_id, 'proj-1');
    assert.equal((record?.args.p_envelope as { candidate: { commitRef: string } }).candidate.commitRef, 'abc1234');
    assert.deepEqual(reads[0]?.filters, [['id', 'plan-1'], ['organization_id', 'org-1']]);
  });
  test('a deployment whose approval no longer holds is held for that, before the agent is asked about', async () => {
    const { admin, calls } = stubAdmin({ ...base, rpc: { p7_deployment_approved: false, record_phase_seven_routing: [{ outcome: 'recorded' }] } });
    const r = await handleRoutePhaseSevenTask(admin, job('plan-1', 'project.deployment_approved'));
    assert.equal(r.status === 'succeeded' && r.outcome, 'held:plan_not_approved');
    assert.equal(calls.find((c) => c.fn === 'record_phase_seven_routing')?.args.p_outcome, 'held');
  });
  test('a failed validation is incident triage, held for the disabled Incident agent; the subject is the DEPLOYMENT row', async () => {
    const { admin, calls, reads } = stubAdmin({ rows: { p7_deployments: { id: 'dep-1', project_id: 'proj-1', commit_ref: 'abc1234', artifact_sha256: 'a'.repeat(64) }, phase_seven: { state: 'post_deployment_validation' } }, agents: DISABLED, rpc: { record_phase_seven_routing: [{ outcome: 'recorded' }] } });
    const r = await handleRoutePhaseSevenTask(admin, job('dep-1', 'project.production_validation_failed'));
    assert.equal(r.status === 'succeeded' && r.outcome, 'held:agent_disabled');
    assert.equal(reads[0]?.table, 'p7_deployments');
    assert.equal(calls.find((c) => c.fn === 'record_phase_seven_routing')?.args.p_to_agent, 'incident_recovery');
    assert.ok(!calls.some((c) => c.fn === 'p7_deployment_approved'), 'no approval is read for an incident');
  });
  test('a completed project is REFUSED, recorded with no agent and no envelope', async () => {
    const { admin, calls } = stubAdmin({ rows: { p7_deployments: { id: 'dep-1', project_id: 'proj-1', commit_ref: 'c', artifact_sha256: 'a' }, phase_seven: { state: 'completed' } }, agents: DISABLED, rpc: { record_phase_seven_routing: [{ outcome: 'recorded' }] } });
    const r = await handleRoutePhaseSevenTask(admin, job('dep-1', 'project.deployment_failed'));
    assert.equal(r.status === 'succeeded' && r.outcome, 'refused:project_completed');
    const record = calls.find((c) => c.fn === 'record_phase_seven_routing');
    assert.equal(record?.args.p_to_agent, null);
    assert.equal(record?.args.p_envelope, null);
  });
  test('a replayed event records nothing twice (the decision key is the event and its subject)', async () => {
    const { admin } = stubAdmin({ ...base, rpc: { p7_deployment_approved: true, record_phase_seven_routing: [{ outcome: 'already_recorded' }] } });
    const r = await handleRoutePhaseSevenTask(admin, job('plan-1', 'project.deployment_approved'));
    assert.equal(r.status, 'succeeded');
    assert.match(r.detail, /already recorded/);
  });
  test('an event that is not a routable Phase 7 task, or a subject of another organization, is not routed', async () => {
    const other = await handleRoutePhaseSevenTask(stubAdmin({ ...base, rpc: {} }).admin, job('plan-1', 'project.completed'));
    assert.equal(other.status === 'failed' && other.permanent, true);
    const gone = await handleRoutePhaseSevenTask(stubAdmin({ rows: {}, agents: DISABLED, rpc: {} }).admin, job('x', 'project.deployment_approved'));
    assert.equal(gone.status === 'succeeded' && gone.outcome, 'gone');
  });
  test('the database refusing a decision is a PERMANENT failure to surface (the rule and the door disagree), never a retry into a pass', async () => {
    const { admin } = stubAdmin({ ...base, rpc: { p7_deployment_approved: true, record_phase_seven_routing: [{ outcome: 'agent_not_enabled' }] } });
    const r = await handleRoutePhaseSevenTask(admin, job('plan-1', 'project.deployment_approved'));
    assert.equal(r.status === 'failed' && r.permanent, true);
  });
  test('a database that does not answer is a retryable failure; the handler never calls a start, approval, validation or completion door', async () => {
    const { admin, calls } = stubAdmin({ ...base, rpc: { p7_deployment_approved: true }, rpcError: ['record_phase_seven_routing'] });
    const r = await handleRoutePhaseSevenTask(admin, job('plan-1', 'project.deployment_approved'));
    assert.equal(r.status === 'failed' && r.permanent, false);
    assert.ok(!calls.some((c) => /request_deployment|progress|validation_run|complete|^approve|decide/.test(c.fn)), calls.map((c) => c.fn).join(','));
  });
});

describe('P711: the retention sweep rides the cron tick, marks only, and deletes nothing', () => {
  const sweepAdmin = (script: { data?: unknown; error?: { message: string } | null; throws?: boolean }) => {
    const calls: Call[] = [];
    const admin = {
      schema: (schema: string) => ({
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn: schema + '.' + fn, args });
          if (script.throws) throw new Error('network down');
          return { data: script.data ?? null, error: script.error ?? null };
        },
      }),
    };
    return { admin: admin as never, calls };
  };
  test('it calls the one runner door and reports how many records were marked eligible for review', async () => {
    const { admin, calls } = sweepAdmin({ data: [{ outcome: 'swept', marked: 3 }] });
    assert.deepEqual(await sweepRetentionReviews(admin), { marked: 3 });
    assert.deepEqual(calls.map((c) => c.fn), ['projects.sweep_retention_reviews']);
  });
  test('a failure is logged and swallowed (best effort), and is never read as "nothing was due"', async () => {
    assert.equal(await sweepRetentionReviews(sweepAdmin({ error: { message: 'boom' } }).admin), null);
    assert.equal(await sweepRetentionReviews(sweepAdmin({ data: [{ outcome: 'not_authorized', marked: 0 }] }).admin), null);
    assert.equal(await sweepRetentionReviews(sweepAdmin({ throws: true }).admin), null);
  });
  test('the cron tick calls it, beside its sibling sweeps, after the cron secret is checked', () => {
    const route = readFileSync(new URL('../app/api/jobs/run/route.ts', import.meta.url), 'utf8');
    const finance = route.indexOf('await sweepFinanceExceptions(admin);');
    const retention = route.indexOf('await sweepRetentionReviews(admin);');
    assert.ok(finance > 0 && retention > finance, 'the retention sweep is called after the finance sweep');
    assert.ok(route.indexOf('authorizeCronRequest') < retention, 'after the cron request is authorized');
  });
});
