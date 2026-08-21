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
import { TOOLS } from '../src/modules/agents/tools.ts';
import { RUNNER_SOURCE } from './_runner-source.ts';

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
  test('the whole ADM-82 roster is defined, thirteen in three layers', () => {
    // ADM-82 grants thirteen agents in three layers and requires "each layer
    // passing its architecture and verification gates before the next is
    // activated". All thirteen are now defined, and TWELVE OF THEM ARE
    // DISABLED — the grant settled which agents exist and withheld their
    // implementation, so a definition is not an activation.
    //
    // Defining them ahead of activation is not bookkeeping. Layer 1 taught
    // the reason directly: with two agents defined and one of them not a
    // producer, the rule that nobody certifies their own work held by
    // arithmetic rather than by a check. Every boundary in this module — tool
    // authorization, the handoff graph, the verification contract, the
    // pricing prohibition — is now exercised against the roster the system
    // will actually have.
    assert.deepEqual(
      [...AGENT_KEYS],
      [
        // layer 1 — foundation
        'requirement_collector', 'orchestrator', 'developer', 'quality_assurance',
        // layer 2 — core delivery
        'sales', 'project_manager', 'ui_designer', 'ui_prototype', 'handover',
        // layer 3 — operations
        'finance', 'support', 'customer_success', 'upsell',
      ],
    );
    assert.equal(AGENT_DEFINITIONS.filter((a) => a.layer === 'foundation').length, 4);
    assert.equal(AGENT_DEFINITIONS.filter((a) => a.layer === 'core').length, 5);
    assert.equal(AGENT_DEFINITIONS.filter((a) => a.layer === 'operations').length, 4);
  });

  test('and every one of them is installed disabled', () => {
    // The whole roster, and one enabled row. `requirement_collector` is the
    // only agent that has ever run; the other twelve exist so the boundaries
    // can be checked against them, which is a different thing from running.
    const enabled = [...seed.matchAll(/\(\s*'([a-z_]+)',\s*'[^']*',\s*'(?:[^']|'')*',\s*'L[012]',\s*true/g)];
    assert.deepEqual(enabled.map((m) => m[1]), ['requirement_collector']);
    for (const a of AGENT_DEFINITIONS) {
      assert.match(seed, new RegExp(`\\('${a.key}',`), `${a.key} is defined and installed by no migration`);
    }
  });

  test('autonomy is read off ADM-61, not chosen per agent', () => {
    // "L2 acts alone on internal work and asks for anything client-facing or
    // touching money." So the classification is derivable, and asserting it
    // per-agent would be asserting a table of choices. This asserts the rule:
    // no agent that reaches a client, and no agent that moves money, is
    // trusted to act alone.
    const seeded = new Map(
      [...seed.matchAll(/\(\s*'([a-z_]+)',\s*'[^']*',\s*'(?:[^']|'')*',\s*'(L[012])',/g)]
        .map((m) => [m[1], m[2]]),
    );
    for (const a of AGENT_DEFINITIONS) {
      const level = seeded.get(a.key);
      assert.ok(level, `${a.key} has no seeded autonomy level`);
      if (a.clientFacing || a.moneyAuthority !== 'none') {
        assert.notEqual(
          level, 'L2',
          `${a.key} reaches a client or moves money and is trusted to act alone (ADM-61)`,
        );
      }
    }
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

  test('and every agent the runner can reach is one this registry defines', () => {
    // This used to assert `const AGENT_KEY = 'requirement_collector'` — which
    // was true, and was the problem: one constant meant twelve of ADM-82's
    // thirteen agents could be enabled and still receive nothing.
    //
    // The invariant that replaced it is the one that was always meant: a
    // workflow naming an agent the registry does not define is a queue whose
    // work nobody can perform, and the job would be claimed and failed on
    // every tick until its attempts ran out.
    const bound = [...RUNNER_SOURCE.matchAll(/^\s*agentKey: '([a-z_]+)',/gm)].map((m) => m[1] ?? '');
    assert.ok(bound.length >= 2, `only ${bound.length} workflow agent(s) found — the parser drifted`);
    for (const key of bound) {
      assert.ok(AGENT_KEYS.includes(key), `a workflow dispatches to "${key}", which is not defined`);
    }
    assert.ok(bound.includes('requirement_collector'), 'the one agent that has run is unreachable');
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

describe("C2. ADM-82's named prohibitions, expressed as things that cannot happen", () => {
  // Three of ADM-82's rules are stated about *specific agents*, in capitals.
  // A rule about a specific agent is the easiest kind to satisfy with a
  // sentence in a prompt and the easiest to lose, because nothing else in the
  // system depends on it. These assert the structure instead: not that the
  // agent is told not to, but that it has no way.

  const toolNamed = (name: string) => TOOLS.find((t) => t.name === name);

  test('UPSELL HAS ZERO PRICING AUTHORITY — so it has no way to reach a client', () => {
    // "it may identify and recommend internally and must never invent a
    // price, calculate a quote, offer a discount, negotiate price or make a
    // commercial commitment."
    //
    // Every one of those verbs needs an audience. Denying it the audience
    // denies all five at once, which a prompt listing five prohibitions does
    // not — the sixth phrasing is always available to a model that can send a
    // message.
    const upsell = definitionFor('upsell');
    assert.ok(upsell);
    assert.equal(upsell.clientFacing, false);
    assert.equal(upsell.moneyAuthority, 'none');
    for (const t of upsell.tools) {
      assert.equal(toolNamed(t)?.clientFacing, false, `upsell holds ${t}, which reaches a client`);
      assert.equal(toolNamed(t)?.touchesMoney, false, `upsell holds ${t}, which touches money`);
    }
    // And what it finds goes to the one agent that may hold the conversation.
    assert.deepEqual([...upsell.handoffTargets], ['sales']);
  });

  test('no agent anywhere holds a tool that could set a price — ADM-22', () => {
    // Business rules 08 §5.1: such actions "do not become permissible at a
    // higher autonomy level". So this is not checked per agent or per level.
    // `sales.setProposalPricing` exists as a service action a human calls and
    // is absent from `tools.ts` entirely, which means no binding can name it
    // and `resolveTool` refuses the call before authorization is consulted.
    for (const agent of AGENT_DEFINITIONS) {
      for (const t of agent.tools) {
        assert.ok(!/pricing|setPrice|discount/i.test(t), `${agent.key} is bound to ${t}`);
      }
    }
    assert.ok(!TOOLS.some((t) => /pricing|setPrice|discount/i.test(t.name)));
  });

  test('and none can decide an approval — requesting is not deciding', () => {
    // An agent that could settle an approval has replaced the approval
    // engine, and every gate expressed as "this requires approval" would be a
    // gate the requester also holds the key to.
    for (const agent of AGENT_DEFINITIONS) {
      for (const t of agent.tools) {
        assert.ok(!/decideApproval|approvals\.decide/.test(t), `${agent.key} is bound to ${t}`);
      }
    }
  });

  test('handover receives from nobody — it must not certify its own producer', () => {
    // ADM-82's stated reason for handover being a separate agent: it "must
    // not be the same authority that produced what it certifies". A producer
    // that could hand straight to it is a producer routing around QA, and the
    // certificate would then rest on evidence its own author chose to send.
    const senders = AGENT_DEFINITIONS.filter((a) => a.handoffTargets.includes('handover'));
    assert.deepEqual(senders.map((a) => a.key), []);
    // The database half. `ai.handoffs_guard` refuses any handoff that is not
    // an edge in the mirror, so this is the same claim where it is enforced.
    assert.ok(!/\(\s*'[a-z_]+',\s*'handover'\s*\)/.test(seed), 'a migration installs an edge into handover');
  });

  test('only QA verifies, and it is the only agent that produces nothing for itself', () => {
    // The roster is now large enough that this stopped being arithmetic.
    const verifiers = AGENT_DEFINITIONS.filter((a) => a.mayVerify);
    assert.deepEqual(verifiers.map((a) => a.key), ['quality_assurance']);
    for (const a of AGENT_DEFINITIONS) {
      assert.equal(a.verification.selfAssertionAllowed, false, `${a.key} may assert its own completion`);
      if (a.verification.verifiedBy !== null) {
        assert.ok(
          definitionFor(a.verification.verifiedBy)?.mayVerify,
          `${a.key} names ${a.verification.verifiedBy} as verifier, which carries no such authority`,
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
