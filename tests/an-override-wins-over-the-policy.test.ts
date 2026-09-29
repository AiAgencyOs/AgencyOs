import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { AGENT_CATEGORY, categoryForAgent, effectiveModel, orderModelCandidates } from '../src/lib/ai/model-choice.ts';
import { AGENT_KEYS } from '../src/modules/agents/registry.ts';
import { validateAgent } from '../src/modules/agents/validation-rules.ts';

/**
 * SCR-062 / 064 / 066 — the AI Workforce and Operations doors that bucket
 * C-1 added (docs/AGENCYOS_ADMIN_REMAINING_GAPS.md):
 *
 *   A. an owner's (agent, category) override is consulted BEFORE the
 *      category policy, and both before the agent row's default — the pure
 *      rule, so the order is proved rather than trusted
 *   B. the runner actually asks: `routedModelFor` sits in front of
 *      `resolveProvider` at both model-call sites, and the request carries
 *      the routed model
 *   C. a person's validation reuses the runtime's own rules and records,
 *      never corrects
 *   D. the migration holds the shape the conventions require, and the cancel
 *      door refuses what it must
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const MIGRATION = '../supabase/migrations/20260929210000_an_agent_is_checked_by_a_person_a_key_is_revoked_a_job_is_cancelled.sql';
const executable = read(MIGRATION)
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

// ═══════════════════════════════════════════════════════════════════════════
// A. the rule
// ═══════════════════════════════════════════════════════════════════════════

describe('A. an override wins over the policy, and the policy over the default', () => {
  test('the agent override is first, then the policy override, then the policy preference, then the default', () => {
    const candidates = orderModelCandidates({
      override: { preferredModels: ['claude-override-a', 'claude-override-b'] },
      policy: { adminOverrideModel: 'gpt-policy-override', preferredModels: ['gemini-policy-pref'] },
      agentDefault: 'claude-default',
    });
    assert.deepEqual(
      candidates.map((c) => [c.model, c.source]),
      [
        ['claude-override-a', 'agent_override'],
        ['claude-override-b', 'agent_override'],
        ['gpt-policy-override', 'policy_override'],
        ['gemini-policy-pref', 'policy_preference'],
        ['claude-default', 'agent_default'],
      ],
    );
    assert.equal(effectiveModel({ override: { preferredModels: ['claude-override-a'] }, policy: null, agentDefault: 'claude-default' }).model, 'claude-override-a');
  });

  test('with no override the policy decides; with neither, the default — exactly as the runner ran before', () => {
    assert.equal(
      effectiveModel({ override: null, policy: { adminOverrideModel: 'gpt-policy-override', preferredModels: ['x'] }, agentDefault: 'd' }).source,
      'policy_override',
    );
    assert.equal(
      effectiveModel({ override: null, policy: { adminOverrideModel: null, preferredModels: ['gemini-pref'] }, agentDefault: 'd' }).model,
      'gemini-pref',
    );
    assert.deepEqual(effectiveModel({ override: null, policy: null, agentDefault: 'd' }), { model: 'd', source: 'agent_default' });
  });

  test('a model named twice is credited to the earliest position, and blanks are dropped', () => {
    const candidates = orderModelCandidates({
      override: { preferredModels: [' same ', ''] },
      policy: { adminOverrideModel: 'same', preferredModels: ['same', 'other'] },
      agentDefault: 'same',
    });
    assert.deepEqual(
      candidates.map((c) => [c.model, c.source]),
      [
        ['same', 'agent_override'],
        ['other', 'policy_preference'],
      ],
    );
  });

  test('every defined agent has exactly one category the runner asks about, and the two preserved rows have none', () => {
    for (const key of AGENT_KEYS) {
      assert.ok(categoryForAgent(key) !== null, `${key} has no routing category`);
    }
    for (const key of Object.keys(AGENT_CATEGORY)) {
      assert.ok(AGENT_KEYS.includes(key), `AGENT_CATEGORY names "${key}", which the registry does not define`);
    }
    assert.equal(categoryForAgent('lead_qualifier'), null);
    assert.equal(categoryForAgent('proposal_drafter'), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. the runner asks
// ═══════════════════════════════════════════════════════════════════════════

describe('B. the runner consults the override before it resolves a provider', () => {
  const agentRun = read('../app/api/jobs/run/agent-run.ts');
  const routing = read('../src/lib/ai/agent-routing.ts');

  test('both model-call sites route first, then resolve, and the request carries the routed model', () => {
    const routed = agentRun.match(/routedModelFor\(ctx\.admin, ctx\.job\.organization_id, ctx\.agent\.key\)/g) ?? [];
    assert.equal(routed.length, 2, 'callModel and callModelWithTools both route');
    const requests = agentRun.match(/model: routed \?\? ctx\.agent\.default_model/g) ?? [];
    assert.equal(requests.length, 2, 'both requests carry the routed model, or the default');
    // The default path is untouched: a tenant that set nothing resolves the
    // default exactly as before, and the dispatch tests still find it.
    assert.match(agentRun, /routed \? await resolveProvider\(routed\) : await resolveProvider\(ctx\.agent\.default_model\)/);
    assert.ok(agentRun.indexOf('routedModelFor(') < agentRun.indexOf('resolveProvider(ctx.agent.default_model)'));
  });

  test('the runner-side lookup reads the override before the policy and excludes the default from its answer', () => {
    assert.ok(routing.indexOf("from('agent_routing_overrides')") < routing.indexOf("from('routing_policies')"));
    assert.match(routing, /agentDefault: ''/);
    assert.match(routing, /return null/);
    // Best effort: a routing read that fails must not fail the run.
    assert.match(routing, /catch \(error\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. a person's validation
// ═══════════════════════════════════════════════════════════════════════════

describe('C. validating an agent reuses the runtime rules and records rather than corrects', () => {
  test('a defined, stamped, well-formed agent validates ok; a drifted mirror is a problem', () => {
    const good = validateAgent(
      { key: 'developer', enabled: false, defaultModel: 'claude-x', maxSteps: 10, maxCostMinor: 1000, definitionVersion: null },
      { handoffTargets: ['quality_assurance'], verifiers: ['quality_assurance'] },
    );
    // Never stamped is a finding, and the only one here.
    assert.equal(good.outcome, 'problems');
    assert.deepEqual(good.findings.filter((f) => !f.ok).map((f) => f.check), ['revision']);

    const stamped = validateAgent(
      { key: 'developer', enabled: false, defaultModel: 'claude-x', maxSteps: 10, maxCostMinor: 1000, definitionVersion: good.revision },
      { handoffTargets: ['quality_assurance'], verifiers: ['quality_assurance'] },
    );
    assert.equal(stamped.outcome, 'ok');

    const drifted = validateAgent(
      { key: 'developer', enabled: false, defaultModel: 'claude-x', maxSteps: 10, maxCostMinor: 1000, definitionVersion: good.revision },
      { handoffTargets: ['sales'], verifiers: [] },
    );
    assert.deepEqual(drifted.findings.filter((f) => !f.ok).map((f) => f.check), ['handoffs', 'verifier']);
  });

  test('an enabled row with no definition is the G-125 failure; a disabled one is a preserved row', () => {
    assert.equal(validateAgent({ key: 'lead_qualifier', enabled: true, defaultModel: 'm', maxSteps: 1, maxCostMinor: 1, definitionVersion: null }, { handoffTargets: [], verifiers: [] }).outcome, 'problems');
    assert.equal(validateAgent({ key: 'lead_qualifier', enabled: false, defaultModel: 'm', maxSteps: 1, maxCostMinor: 1, definitionVersion: null }, { handoffTargets: [], verifiers: [] }).outcome, 'ok');
  });

  test('the service never writes ai.agents', () => {
    const service = read('../src/modules/agents/validation-service.ts');
    assert.match(service, /from\('agent_validations'\)\.insert\(/);
    assert.doesNotMatch(service, /from\('agents'\)\s*\.(update|upsert|delete|insert)\(/);
    assert.equal((service.match(/\.(update|upsert|delete|insert)\(/g) ?? []).length, 1, 'one write, to agent_validations');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. the migration
// ═══════════════════════════════════════════════════════════════════════════

describe('D. the migration holds its shape', () => {
  test('both tenant tables are RLS-enabled and forced, tenant-scoped, frozen, and the override is owner-only', () => {
    assert.match(executable, /create table if not exists ai\.agent_validations/);
    assert.match(executable, /create table if not exists ai\.agent_routing_overrides/);
    assert.match(executable, /enable row level security/);
    assert.match(executable, /force row level security/);
    assert.match(executable, /freeze_org_%s/);
    assert.match(executable, /agent_routing_overrides_write[\s\S]*?core\.is_owner\(\)/);
    assert.match(executable, /agent_validations_write[\s\S]*?core\.is_admin\(\)/);
  });

  test('the override door is security invoker, audited, and clears by deleting', () => {
    const fn = executable.slice(executable.indexOf('function ai.set_agent_routing_override'), executable.indexOf('function ai.revoke_provider_credential'));
    assert.match(fn, /security invoker/);
    assert.doesNotMatch(fn, /security definer/);
    assert.match(fn, /agent\.routing_override_set/);
    assert.match(fn, /agent\.routing_override_cleared/);
    assert.match(fn, /delete from ai\.agent_routing_overrides where id = v_id/);
  });

  test('revoking a key is owner-only, audited, and never records the ciphertext', () => {
    const fn = executable.slice(executable.indexOf('function ai.revoke_provider_credential'), executable.indexOf('function core.cancel_job'));
    assert.match(fn, /core\.is_owner\(\)/);
    assert.match(fn, /provider_credential\.revoked/);
    assert.doesNotMatch(fn, /ciphertext|auth_tag|\biv\b/);
    assert.match(fn, /delete from ai\.provider_credentials where provider = p_provider/);
  });

  test('cancel_job is the requeue door’s twin: definer with the caller guard, queued only, audited with the reason', () => {
    const fn = executable.slice(executable.indexOf('function core.cancel_job'));
    assert.match(fn, /security definer/);
    assert.match(fn, /core\.current_user_role\(\) not in \('owner', 'ops_admin'\)/);
    assert.match(fn, /for update/);
    assert.match(fn, /v_status not in \('queued', 'failed'\)/);
    assert.match(fn, /'job\.cancelled'/);
    assert.match(fn, /'reason', v_reason/);
    assert.match(fn, /set status\s+= 'cancelled'/);
  });

  test('the app-side cancel door names the capability and quotes the status back', () => {
    const door = read('../src/lib/observability/cancel.ts');
    assert.match(door, /can\(context\.role, 'job\.requeue'\)/);
    assert.match(door, /rpc\('cancel_job'/);
    assert.match(door, /case 'not_cancellable'/);
    assert.match(door, /case 'not_found'/);
  });

  test('the vault revoke goes through the function, checks the role, and logs nothing about the key', () => {
    const vault = read('../src/lib/ai/vault.ts');
    const fn = vault.slice(vault.indexOf('export async function deleteProviderCredential'), vault.indexOf('export type ProviderCredentialStatus'));
    assert.match(fn, /rpc\('revoke_provider_credential'/);
    assert.match(fn, /role !== 'owner'/);
    assert.doesNotMatch(fn, /ciphertext|decrypt|rawKey/);
  });
});
