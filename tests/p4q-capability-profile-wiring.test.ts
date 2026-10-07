import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, mock, test } from 'node:test';

import { planRoute, type ModelSnapshot, type ProviderSnapshot, type RouteInput } from '../src/lib/ai/route-plan.ts';

mock.module('server-only', { exports: {} });
mock.module('@/lib/env', { exports: { serverEnv: () => ({}) } });
const { requiredCapabilitiesFor, loadRouting } = await import('../src/lib/ai/routing-config.ts');

/**
 * W-O3: `planRoute` honours the per-agent capability profile (`projects.p4q_agent_capability_profiles.required_model_capabilities`).
 * The planner stays pure: the profile is read by `loadRouting`, merged by `requiredCapabilitiesFor`, and handed to the planner as `requiredCapabilities`.
 */
const provider = (id: string): ProviderSnapshot => ({ id, enabled: true, archived: false, health: 'healthy', hasUsableKey: true, priority: 10, supports: (m) => m.startsWith(`${id}-`) });
const model = (id: string, providerId: string, over: Partial<ModelSnapshot> = {}): ModelSnapshot => ({
  modelId: id, provider: providerId, enabled: true, status: 'available', capabilities: [], toolCalling: null, structuredOutput: null, qualityTier: null, latencyTier: null, costTier: null, ...over,
});
const input = (models: ModelSnapshot[], requiredCapabilities: readonly string[]): RouteInput => ({
  mode: 'auto', configVersion: 1, agentKey: 'ui_designer', agentDefault: 'a-default',
  routing: { override: null, policy: null, fallbackChain: [] }, assignment: null,
  providers: [provider('a')], models, needsTools: false, requiredCapabilities, optimiseFor: null,
});
const ids = (plan: ReturnType<typeof planRoute>) => plan.candidates.map((c) => c.model);

const DESIGNER = ['multimodal', 'long_context', 'structured_output'];

describe('the profile narrows what the planner will add on its own', () => {
  test('a model that records capabilities but lacks one the agent needs is not chosen, and the log says which', () => {
    const plan = planRoute(input([model('a-default', 'a'), model('a-text', 'a', { capabilities: ['reasoning', 'structured_output'] }), model('a-vision', 'a', { capabilities: DESIGNER })], DESIGNER));
    assert.deepEqual(ids(plan), ['a-default', 'a-vision']);
    assert.match(plan.considered.find((c) => c.model === 'a-text')?.excluded ?? '', /lacks multimodal, long_context/);
  });

  test('without the profile the same model is chosen (this is the line the wiring adds)', () => {
    const plan = planRoute(input([model('a-default', 'a'), model('a-text', 'a', { capabilities: ['reasoning'] })], []));
    assert.deepEqual(ids(plan), ['a-default', 'a-text']);
  });

  test('a capability nobody recorded never excludes a model', () => {
    const plan = planRoute(input([model('a-default', 'a'), model('a-unrated', 'a', { capabilities: [] })], DESIGNER));
    assert.deepEqual(ids(plan), ['a-default', 'a-unrated']);
  });

  test("structured_output and tool_calling are also satisfied by the registry's own flags", () => {
    const plan = planRoute(input([model('a-default', 'a'), model('a-flags', 'a', { capabilities: ['coding'], structuredOutput: true, toolCalling: true })], ['coding', 'tool_calling', 'structured_output']));
    assert.ok(ids(plan).includes('a-flags'));
    const lacking = planRoute(input([model('a-default', 'a'), model('a-noflags', 'a', { capabilities: ['coding'], structuredOutput: false, toolCalling: false })], ['coding', 'tool_calling', 'structured_output']));
    assert.ok(!ids(lacking).includes('a-noflags'));
  });
});

describe('the profile reaches the planner', () => {
  test('requiredCapabilitiesFor merges the category need with the profile, once each', () => {
    assert.deepEqual(requiredCapabilitiesFor('engineering', ['coding', 'structured_output']), ['coding', 'structured_output']);
    assert.deepEqual(requiredCapabilitiesFor(null, ['structured_output']), ['structured_output']);
    assert.deepEqual(requiredCapabilitiesFor('engineering'), ['coding']);
    assert.deepEqual(requiredCapabilitiesFor(null), []);
  });

  test('loadRouting reads the profile for the agent (and an unreadable profile is an empty one, not a failed run)', async () => {
    const empty = { select: () => empty, eq: () => empty, maybeSingle: () => Promise.resolve({ data: null, error: null }), then: (r: (v: unknown) => unknown) => r({ data: [], error: null }) };
    const reads: string[] = [];
    const admin = {
      schema: (name: string) => ({
        from: (table: string) => {
          reads.push(`${name}.${table}`);
          if (table === 'p4q_agent_capability_profiles') return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { required_model_capabilities: DESIGNER }, error: null }) }) }) };
          if (table === 'providers') return { select: () => Promise.resolve({ data: [], error: null }) };
          return empty;
        },
      }),
    } as never;
    const loaded = await loadRouting(admin, { organizationId: 'org', agentKey: 'ui_designer', agentDefault: 'a-default' });
    assert.ok(loaded);
    assert.deepEqual(loaded.profileCapabilities, DESIGNER);
    assert.ok(reads.includes('projects.p4q_agent_capability_profiles'));
  });

  test('the runner passes it to the planner', () => {
    const run = readFileSync(new URL('../app/api/jobs/run/agent-run.ts', import.meta.url), 'utf8');
    assert.match(run, /requiredCapabilities: requiredCapabilitiesFor\(loaded\.category, loaded\.profileCapabilities\)/);
  });
});
