import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, mock, test } from 'node:test';

import { planRoute, type ModelSnapshot, type ProviderSnapshot, type RouteInput } from '../src/lib/ai/route-plan.ts';

mock.module('server-only', { exports: {} });
mock.module('@/lib/env', { exports: { serverEnv: () => ({}) } });
const { costMinorFor, requiredCapabilitiesFor } = await import('../src/lib/ai/routing-config.ts');

const read = (p: string) => readFileSync(p, 'utf8');
const migration = read('supabase/migrations/20261013200000_routing_is_a_mode_and_every_decision_is_recorded.sql');

// ── fixtures ────────────────────────────────────────────────────────────────

const provider = (id: string, over: Partial<ProviderSnapshot> = {}, prefix = `${id}-`): ProviderSnapshot => ({
  id, enabled: true, archived: false, health: 'healthy', hasUsableKey: true, priority: 100, supports: (m) => m.startsWith(prefix), ...over,
});
const model = (id: string, providerId: string, over: Partial<ModelSnapshot> = {}): ModelSnapshot => ({
  modelId: id, provider: providerId, enabled: true, status: 'available', capabilities: [], toolCalling: null, structuredOutput: null, qualityTier: null, latencyTier: null, costTier: null, ...over,
});
const base = (over: Partial<RouteInput> = {}): RouteInput => ({
  mode: 'auto', configVersion: 3, agentKey: 'developer', agentDefault: 'a-default',
  routing: { override: null, policy: null, fallbackChain: [] },
  assignment: null,
  providers: [provider('a', { priority: 10 }), provider('b', { priority: 20 }), provider('c', { priority: 30 })],
  models: [model('a-default', 'a'), model('b-fast', 'b'), model('c-big', 'c')],
  needsTools: false, requiredCapabilities: [], optimiseFor: null, ...over,
});
const ids = (plan: ReturnType<typeof planRoute>) => plan.candidates.map((c) => `${c.providerId}/${c.model}`);

