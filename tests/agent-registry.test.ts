import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  AGENT_DEFINITIONS,
  AGENT_KEYS,
  definitionFor,
  mayHandOff,
} from '../src/modules/agents/registry.ts';

/**
 * The agent registry — G-125, decisions ADM-82 and ADM-83.
 *
 * `ARCHITECTURE.md` §6.2 named `src/modules/agents/registry.ts` from the
 * beginning and the file did not exist, while `seed.sql` enabled three agents
 * the job runner could not reach. An Admin reading `ai.agents` saw three
 * working agents and had one.
 *
 * These tests pin the two halves against each other, and pin the authority
 * rules ADM-82 requires to be structural rather than advisory.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const registry = read('../src/modules/agents/registry.ts');
/**
 * The migration that installs the agent reference data.
 *
 * It used to be `supabase/seed.sql`, and that is precisely why production had
 * none of these rows: seed.sql is applied by `supabase db reset` and by
 * nothing else, while production is migrated with `db push`. Reading the
 * installer keeps these assertions pointed at what every environment actually
 * receives.
 */
const installer = readdirSync(new URL('../supabase/migrations', import.meta.url))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => read(`../supabase/migrations/${f}`))
  .filter((sql) => /insert into ai\.agents/.test(sql))
  .join('\n');

const seed = installer;
const migration = read('../supabase/migrations/20260814120002_an_agent_that_cannot_run_says_why.sql');

describe('A. what is defined is what exists', () => {
  test('layer 1 is defined, and nothing above it is', () => {
    // ADM-82 grants thirteen agents in three layers and requires "each layer
    // passing its architecture and verification gates before the next is
    // activated". These four are layer 1. The nine in layers 2 and 3 are
    // approved and undefined — a definition naming tools nothing implements
    // would be the same defect this file was written to remove, told in
    // TypeScript instead of seed data.
    //
    // Each arrived for a reason rather than for completeness.
    // `quality_assurance` at F4, because the verification contract refuses a
    // verdict from an undefined agent and so could not be exercised at all.
    // `orchestrator` and `developer` because the rule that a third agent may
    // not certify somebody else's work held by arithmetic while only two
    // existed — one of them not a producer — and arithmetic is not a check.
    //
    // All three are DISABLED in the database. A definition is not an
    // activation.
    assert.deepEqual(
      [...AGENT_KEYS],
      ['requirement_collector', 'orchestrator', 'developer', 'quality_assurance'],
    );
  });

  test('and exactly one of them may verify — ADM-82 by name', () => {
    // "QA is the independent verifier and no other agent may declare another
    // agent's work complete." Expressed structurally so a later definition
    // cannot quietly appoint a second one: check-record §14 refuses a
    // `verifiedBy` naming an agent without this flag, and decideVerdict
    // refuses the call at runtime.
    const verifiers = [...registry.matchAll(/key:\s*'([a-z_]+)'[\s\S]*?mayVerify:\s*true/g)];
    assert.equal(verifiers.length, 1, 'more than one agent claims verification authority');
    assert.match(registry, /key: 'quality_assurance'[\s\S]*?mayVerify: true/);
  });

  test('the orchestrator may not verify, which ADM-82 states in capitals', () => {
    // "THE ORCHESTRATOR MUST NOT judge completion, act as QA, override QA, or
    // certify delivery."
    const at = registry.indexOf("key: 'orchestrator'");
    assert.ok(at > 0, 'the orchestrator is not defined');
    assert.match(registry.slice(at, at + 1200), /mayVerify: false/);
  });

  test('and the QA key satisfies the database key format', () => {
    // `qa` was the obvious name and is two characters; ai.agents.key requires
    // ^[a-z][a-z0-9_]{2,48}$, so the seed insert would have failed in CI. The
    // agent is still QA by display name — only the key changed.
    for (const key of AGENT_KEYS) {
      assert.match(key, /^[a-z][a-z0-9_]{2,48}$/, `${key} is not a valid ai.agents.key`);
    }
  });

  test('and it is the key the job runner actually reaches', () => {
    const route = read('../app/api/jobs/run/route.ts');
    assert.match(route, /const AGENT_KEY = 'requirement_collector'/);
  });

  test('definitionFor answers null rather than throwing for an unknown key', () => {
    assert.equal(definitionFor('requirement_collector')?.key, 'requirement_collector');
    assert.equal(definitionFor('lead_qualifier'), null);
    assert.equal(definitionFor(''), null);
  });
});

