import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGENT_DEFINITIONS, definitionFor, type AgentDefinition } from '../src/modules/agents/registry.ts';
import { normalizeCost, rankByCostWithinCapability, type RouteCandidate } from '../src/modules/orchestrator/cost-ranking.ts';
import { eligibleFallbacks, FALLBACK_VIOLATION_CODES, specialistFamily, validateFallback } from '../src/modules/orchestrator/fallback.ts';

/**
 * Fallback validation (Orchestrator spec 20) and cost truthfulness (spec 13, 22). Pure. The database halves are driven in
 * `scripts/verify-phase5-orchestrator.sql`.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const def = (key: string): AgentDefinition => {
  const found = definitionFor(key);
  assert.ok(found, `${key} is registered`);
  return found;
};
/** A definition derived from a real one: a fallback test needs a widened agent the roster does not contain. */
const variant = (key: string, over: Record<string, unknown>): AgentDefinition => ({ ...def(key), ...over }) as AgentDefinition;

describe('A. validateFallback', () => {
  test('a specialist and an equal specialist of the same family are a valid fallback', () => {
    const verdict = validateFallback(def('backend_developer'), variant('backend_developer', { key: 'backend_developer_b' }));
    assert.deepEqual(verdict.violations, []);
    assert.equal(verdict.valid, true);
  });

  test('a fallback onto the same agent is a retry, not a fallback', () => {
    assert.deepEqual(validateFallback('bug_fix', 'bug_fix').violations.map((v) => v.code), ['same_agent']);
  });

  test('an unregistered agent on either side is named and invalid', () => {
    assert.deepEqual(validateFallback('nobody', 'bug_fix').violations.map((v) => v.code), ['unknown_primary']);
    assert.deepEqual(validateFallback('bug_fix', 'nobody').violations.map((v) => v.code), ['unknown_fallback']);
    assert.equal(validateFallback('nobody', 'nobody2').valid, false);
  });

  test('a different family is refused: a developer is never a fallback for QA, and QA is never one for a developer', () => {
    const devToQa = validateFallback('backend_developer', 'quality_assurance');
    assert.equal(devToQa.valid, false);
    assert.ok(devToQa.violations.some((v) => v.code === 'different_family'));
    assert.ok(validateFallback('functional_test', 'backend_developer').violations.some((v) => v.code === 'different_family'));
    assert.equal(specialistFamily(def('backend_developer')), 'development');
    assert.equal(specialistFamily(def('functional_test')), 'qa');
  });

  test('a fallback that cannot do the work (missing a capability the primary carries) is refused', () => {
    const verdict = validateFallback(def('frontend_developer'), variant('frontend_developer', { key: 'fe_b', capabilities: ['coding'] }));
    assert.ok(verdict.violations.some((v) => v.code === 'capability_gap'));
  });

  test('a fallback holding a tool the primary does not is refused: tools may be fewer, never more', () => {
    const primary = variant('backend_developer', { tools: ['read_file'] });
    const wider = variant('backend_developer', { key: 'bd_b', tools: ['read_file', 'write_file'] });
    const narrower = variant('backend_developer', { key: 'bd_c', tools: [] });
    assert.deepEqual(validateFallback(primary, wider).violations.map((v) => v.code), ['tool_widened']);
    assert.equal(validateFallback(primary, narrower).valid, true);
  });

  test('each way of widening permissions is its own refusal', () => {
    const primary = def('backend_developer');
    const cases: [string, Record<string, unknown>][] = [
      ['money_authority_widened', { moneyAuthority: 'proposes_for_approval' }],
      ['client_facing_widened', { clientFacing: true }],
      ['verification_authority_widened', { mayVerify: true }],
      ['handoff_widened', { handoffTargets: [...primary.handoffTargets, 'finance'] }],
      ['verifier_changed', { verification: { ...primary.verification, verifiedBy: 'security_review' } }],
    ];
    for (const [code, over] of cases) {
      const verdict = validateFallback(primary, variant('backend_developer', { key: 'bd_x', ...over }));
      assert.deepEqual(verdict.violations.map((v) => v.code), [code], code);
      assert.equal(verdict.valid, false);
    }
  });

  test('every violation code the validator can produce is a published code, and the verdict lists all violations rather than the first', () => {
    const verdict = validateFallback(def('backend_developer'), variant('quality_assurance', { key: 'qa_x', clientFacing: true, tools: ['write_file'] }));
    assert.ok(verdict.violations.length >= 3);
    for (const v of verdict.violations) assert.ok((FALLBACK_VIOLATION_CODES as readonly string[]).includes(v.code));
  });

  test('over the real roster, every valid fallback for a development specialist is a development specialist with no wider authority', () => {
    for (const primary of AGENT_DEFINITIONS.filter((d) => d.layer === 'development')) {
      const { eligible } = eligibleFallbacks(primary.key, AGENT_DEFINITIONS);
      for (const key of eligible) {
        const fb = def(key);
        assert.equal(fb.layer, 'development', `${primary.key} -> ${key}`);
        assert.equal(fb.mayVerify, false);
        assert.equal(fb.clientFacing, false);
        assert.ok(fb.tools.every((t) => primary.tools.includes(t)));
      }
    }
  });

  test('eligibleFallbacks returns nothing for a primary no one can safely replace: the escalate case', () => {
    const { eligible, rejected } = eligibleFallbacks('quality_assurance', AGENT_DEFINITIONS);
    assert.deepEqual(eligible, [], 'QA is the one verifier: nothing may stand in for it');
    assert.ok(rejected.length > 0);
  });
});

