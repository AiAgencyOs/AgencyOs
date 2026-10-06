import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { buildExecutionEnvelope, decideDevelopmentRoute, decideIndependentReviewer, FAILURE_CLASSES, handleExecutionFailure } from '../src/modules/orchestrator/development-route.ts';

/** Phase 5 Orchestrator spec: capability matching, eligibility (disabled / NOT_REQUIRED), creator != validator, and reachability. */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const allOff = new Map<string, boolean>();
const on = (...keys: string[]) => new Map(keys.map((k) => [k, true] as const));
const none = new Map<string, string>();

describe('decideDevelopmentRoute', () => {
  test('a task with no specialist is refused, not guessed', () => {
    const r = decideDevelopmentRoute({ requiredCapability: null, enabled: allOff, agentState: none });
    assert.equal(r.outcome, 'refused');
  });
  test('a value that is not a development specialist cannot be routed to (a model cannot name its own route)', () => {
    for (const key of ['finance', 'quality_assurance', 'orchestrator', 'sales', 'made_up']) {
      const r = decideDevelopmentRoute({ requiredCapability: key, enabled: on(key), agentState: none });
      assert.equal(r.outcome, 'refused', key);
    }
  });
  test('an installed-but-disabled specialist HOLDS the task with the reason; it is not routed as if it ran', () => {
    const r = decideDevelopmentRoute({ requiredCapability: 'backend_developer', enabled: allOff, agentState: none });
    assert.deepEqual([r.outcome, 'code' in r ? r.code : null], ['held', 'agent_disabled']);
  });
  test('a specialist recorded NOT_REQUIRED holds the task even when enabled', () => {
    const r = decideDevelopmentRoute({ requiredCapability: 'mobile_developer', enabled: on('mobile_developer'), agentState: new Map([['mobile_developer', 'not_required']]) });
    assert.deepEqual([r.outcome, 'code' in r ? r.code : null], ['held', 'not_required']);
  });
  test('an enabled, required specialist is routed', () => {
    const r = decideDevelopmentRoute({ requiredCapability: 'frontend_developer', enabled: on('frontend_developer'), agentState: new Map([['frontend_developer', 'required']]) });
    assert.equal(r.outcome, 'routed');
  });
});

describe('decideIndependentReviewer: creator != validator', () => {
  test('a developer is reviewed by security_review and verified by quality_assurance', () => {
    const r = decideIndependentReviewer('backend_developer');
    assert.deepEqual([r.reviewer, r.verifier], ['security_review', 'quality_assurance']);
  });
  test('security_review never reviews its own work', () => {
    const r = decideIndependentReviewer('security_review');
    assert.equal(r.reviewer, null);
    assert.equal(r.verifier, 'quality_assurance');
  });
  test('an unknown agent gets no reviewer', () => {
    assert.equal(decideIndependentReviewer('nobody').reviewer, null);
  });
});

describe('the routing is reachable', () => {
  test('an approved plan emits an event the Orchestrator acts on, through a registered handler and job kind', () => {
    assert.deepEqual((SUBSCRIPTIONS as Record<string, readonly string[]>)['project.development_plan_approved'], ['orchestrator:routeDevelopmentPlan']);
    assert.ok((HANDLERS as readonly string[]).includes('orchestrator:routeDevelopmentPlan'));
    assert.equal((HANDLER_JOB_KIND as Record<string, string>)['orchestrator:routeDevelopmentPlan'], 'development.route_plan');
    assert.match(read('app/api/jobs/run/route.ts'), /handleRouteDevelopmentPlan/);
    assert.match(read('supabase/migrations/20261031240000_an_approved_plan_is_routed_to_its_specialists.sql'), /'project\.development_plan_approved'/);
  });
  test('the handler is idempotent and re-reads the plan', () => {
    const handler = read('src/modules/orchestrator/handlers.ts');
    assert.match(handler, /if \(already\.has\(task\.id\)\) continue;/);
    assert.match(handler, /plan\.status !== 'approved'/);
  });
});


describe('failure handling: a retry never repeats a side effect', () => {
  test('transient failures retry safely until the budget is gone, then escalate', () => {
    for (const f of ['transient_provider_error', 'timeout', 'rate_limit'] as const) {
      assert.deepEqual(handleExecutionFailure(f, 1, 3), { retry: 'safe', fallback: true, escalate: false });
      assert.deepEqual(handleExecutionFailure(f, 3, 3), { retry: 'never', fallback: true, escalate: true });
    }
  });
  test('an uncertain side effect is reconciled, never blindly retried, and never falls back', () => {
    assert.deepEqual(handleExecutionFailure('side_effect_uncertain', 1, 3), { retry: 'after_reconcile', fallback: false, escalate: true });
  });
  test('a permission or guard refusal is never retried and never worked around by a fallback', () => {
    for (const f of ['permission_denied', 'business_guard_failure', 'no_capable_route'] as const) {
      const h = handleExecutionFailure(f, 1, 3);
      assert.deepEqual([h.retry, h.fallback, h.escalate], ['never', false, true], f);
    }
  });
  test('every class is handled', () => {
    for (const f of FAILURE_CLASSES) assert.ok(handleExecutionFailure(f, 1, 2));
  });
});

describe('the execution envelope', () => {
  const env = buildExecutionEnvelope({ task: { id: 't1', title: 'Pay API', acceptanceCriteria: 'returns 200' }, planId: 'p1', organizationId: 'o1', projectId: 'pr1', baselineId: 'b1', destination: 'backend_developer', routingReason: 'plan' });
  test('it carries the ids, the criteria, the retry budget and an idempotency key', () => {
    assert.equal(env.idempotencyKey, 't1:p1:1');
    assert.equal(env.acceptanceCriteria, 'returns 200');
    assert.equal(env.retryBudget, 3);
    assert.equal(env.sourceActor, 'orchestrator');
  });
  test('tool permissions are exactly what the registry binds: a specialist holds none today', () => {
    assert.deepEqual(env.toolPermissions, []);
  });
  test('the handler records the envelope on the handoff it writes', () => {
    assert.match(read('src/modules/orchestrator/handlers.ts'), /envelope: JSON\.parse\(JSON\.stringify\(buildExecutionEnvelope\(/);
  });
});