describe('AUTO: the orchestrator chooses, but only from what the Admin allowed', () => {
  test('SCENARIO 1: a disabled provider is never considered; models come from the active ones', () => {
    const plan = planRoute(base({ providers: [provider('a'), provider('b'), provider('c', { enabled: false })] }));
    assert.ok(!ids(plan).some((x) => x.startsWith('c/')), ids(plan).join());
    assert.equal(plan.considered.find((c) => c.model === 'c-big')?.excluded, 'provider c is disabled');
    assert.deepEqual(ids(plan), ['a/a-default', 'b/b-fast']);
  });

  test('a disabled model is never chosen, even when it is the agent\'s own default or the Admin listed it', () => {
    const plan = planRoute(base({ models: [model('a-default', 'a', { enabled: false }), model('b-fast', 'b')], routing: { override: { preferredModels: ['a-default'] }, policy: null, fallbackChain: [] } }));
    assert.ok(!ids(plan).includes('a/a-default'));
    assert.equal(plan.considered.find((c) => c.model === 'a-default')?.excluded, 'model a-default is disabled');
    assert.ok(ids(plan).includes('b/b-fast'), 'an enabled model of another provider serves instead');
  });

  test('the Admin\'s own preferences keep their order and come first; the rest follow, ranked', () => {
    const plan = planRoute(base({
      routing: { override: { preferredModels: ['c-big'] }, policy: { adminOverrideModel: 'b-fast', preferredModels: [] }, fallbackChain: [] },
      models: [model('a-default', 'a'), model('b-fast', 'b', { qualityTier: 2 }), model('c-big', 'c', { qualityTier: 5 }), model('a-extra', 'a', { qualityTier: 5 }), model('b-extra', 'b', { qualityTier: 1 })],
    }));
    assert.deepEqual(ids(plan).slice(0, 3), ['c/c-big', 'b/b-fast', 'a/a-default'], 'override, then policy override, then the default');
    assert.deepEqual(ids(plan).slice(3), ['a/a-extra', 'b/b-extra'], 'then other enabled models: best-rated first');
    assert.equal(plan.candidates[0]?.source, 'agent_override');
    assert.equal(plan.candidates[3]?.source, 'auto_ranked');
  });

  test('unrated models rank after rated ones - a rating is never guessed', () => {
    const plan = planRoute(base({ models: [model('a-default', 'a'), model('b-unrated', 'b'), model('b-rated', 'b', { qualityTier: 1 })] }));
    assert.deepEqual(ids(plan), ['a/a-default', 'b/b-rated', 'b/b-unrated']);
  });

  test('"optimise for cost" ranks by the Admin\'s cost rating, cheapest first', () => {
    const plan = planRoute(base({ optimiseFor: 'cost', models: [model('a-default', 'a'), model('b-pricey', 'b', { costTier: 5 }), model('b-cheap', 'b', { costTier: 1 })] }));
    assert.deepEqual(ids(plan).slice(1), ['b/b-cheap', 'b/b-pricey']);
  });

  test('a provider known to reject its keys, or out of quota, is left out; one that is merely rate limited is kept but last', () => {
    const plan = planRoute(base({
      providers: [provider('a', { priority: 10, health: 'auth_error' }), provider('b', { priority: 20, health: 'rate_limited' }), provider('c', { priority: 30, health: 'healthy' })],
      routing: { override: { preferredModels: ['b-fast'] }, policy: null, fallbackChain: [] },
    }));
    assert.ok(!ids(plan).some((x) => x.startsWith('a/')));
    assert.equal(plan.considered.find((c) => c.model === 'a-default')?.excluded, 'provider a is auth error');
    assert.deepEqual(ids(plan), ['c/c-big', 'b/b-fast'], 'healthy first even though the Admin listed the rate-limited one first');
  });

  test('a provider with no usable key, and an archived one, are excluded with their reason', () => {
    const plan = planRoute(base({ providers: [provider('a', { hasUsableKey: false }), provider('b', { archived: true }), provider('c')] }));
    assert.deepEqual(ids(plan), ['c/c-big']);
    assert.equal(plan.considered.find((c) => c.providerId === 'a')?.excluded, 'provider a has no usable key');
    assert.equal(plan.considered.find((c) => c.providerId === 'b')?.excluded, 'provider b is archived');
  });

  test('a recorded capability the model lacks excludes it; an unrecorded one never does', () => {
    const plan = planRoute(base({
      requiredCapabilities: ['coding'],
      models: [model('a-default', 'a'), model('b-text', 'b', { capabilities: ['reasoning'] }), model('b-code', 'b', { capabilities: ['coding', 'reasoning'] }), model('c-unknown', 'c', { capabilities: [] })],
    }));
    assert.ok(ids(plan).includes('b/b-code') && ids(plan).includes('c/c-unknown'));
    assert.ok(!ids(plan).includes('b/b-text'));
    assert.deepEqual(requiredCapabilitiesFor('engineering'), ['coding']);
    assert.deepEqual(requiredCapabilitiesFor('design'), []);
  });

  test('a tool-using run skips a model recorded as unable to call tools', () => {
    const plan = planRoute(base({ needsTools: true, models: [model('a-default', 'a', { toolCalling: false }), model('b-fast', 'b', { toolCalling: true })] }));
    assert.deepEqual(ids(plan), ['b/b-fast']);
  });

  test('nothing eligible is a blocked plan with the first reason - the run does not start', () => {
    const plan = planRoute(base({ providers: [provider('a', { enabled: false }), provider('b', { enabled: false }), provider('c', { enabled: false })] }));
    assert.deepEqual(plan.candidates, []);
    assert.match(plan.blocked?.reason ?? '', /disabled/);
  });

  test('a legacy model id the Admin named that is not in the registry is still allowed (it is theirs)', () => {
    const plan = planRoute(base({ models: [], agentDefault: 'a-legacy' }));
    assert.deepEqual(ids(plan), ['a/a-legacy']);
  });
});

