import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * The handoff boundary — G-125 conditions 6 and 7, G-128, decision ADM-83.
 *
 * ADM-83 kept the handoff shape and added a rule I had not proposed: the
 * receiver must be an allowed target in the **sender's** registry definition.
 * That turns the handoff graph into an authorization boundary rather than a
 * routing convenience.
 *
 * These are structural tests against the migration, because the rules they pin
 * live in Postgres and the live verification scripts exercise them against a
 * real database. What matters here is that the constraints exist and say what
 * the decision says — a later edit that quietly drops one fails here first.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const migration = read('../supabase/migrations/20260814120003_a_handoff_goes_where_it_is_allowed.sql');
const registry = read('../src/modules/agents/registry.ts');

describe('A. a handoff goes where it is allowed', () => {
  test('the receiver must be a declared target of the sender', () => {
    // The rule cannot be a CHECK, because a CHECK cannot reach another table.
    // A trigger is the honest shape, and it refuses rather than corrects.
    assert.match(migration, /create or replace function ai\.enforce_handoff_target\(\)/);
    assert.match(migration, /from ai\.agent_handoff_targets t[\s\S]{0,200}t\.from_agent = new\.from_agent/);
    assert.match(migration, /t\.to_agent\s+= new\.to_agent/);
    assert.match(migration, /raise exception[\s\S]{0,160}may not hand work to/);
  });

  test('and the rule also runs on UPDATE, not only INSERT', () => {
    // A handoff redirected after creation would otherwise escape the rule that
    // governed its creation — the classic way a boundary is bypassed by a
    // second statement rather than a first.
    assert.match(migration, /before insert or update of from_agent, to_agent on ai\.handoffs/);
  });

  test('an agent cannot hand work to itself, in either table', () => {
    assert.match(migration, /constraint handoffs_not_self check \(from_agent <> to_agent\)/);
    assert.match(migration, /constraint agent_handoff_targets_not_self check \(from_agent <> to_agent\)/);
  });
});

describe('B. completion carries evidence', () => {
  test('a completed handoff without verification is refused by the database', () => {
    // ADM-83: completion is a verdict on evidence, never a claim. The
    // constraint is what makes that structural rather than aspirational.
    assert.match(
      migration,
      /constraint handoffs_completed_needs_verification\s*\n?\s*check \(status <> 'completed' or verification is not null\)/,
    );
  });

  test('and rejected is a state of its own, not a failure to complete', () => {
    // A rejection carries no verification, because it is a verdict about the
    // absence of one. Folding it into a failure state would lose the
    // distinction QA exists to make.
    assert.match(migration, /'rejected'/);
    assert.match(migration, /'failed_retryable'/);
    assert.match(migration, /'failed_permanent'/);
  });
});

describe('C. G-128 — how far, not only where', () => {
  test('depth is bounded', () => {
    assert.match(migration, /depth\s+int not null default 0 check \(depth >= 0 and depth <= 8\)/);
  });

  test('and the bound is documented as an engineering decision with its reasoning', () => {
    // A bare number in a schema is a number nobody can revise, because nobody
    // knows what it was protecting. Eight is the longest legitimate chain the
    // roster implies, plus one.
    assert.match(migration, /engineering decision/i);
    // Comment prefixes stripped and whitespace collapsed, so the assertion
    // survives a rewrap. The first draft pinned the chain as one contiguous
    // string and failed because the sentence wraps across two comment lines —
    // a test asserting a line break rather than a fact.
    const prose = migration.replace(/^--\s?/gm, '').replace(/\s+/g, ' ');
    assert.match(prose, /requirement → PM → design → prototype → build → QA → handover/);
  });

  test('the correlation chain is the scope, and is indexed for it', () => {
    assert.match(migration, /handoffs_correlation_idx[\s\S]{0,120}\(correlation_id, depth\)/);
  });
});

describe('D. tenant isolation, the same shape as everything else', () => {
  test('RLS is enabled and scoped to the current organization', () => {
    assert.match(migration, /alter table ai\.handoffs enable row level security/);
    assert.match(migration, /organization_id = \(select core\.current_organization_id\(\)\)/);
  });

  test('context holds references rather than copied prose', () => {
    // A receiver re-reads facts under its own policies, so a handoff cannot
    // carry data across a tenant or project boundary by embedding it.
    assert.match(migration, /References, never copied prose/);
  });
});

describe('E. the mirror carries exactly what the registry declares', () => {
  test('one pair is seeded, and it is the one the registry declares', () => {
    // Until F4 both were empty and no handoff could be created by anybody.
    // F4 defined the verifier, so `requirement_collector` now declares one
    // target and the mirror carries exactly that pair.
    assert.match(
      migration,
      /insert into ai\.agent_handoff_targets[\s\S]{0,160}\('requirement_collector', 'quality_assurance'\)/,
    );
    assert.match(registry, /handoffTargets: \['quality_assurance'\]/);
  });

  test('and the reverse pair is not seeded, deliberately', () => {
    // A verdict returns through the handoff it was given, not by opening a new
    // one back at the producer. The trigger refuses `quality_assurance →
    // requirement_collector` because nothing declares it.
    assert.ok(
      !/\('quality_assurance', 'requirement_collector'\)/.test(migration),
      'the mirror carries a return pair no registry definition declares',
    );
  });

  test('the seed is idempotent, because a migration may be re-applied', () => {
    assert.match(migration, /on conflict \(from_agent, to_agent\) do nothing/);
  });
});