describe('B. fallback persistence', () => {
  const service = read('src/modules/orchestrator/orchestrator-service.ts');
  const sql = read('supabase/migrations/20261102110000_a_fallback_is_recorded_and_a_cost_is_reported_estimated_or_unknown.sql');

  test('the verdict, including a rejected one with its violations, is sent through projects.record_fallback', () => {
    assert.match(service, /'record_fallback'/);
    assert.match(service, /p_violations: input\.verdict\.violations/);
  });
  test('the table accepts a fallback exactly when no violation was found', () => {
    assert.match(sql, /check \(\(outcome = 'accepted'\) = \(jsonb_array_length\(violations\) = 0\)\)/);
  });
  test('the table is written only through a service-role door', () => {
    assert.match(sql, /grant execute on function projects\.record_fallback\(uuid, text, text, text, jsonb, text\) to service_role;/);
    assert.match(sql, /revoke insert, update, delete on projects\.%I from authenticated/);
  });
});

describe('C. rankByCostWithinCapability: the cheapest route never wins below the threshold', () => {
  const route = (key: string, capability: number, costUsd: number | null, costSource: RouteCandidate['costSource'] = costUsd === null ? 'unknown' : 'reported'): RouteCandidate => ({ key, capability, costUsd, costSource });

  test('among routes that clear the threshold, the cheapest wins', () => {
    const r = rankByCostWithinCapability([route('mid', 80, 0.5), route('cheap', 70, 0.1), route('dear', 95, 2)], 70);
    assert.equal(r.selected?.key, 'cheap');
    assert.deepEqual(r.ranked.map((x) => x.key), ['cheap', 'mid', 'dear']);
    assert.deepEqual(r.ranked.map((x) => x.rank), [1, 2, 3]);
  });

  test('a cheaper route below the threshold is excluded and can never win', () => {
    const r = rankByCostWithinCapability([route('free-but-weak', 40, 0), route('capable', 90, 3)], 70);
    assert.equal(r.selected?.key, 'capable');
    assert.deepEqual(r.excluded, [{ key: 'free-but-weak', reason: 'below_capability_threshold' }]);
  });

  test('when nothing clears the threshold there is no winner, not the least bad route', () => {
    const r = rankByCostWithinCapability([route('a', 10, 0.01), route('b', 20, 0.02)], 70);
    assert.equal(r.selected, null);
    assert.deepEqual(r.ranked, []);
    assert.equal(r.excluded.length, 2);
    assert.match(r.reason, /no route clears/);
  });

  test('an unknown cost is not zero: a known price outranks an unknown one, even a high one', () => {
    const r = rankByCostWithinCapability([route('unknown', 90, null), route('known-dear', 90, 50)], 70);
    assert.equal(r.selected?.key, 'known-dear');
    assert.equal(r.ranked[1]?.costUsd, null, 'the unknown route keeps a null cost and is not turned into a number');
  });

  test('a lone unknown-cost route that clears the threshold may still be selected, and says its cost is unknown', () => {
    const r = rankByCostWithinCapability([route('only', 90, null)], 70);
    assert.equal(r.selected?.key, 'only');
    assert.match(r.reason, /no candidate that does has a known cost/);
  });

  test('ties go to the more capable route, then to the key, so the order is deterministic', () => {
    const r = rankByCostWithinCapability([route('b', 80, 1), route('a', 80, 1), route('c', 99, 1)], 70);
    assert.deepEqual(r.ranked.map((x) => x.key), ['c', 'a', 'b']);
  });

  test('a candidate with a non-finite capability is excluded as invalid, never ranked', () => {
    const r = rankByCostWithinCapability([route('nan', Number.NaN, 0), route('ok', 80, 1)], 70);
    assert.equal(r.selected?.key, 'ok');
    assert.deepEqual(r.excluded, [{ key: 'nan', reason: 'invalid_candidate' }]);
  });

  test('a reported cost that is missing or negative is treated as unknown, never as 0', () => {
    const r = rankByCostWithinCapability([route('bad', 90, -5, 'reported'), route('fine', 90, 1)], 70);
    assert.equal(r.selected?.key, 'fine');
    assert.equal(r.ranked.find((x) => x.key === 'bad')?.costSource, 'unknown');
    assert.equal(r.ranked.find((x) => x.key === 'bad')?.costUsd, null);
  });
});

