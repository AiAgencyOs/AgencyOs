import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { definitionFor, mayHandOff } from '../src/modules/agents/registry.ts';
import {
  authorizePhaseSevenTool,
  buildPhaseSevenEnvelope,
  decidePhaseSevenRoute,
  PHASE_SEVEN_TASK_TYPES,
  phaseSevenAgentStatus,
  phaseSevenPolicyVersion,
  phaseSevenRetryPolicy,
  routePhaseSevenFailure,
  taskTypeForEvent,
  TASK_OWNER,
  validatePhaseSevenEnvelope,
} from '../src/modules/orchestrator/phase-seven-route.ts';

/**
 * P703: the Orchestrator's Phase 7 routing, as pure rules. Every Phase 7 agent is installed disabled and holds no tool, so today an agent-bound task is HELD
 * with the reason stated; these tests also prove what WOULD route once an owner enables an agent, binds a tool and grants the elevated permission.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const OFF = new Map<string, boolean>([['deployment_agent', false], ['release_qa', false], ['incident_recovery', false]]);
const ON = new Map<string, boolean>([['deployment_agent', true], ['release_qa', true], ['incident_recovery', true]]);

describe('the Orchestrator has a declared route to the three Phase 7 agents, and only those were added', () => {
  test('mayHandOff(orchestrator, X) for deployment_agent, release_qa, incident_recovery', () => {
    for (const a of ['deployment_agent', 'release_qa', 'incident_recovery']) assert.equal(mayHandOff('orchestrator', a), true, a);
  });
  test('the three agents themselves still hand off only to QA', () => {
    for (const a of ['deployment_agent', 'release_qa', 'incident_recovery']) assert.deepEqual(definitionFor(a)?.handoffTargets, ['quality_assurance']);
  });
  test('the Orchestrator does not list the PM or Finance: they act through events and doors, not handoffs', () => {
    assert.equal(mayHandOff('orchestrator', 'project_manager'), false);
    assert.equal(mayHandOff('orchestrator', 'finance'), false);
  });
  test('the database mirror (the roster migrations) carries exactly the same three edges', () => {
    const dir = `${root}supabase/migrations`;
    const sql = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n');
    const pairs = [...sql.matchAll(/insert into ai\.agent_handoff_targets[\s\S]*?;/g)].flatMap((b) => [...b[0].matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map((p) => `${p[1]}>${p[2]}`));
    for (const a of ['deployment_agent', 'release_qa', 'incident_recovery']) assert.ok(pairs.includes(`orchestrator>${a}`), a);
  });
});

describe('a task type has exactly one owner and validation is never the deployer', () => {
  test('every task type has an owner; the three agents own disjoint work', () => {
    for (const t of PHASE_SEVEN_TASK_TYPES) assert.ok(TASK_OWNER[t], t);
    assert.equal(TASK_OWNER.deployment_execution.agent, 'deployment_agent');
    assert.equal(TASK_OWNER.smoke_validation.agent, 'release_qa');
    assert.notEqual(TASK_OWNER.smoke_validation.agent, TASK_OWNER.deployment_execution.agent);
    assert.equal(TASK_OWNER.incident_triage.agent, 'incident_recovery');
  });
  test('the PM and Finance are event handlers, never agent handoffs', () => {
    assert.equal(TASK_OWNER.client_update.via, 'event_handler');
    assert.equal(TASK_OWNER.financial_clearance_review.via, 'event_handler');
  });
});

describe('the decision: held when disabled, with every candidate explained', () => {
  test('a disabled Deployment agent holds an approved deployment, and says so', () => {
    const r = decidePhaseSevenRoute('deployment_execution', { enabled: OFF, workspaceState: 'waiting_deployment_approval', planApproved: true });
    assert.equal(r.outcome, 'held');
    assert.equal(r.code, 'agent_disabled');
    assert.equal(r.toAgent, 'deployment_agent');
    assert.match(r.reason, /not enabled/);
    const chosen = r.candidates.find((c) => c.agent === 'deployment_agent');
    assert.equal(chosen?.eligible, false);
    assert.equal(chosen?.rejected, 'installed but not enabled');
    assert.equal(r.candidates.find((c) => c.agent === 'release_qa')?.rejected, 'another specialist owns this task type');
  });
  test('an enabled agent that holds no tool is still held: production tools need an owner decision', () => {
    const r = decidePhaseSevenRoute('deployment_execution', { enabled: ON, workspaceState: 'waiting_deployment_approval', planApproved: true });
    assert.equal(r.outcome, 'held');
    assert.equal(r.code, 'tool_not_bound');
    assert.deepEqual(r.missingTools, ['deploy_artifact', 'run_migration']);
  });
  test('today NO agent-bound task routes: the registry binds no tool to any Phase 7 agent', () => {
    for (const t of PHASE_SEVEN_TASK_TYPES.filter((x) => TASK_OWNER[x].via === 'agent')) {
      const r = decidePhaseSevenRoute(t, { enabled: ON, workspaceState: 'deploying', planApproved: true, rollbackApproved: true });
      assert.notEqual(r.outcome, 'routed', t);
    }
  });
  test('a deployment is held without a live approval, before anything about the agent matters', () => {
    for (const planApproved of [false, null, undefined]) {
      const r = decidePhaseSevenRoute('deployment_execution', { enabled: ON, workspaceState: 'waiting_deployment_approval', planApproved });
      assert.equal(r.outcome, 'held');
      assert.equal(r.code, 'plan_not_approved');
    }
  });
  test('a rollback is held until an Admin approved it', () => {
    const r = decidePhaseSevenRoute('rollback_coordination', { enabled: ON, workspaceState: 'deployment_failed', rollbackApproved: false });
    assert.equal(r.code, 'rollback_not_approved');
  });
  test('a project outside the pipeline is held; a completed project is REFUSED (new work is a change request)', () => {
    assert.equal(decidePhaseSevenRoute('readiness_review', { enabled: ON, workspaceState: null }).code, 'phase_seven_not_active');
    for (const s of ['completed', 'phase8_ready']) {
      const r = decidePhaseSevenRoute('deployment_execution', { enabled: ON, workspaceState: s, planApproved: true });
      assert.equal(r.outcome, 'refused');
      assert.equal(r.code, 'project_completed');
      assert.equal(r.toAgent, null);
    }
  });
  test('an unknown task type is refused, never defaulted to an agent', () => {
    const r = decidePhaseSevenRoute('deploy_everything', { enabled: ON, workspaceState: 'deploying' });
    assert.equal(r.outcome, 'refused');
    assert.equal(r.code, 'unknown_task');
  });
  test('the PM and Finance tasks are EVENT_HANDLED, whatever the agents say', () => {
    for (const t of ['client_update', 'financial_clearance_review'] as const) {
      const r = decidePhaseSevenRoute(t, { enabled: OFF, workspaceState: 'handover_ready' });
      assert.equal(r.outcome, 'event_handled');
      assert.equal(r.toAgent, TASK_OWNER[t].agent);
    }
  });
  test('a task ROUTES only with every gate: a live approval, an enabled agent, the tool bound, and the Admin grant for a production tool', () => {
    const equipped = (agent: string) => (agent === 'deployment_agent' ? ['deploy_artifact', 'run_migration'] : []);
    const grants = new Set(['deploy_artifact', 'run_migration']);
    const ok = decidePhaseSevenRoute('deployment_execution', { enabled: ON, workspaceState: 'waiting_deployment_approval', planApproved: true, toolsFor: equipped, elevatedGrants: grants });
    assert.equal(ok.outcome, 'routed');
    assert.equal(ok.toAgent, 'deployment_agent');
    assert.equal(ok.candidates.find((c) => c.agent === 'deployment_agent')?.eligible, true);
    // each missing gate holds it, in this order
    assert.equal(decidePhaseSevenRoute('deployment_execution', { enabled: ON, workspaceState: 'waiting_deployment_approval', planApproved: false, toolsFor: equipped, elevatedGrants: grants }).code, 'plan_not_approved');
    assert.equal(decidePhaseSevenRoute('deployment_execution', { enabled: OFF, workspaceState: 'waiting_deployment_approval', planApproved: true, toolsFor: equipped, elevatedGrants: grants }).code, 'agent_disabled');
    assert.equal(decidePhaseSevenRoute('deployment_execution', { enabled: ON, workspaceState: 'waiting_deployment_approval', planApproved: true, toolsFor: () => [], elevatedGrants: grants }).code, 'tool_not_bound');
    const noGrant = decidePhaseSevenRoute('deployment_execution', { enabled: ON, workspaceState: 'waiting_deployment_approval', planApproved: true, toolsFor: equipped });
    assert.equal(noGrant.code, 'elevated_permission_missing');
    assert.deepEqual(noGrant.missingTools, ['deploy_artifact', 'run_migration']);
  });
  test('validation is routed to QA/Release and never to the agent that deployed', () => {
    const equipped = () => ['run_smoke_check'];
    const r = decidePhaseSevenRoute('smoke_validation', { enabled: ON, workspaceState: 'post_deployment_validation', toolsFor: equipped, elevatedGrants: new Set(['run_smoke_check']) });
    assert.equal(r.outcome, 'routed');
    assert.equal(r.toAgent, 'release_qa');
  });
});

describe('tool authorization: the registry binding is the ceiling', () => {
  test('a tool that is not bound is refused even with a grant', () => {
    const r = authorizePhaseSevenTool({ agent: 'release_qa', tool: 'run_smoke_check', grants: new Set(['run_smoke_check']) });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /not bound/);
  });
  test('an unknown agent is refused', () => {
    assert.equal(authorizePhaseSevenTool({ agent: 'nobody', tool: 'x' }).allowed, false);
  });
});

describe('the execution envelope', () => {
  const base = { taskType: 'deployment_execution' as const, organizationId: 'org-1', projectId: 'proj-1', planId: 'plan-1', subjectId: 'plan-1', candidate: { commitRef: 'abc1234', artifactSha256: 'a'.repeat(64) }, routingReason: 'x' };
  test('a deployment envelope names the plan, the exact commit and artifact, production, the forbidden actions and the independent verifier', () => {
    const e = buildPhaseSevenEnvelope(base);
    assert.equal(e.destination, 'deployment_agent');
    assert.equal(e.environment, 'production');
    assert.equal(e.planId, 'plan-1');
    assert.equal(e.independentVerifier, 'quality_assurance');
    assert.ok(e.forbiddenActions.includes('approve its own deployment or any plan'));
    assert.ok(e.forbiddenActions.includes('declare production validated'));
    assert.deepEqual(e.toolPermissions, []);
    assert.deepEqual(e.elevatedPermissions, []);
    assert.equal(e.retryBudget, 1);
    assert.deepEqual(validatePhaseSevenEnvelope(e), []);
  });
  test('the idempotency key is the task and its subject: a duplicate event is the same key', () => {
    assert.equal(buildPhaseSevenEnvelope(base).idempotencyKey, buildPhaseSevenEnvelope(base).idempotencyKey);
    assert.notEqual(buildPhaseSevenEnvelope(base).idempotencyKey, buildPhaseSevenEnvelope({ ...base, attempt: 2 }).idempotencyKey);
  });
  test('an elevated permission is never granted for a tool the agent does not hold', () => {
    const e = buildPhaseSevenEnvelope({ ...base, elevatedGrants: new Set(['deploy_artifact']) });
    assert.deepEqual(e.elevatedPermissions, []);
  });
  test('REJECTED, not repaired: no plan, no commit, a tool the registry did not bind, an elevated permission without the tool, a secret', () => {
    const e = buildPhaseSevenEnvelope(base);
    assert.match(validatePhaseSevenEnvelope({ ...e, planId: null }).join('|'), /names its approved plan/);
    assert.match(validatePhaseSevenEnvelope({ ...e, candidate: { commitRef: null, artifactSha256: null } }).join('|'), /exact commit and artifact/);
    assert.match(validatePhaseSevenEnvelope({ ...e, toolPermissions: ['deploy_artifact'] }).join('|'), /did not bind/);
    assert.match(validatePhaseSevenEnvelope({ ...e, elevatedPermissions: ['deploy_artifact'] }).join('|'), /elevated permission/);
    const fake = `sk-${'a'.repeat(24)}`;
    assert.match(validatePhaseSevenEnvelope({ ...e, routingReason: `use ${fake}` }).join('|'), /secret/);
    assert.match(validatePhaseSevenEnvelope({ ...e, destination: 'release_qa' }).join('|'), /does not own this task type/);
    assert.match(validatePhaseSevenEnvelope({ ...e, forbiddenActions: [] }).join('|'), /forbidden-action/);
  });
  test('the policy version is the registry revision', () => {
    assert.match(phaseSevenPolicyVersion(), /^registry-/);
  });
});

describe('failure routing and bounded retries', () => {
  test('infrastructure and configuration go to the Deployment agent; a code defect needs a NEW candidate, never a deploy retry', () => {
    assert.equal(routePhaseSevenFailure('config').route, 'deployment_agent');
    assert.equal(routePhaseSevenFailure('provider').route, 'deployment_agent');
    const code = routePhaseSevenFailure('code');
    assert.equal(code.route, 'new_candidate_required');
    assert.equal(code.task, null);
    assert.equal(routePhaseSevenFailure('rollback').route, 'incident_recovery');
    assert.equal(routePhaseSevenFailure('unclassified').task, 'incident_triage');
  });
  test('a deployment side effect is never blindly retried; a refusal is never retried', () => {
    assert.equal(phaseSevenRetryPolicy('deployment_execution', 'deployment_failed', 1).retry, 'after_reconcile');
    assert.equal(phaseSevenRetryPolicy('deployment_execution', 'side_effect_uncertain', 1).retry, 'after_reconcile');
    assert.equal(phaseSevenRetryPolicy('deployment_execution', 'permission_denied', 1).retry, 'never');
    assert.equal(phaseSevenRetryPolicy('smoke_validation', 'validation_failed', 1).retry, 'never');
  });
  test('a transient failure retries within the bound and then escalates; a deployment has a budget of one', () => {
    assert.equal(phaseSevenRetryPolicy('health_check', 'timeout', 1).retry, 'safe');
    assert.equal(phaseSevenRetryPolicy('health_check', 'timeout', 2).retry, 'never');
    assert.equal(phaseSevenRetryPolicy('health_check', 'timeout', 2).escalate, true);
    assert.equal(phaseSevenRetryPolicy('deployment_execution', 'timeout', 1).retry, 'never');
  });
});

describe('events as routable work', () => {
  test('deployment approval is a deployment task; a deployment or validation failure is incident triage; nothing else routes', () => {
    assert.equal(taskTypeForEvent('project.deployment_approved'), 'deployment_execution');
    assert.equal(taskTypeForEvent('project.deployment_failed'), 'incident_triage');
    assert.equal(taskTypeForEvent('project.production_validation_failed'), 'incident_triage');
    assert.equal(taskTypeForEvent('project.completed'), null);
    assert.equal(taskTypeForEvent('project.production_validated'), null);
  });
  test('the status read says why each agent cannot take work today', () => {
    const s = phaseSevenAgentStatus(OFF);
    assert.equal(s.length, 3);
    for (const a of s) {
      assert.equal(a.enabled, false);
      assert.equal(a.tools, 0);
      assert.equal(a.hasRoute, true);
    }
  });
});