describe('B. the forbidden authority states are unrepresentable', () => {
  test('moneyAuthority has no "decides" member', () => {
    // ADM-22 and business rules 08 §5.1: no agent invents a price at any
    // level, and approval does not cure it. The type cannot say the forbidden
    // thing, so a definition attempting it does not compile — which is a
    // stronger guarantee than a check, because it fails while somebody is
    // writing it rather than when CI runs.
    const declaration = registry.slice(
      registry.indexOf('export type MoneyAuthority'),
      registry.indexOf(';', registry.indexOf('export type MoneyAuthority')) + 1,
    );
    assert.equal(declaration, "export type MoneyAuthority = 'none' | 'proposes_for_approval';");
    // Scoped to the declaration, not the file. A first draft scanned the whole
    // source and failed on this module's own comment explaining that 'decides'
    // does not exist — the same shape of false positive as a check-record rule
    // written the same afternoon. An assertion that fires on the documentation
    // of a prohibition teaches people to delete the documentation.
    assert.ok(!/'decides'/.test(declaration), 'the type admits a money-deciding agent');
  });

  test('selfAssertionAllowed is the literal false, not a boolean', () => {
    assert.match(registry, /readonly selfAssertionAllowed: false;/);
    for (const agent of AGENT_DEFINITIONS) {
      assert.equal(agent.verification.selfAssertionAllowed, false);
    }
  });

  test('no agent verifies itself', () => {
    // ADM-82's producer ≠ verifier rule. Null is honest while QA does not
    // exist; naming a verifier that cannot verify would be a claim about the
    // system that is not true.
    for (const agent of AGENT_DEFINITIONS) {
      assert.notEqual(
        agent.verification.verifiedBy,
        agent.key,
        `${agent.key} is its own verifier`,
      );
    }
  });

  test('and no agent claims money authority it is not permitted', () => {
    for (const agent of AGENT_DEFINITIONS) {
      assert.ok(
        agent.moneyAuthority === 'none' || agent.moneyAuthority === 'proposes_for_approval',
        `${agent.key} claims an unrecognised money authority`,
      );
    }
  });
});

describe('C. handoff targets are an authorization boundary', () => {
  test('an agent cannot hand off to itself', () => {
    assert.equal(mayHandOff('requirement_collector', 'requirement_collector'), false);
  });

  test('and cannot reach an agent it has no declared relationship with', () => {
    // ADM-83: the receiver must be an allowed target in the SENDER's
    // definition. This is the application half; F3 adds the database half, and
    // the database is the one that decides.
    assert.equal(mayHandOff('requirement_collector', 'qa'), false);
    assert.equal(mayHandOff('requirement_collector', 'anything_at_all'), false);
  });

  test('an undefined sender grants nothing', () => {
    // A key with no definition has no targets, so it cannot hand off at all —
    // rather than defaulting to permissive, which is how an unreachable agent
    // would have become a reachable one.
    assert.equal(mayHandOff('lead_qualifier', 'requirement_collector'), false);
  });

  test('every declared target is itself a defined agent', () => {
    for (const agent of AGENT_DEFINITIONS) {
      for (const target of agent.handoffTargets) {
        assert.ok(
          AGENT_KEYS.includes(target),
          `${agent.key} may hand off to "${target}", which is not a defined agent`,
        );
      }
    }
  });
});

describe('D. the seed matches the decision', () => {
  test('lead_qualifier and proposal_drafter are disabled, not deleted', () => {
    // ADM-82 folded both into `sales` and said historical definitions are
    // preserved. Disabling is the disposition true in both directions.
    for (const key of ['lead_qualifier', 'proposal_drafter']) {
      const row = seed.slice(seed.indexOf(`('${key}'`));
      assert.match(row.slice(0, 400), /false,/, `${key} is still enabled in the seed`);
      assert.match(row.slice(0, 700), /Folded into the sales agent by ADM-82/);
    }
  });

  test('and proposal_drafter no longer claims to draft pricing', () => {
    // It read "Drafts scope, timeline, and pricing … Requires owner approval."
    // §5.1 makes the prohibition absolute, so the approval clause did not
    // rescue it — and a *disabled* row still misinforms an Admin reading the
    // registry, which is why the text changes whatever the agent's state.
    const row = seed.slice(seed.indexOf("('proposal_drafter'"), seed.indexOf("('proposal_drafter'") + 700);
    assert.ok(
      !/timeline, and pricing/.test(row),
      'the seed still describes an agent drafting pricing',
    );
  });

  test('requirement_collector stays enabled, and carries no disabled reason', () => {
    const row = seed.slice(seed.indexOf("('requirement_collector'"), seed.indexOf("('requirement_collector'") + 400);
    assert.match(row, /true,/);
    assert.match(row, /null\)/, 'an enabled agent carries a disabled_reason, which the constraint refuses');
  });
});

describe('E. the database says the same thing independently', () => {
  test('a disabled agent must record why, and an enabled one may not', () => {
    // One constraint expresses both directions: enabled = (reason is null).
    assert.match(migration, /check \(enabled = \(disabled_reason is null\)\)/);
  });

  test('a validation claim is a version and a time, or neither', () => {
    assert.match(migration, /check \(\(definition_version is null\) = \(last_validated_at is null\)\)/);
  });

  test('the migration reconciles rows that already exist, not only the seed', () => {
    // The seed fixes every future `db reset`. The UPDATE fixes an environment
    // already seeded — including one running now. Either alone leaves a real
    // deployment claiming pricing authority.
    assert.match(migration, /update ai\.agents[\s\S]{0,400}lead_qualifier/);
    assert.match(migration, /update ai\.agents[\s\S]{0,600}proposal_drafter/);
  });
});