describe('MANUAL: the Admin\'s assignment is honoured exactly', () => {
  const assignment = { providerId: 'b', modelId: 'b-fast', fallbacks: [] as { providerId: string; modelId: string }[] };

  test('SCENARIO 3: the assigned provider and model, and no other primary', () => {
    const plan = planRoute(base({ mode: 'manual', assignment }));
    assert.deepEqual(ids(plan), ['b/b-fast']);
    assert.equal(plan.candidates[0]?.source, 'assignment');
    assert.equal(plan.blocked, null);
    assert.equal(plan.mode, 'manual');
    assert.equal(plan.configVersion, 3);
  });

  test('it ignores the Admin\'s AUTO preferences and every other model', () => {
    const plan = planRoute(base({ mode: 'manual', assignment, routing: { override: { preferredModels: ['c-big'] }, policy: null, fallbackChain: ['a-default'] } }));
    assert.deepEqual(ids(plan), ['b/b-fast']);
  });

  test('SCENARIO 4: the assigned provider is disabled - BLOCKED with the reason, nothing substituted', () => {
    const plan = planRoute(base({ mode: 'manual', assignment, providers: [provider('a'), provider('b', { enabled: false }), provider('c')] }));
    assert.deepEqual(plan.candidates, []);
    assert.match(plan.blocked?.reason ?? '', /provider b is disabled/);
    assert.match(plan.blocked?.reason ?? '', /Nothing else was substituted|nothing else was substituted/);
  });

  test('a disabled or retired assigned model blocks it; a model that is not the provider\'s own blocks it', () => {
    for (const [models, why] of [
      [[model('b-fast', 'b', { enabled: false })], /disabled/],
      [[model('b-fast', 'b', { status: 'retired' })], /retired/],
      [[model('b-fast', 'c')], /belongs to c/],
      [[], /not in the registry/],
    ] as const) {
      const plan = planRoute(base({ mode: 'manual', assignment, models: [...models] }));
      assert.equal(plan.candidates.length, 0);
      assert.match(plan.blocked?.reason ?? '', why);
    }
  });

  test('an unhealthy assigned provider is still attempted - MANUAL never routes around the Admin on health alone', () => {
    const plan = planRoute(base({ mode: 'manual', assignment, providers: [provider('a'), provider('b', { health: 'rate_limited' }), provider('c')] }));
    assert.deepEqual(ids(plan), ['b/b-fast']);
  });

  test('explicit fallbacks are used, in order, and only those', () => {
    const plan = planRoute(base({ mode: 'manual', assignment: { ...assignment, fallbacks: [{ providerId: 'c', modelId: 'c-big' }, { providerId: 'a', modelId: 'a-default' }] } }));
    assert.deepEqual(ids(plan), ['b/b-fast', 'c/c-big', 'a/a-default']);
    assert.deepEqual(plan.candidates.map((c) => c.source), ['assignment', 'assignment_fallback', 'assignment_fallback']);
  });

  test('a primary that cannot run with an explicit fallback that can: the fallback serves, and the plan says why', () => {
    const plan = planRoute(base({ mode: 'manual', assignment: { ...assignment, fallbacks: [{ providerId: 'c', modelId: 'c-big' }] }, providers: [provider('a'), provider('b', { enabled: false }), provider('c')] }));
    assert.deepEqual(ids(plan), ['c/c-big']);
    assert.equal(plan.blocked, null);
    assert.ok(plan.warnings.some((w) => /cannot run/.test(w)));
  });

  test('an unusable fallback is skipped with a warning, never promoted', () => {
    const plan = planRoute(base({ mode: 'manual', assignment: { ...assignment, fallbacks: [{ providerId: 'c', modelId: 'missing-model' }] } }));
    assert.deepEqual(ids(plan), ['b/b-fast']);
    assert.ok(plan.warnings.some((w) => /missing-model/.test(w)));
  });

  test('an agent with no assignment keeps running on its own default, and the plan warns', () => {
    const plan = planRoute(base({ mode: 'manual', assignment: null }));
    assert.deepEqual(ids(plan), ['a/a-default']);
    assert.equal(plan.candidates[0]?.source, 'agent_default_unassigned');
    assert.ok(plan.warnings.some((w) => /no assignment/.test(w)));
  });

  test('a tool-using run blocks on an assigned model recorded as unable to call tools', () => {
    const plan = planRoute(base({ mode: 'manual', assignment, needsTools: true, models: [model('b-fast', 'b', { toolCalling: false })] }));
    assert.match(plan.blocked?.reason ?? '', /does not support tool calling/);
  });
});