describe('D. cost truthfulness', () => {
  test('normalizeCost: unknown has no number; a missing, negative or non-finite number is unknown; a real zero reported stays zero', () => {
    assert.deepEqual(normalizeCost('unknown', 0), { costSource: 'unknown', costUsd: null });
    assert.deepEqual(normalizeCost('reported', undefined), { costSource: 'unknown', costUsd: null });
    assert.deepEqual(normalizeCost('estimated', Number.NaN), { costSource: 'unknown', costUsd: null });
    assert.deepEqual(normalizeCost('reported', -1), { costSource: 'unknown', costUsd: null });
    assert.deepEqual(normalizeCost('reported', 0), { costSource: 'reported', costUsd: 0 });
    assert.deepEqual(normalizeCost('estimated', 0.125), { costSource: 'estimated', costUsd: 0.125 });
  });

  const sql = read('supabase/migrations/20261102110000_a_fallback_is_recorded_and_a_cost_is_reported_estimated_or_unknown.sql');
  test('the table says unknown carries NULL and the other two carry a number', () => {
    assert.match(sql, /\(cost_source = 'unknown' and cost_usd is null\) or \(cost_source in \('reported', 'estimated'\) and cost_usd is not null and cost_usd >= 0\)/);
    assert.match(sql, /cost_source\s+text not null check \(cost_source in \('reported', 'estimated', 'unknown'\)\)/);
  });
  test('the staff read sums nothing into a number for the unknown group', () => {
    assert.match(sql, /create or replace function projects\.usage_cost_summary/);
    assert.doesNotMatch(sql, /coalesce\(sum\(u\.cost_usd\)/);
  });
  test('the service records through normalizeCost, so a missing number is sent as NULL', () => {
    const service = read('src/modules/orchestrator/orchestrator-service.ts');
    assert.match(service, /const cost = normalizeCost\(input\.source, input\.costUsd\);/);
    assert.match(service, /p_cost_usd: cost\.costUsd,/);
  });
  test('the staff reader keeps an unknown total null and the panel prints it as unknown', () => {
    const queries = read('src/modules/orchestrator/orchestrator-queries.ts');
    assert.match(queries, /costUsd: numOrNull\(r\.cost_usd\)/);
    const panel = read('app/(internal)/projects/[projectId]/orchestrator-panel.tsx');
    assert.match(panel, /row\.costUsd === null \? 'unknown'/);
  });
  test('the staff reader refuses a failed read rather than answering "nothing"', () => {
    const queries = read('src/modules/orchestrator/orchestrator-queries.ts');
    const guards = queries.match(/if \([A-Za-z]*[eE]rror\)/g) ?? [];
    const refusals = queries.match(/unreadable\(/g) ?? [];
    assert.equal(guards.length, 3);
    assert.equal(guards.length, refusals.length, 'one refusal per error guard');
  });
});