describe('the plan is the explanation', () => {
  test('every model looked at is listed, with why it was left out when it was', () => {
    const plan = planRoute(base({ providers: [provider('a'), provider('b', { enabled: false }), provider('c')] }));
    assert.equal(plan.considered.find((c) => c.model === 'b-fast')?.excluded, 'provider b is disabled', 'the registry model of a disabled provider is listed with the reason');
    assert.ok(plan.candidates.every((c) => c.reason.length > 0));
  });
});

describe('cost is only ever what the Admin priced', () => {
  test('a price makes a cost, rounded up; no price is 0 - never an estimate', () => {
    assert.equal(costMinorFor({ input: 300, output: 1500 }, { inputTokens: 1_000_000, outputTokens: 500_000 }), 1050);
    assert.equal(costMinorFor({ input: 300, output: 1500 }, { inputTokens: 10, outputTokens: 10 }), 1);
    assert.equal(costMinorFor(undefined, { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0);
  });
});

describe('the database holds the line', () => {
  test('only the owner changes the mode (with a reason) or an assignment, and both are audited and versioned', () => {
    for (const fn of ['set_routing_mode', 'set_agent_assignment', 'clear_agent_assignment']) {
      const start = migration.indexOf(`create or replace function ai.${fn}(`);
      const body = migration.slice(start, migration.indexOf('$$;', start));
      assert.ok(body.includes('ai._provider_actor(true)'), `${fn} is the owner's`);
      assert.match(body, /core\.record_audit/, `${fn} is audited`);
    }
    assert.match(migration, /length\(btrim\(coalesce\(p_reason, ''\)\)\) = 0 then return query select 'needs_reason'/);
  });

  test('MANUAL may only name an enabled, available model that belongs to the provider', () => {
    const start = migration.indexOf('create or replace function ai._assignment_target_ok');
    const body = migration.slice(start, migration.indexOf('$$;', start));
    assert.match(body, /provider_mismatch/);
    assert.match(body, /not v_m\.enabled or v_m\.status <> 'available'/);
  });

  test('assignments are KEPT when the mode is AUTO: switching modes touches nothing but the mode', () => {
    const start = migration.indexOf('create or replace function ai.set_routing_mode');
    const body = migration.slice(start, migration.indexOf('$$;', start));
    assert.doesNotMatch(body, /agent_model_assignments/);
  });

  test('a routing decision is history, and only the runner (service role) writes it', () => {
    assert.match(migration, /before update or delete on ai\.routing_decisions/);
    assert.match(migration, /grant execute on function ai\.record_routing_decision\([^)]*\) to service_role/);
    assert.match(migration, /revoke all on table ai\.routing_decisions from public, anon, authenticated/);
  });

  test('the run records what ACTUALLY ran, not the agent\'s default', () => {
    const start = migration.indexOf('create or replace function ai.record_routing_decision');
    const body = migration.slice(start, migration.indexOf('$$;', start));
    assert.match(body, /model = coalesce\(p_model_id, model\)/);
    assert.match(body, /provider_id = coalesce\(p_provider_id, provider_id\)/);
  });
});

describe('the runner uses the plan', () => {
  const runner = read('app/api/jobs/run/agent-run.ts');
  test('every call goes to the provider the plan chose, never one picked by the model id alone', () => {
    assert.equal((runner.match(/resolveProvider\(candidate\.model, \{ providerId: candidate\.providerId \}\)/g) ?? []).length, 2);
  });
  test('a decision is recorded when the plan blocks, and after the attempts', () => {
    assert.ok((runner.match(/outcome: 'blocked'/g) ?? []).length >= 2);
    assert.match(runner, /await recordDecision\(ctx, plan\.routing, runId, \{\s*outcome: outcome\.result\.ok \? 'succeeded'/);
  });
  test('MANUAL failures reach the Admin as an alert, never as a quiet substitution', () => {
    assert.match(runner, /plan\.mode === 'manual' && \(args\.outcome === 'blocked' \|\| args\.outcome === 'failed'/);
    assert.match(runner, /fingerprint: `router-manual:\$\{ctx\.agent\.key\}`/);
  });
  test('an unreadable routing table falls back to the routing the runner always had', () => {
    assert.match(runner, /if \(!loaded\) return legacyModelPlan\(ctx, options\)/);
  });
});
