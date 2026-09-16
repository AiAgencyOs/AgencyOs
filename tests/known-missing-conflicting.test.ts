import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONTEXT_FIELDS,
  COVERAGE_AREA_FOR,
  UNRESOLVED_MEANS,
  mayAsk,
  resolveOnboardingContext,
  type ContextSources,
} from '../src/modules/projects/onboarding-context.ts';

/**
 * Known, missing, conflicting, stale — PM §4.1, §14.
 *
 * The specification's sentence is *"never ask the client to repeat
 * already-confirmed information unless missing, conflicting, stale or
 * explicitly requiring reconfirmation"*, and the thing worth testing is not
 * that the module has four states — it is that each one is reached for a
 * reason the repository can point at, and that `known` is never reached
 * without evidence.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const SERVICE = read('src/modules/projects/service.ts');
const MODULE = read('src/modules/projects/onboarding-context.ts');
/** The module's prose with its comment markers folded, so an assertion is not about line wrapping. */
const PROSE = MODULE.replace(/\n \* ?/g, ' ');
/** The CODE alone. Prose about clocks is not a clock. */
const CODE = MODULE.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const RESOLVER = SERVICE.slice(
  SERVICE.indexOf('Read what Phase 1 left, and work out what is still worth asking'),
  SERVICE.indexOf('A milestone with its project context'),
);

/** A deal where Phase 1 went perfectly: nothing unresolved, every source present. */
const complete = (): ContextSources => ({
  unresolved: [],
  contact: { id: 'c-1', full_name: 'Asha' },
  clientAccount: { id: 'a-1', name: 'Asha Textiles' },
  project: { id: 'p-1', name: 'Asha storefront' },
  proposal: { id: 'q-1', version: 2, status: 'accepted' },
  requirement: { id: 'r-1', version: 3, status: 'accepted' },
  latestAcceptedRequirement: { id: 'r-1', version: 3 },
  scope: { id: 's-1', version: 1, status: 'frozen' },
  coverage: {
    timeline: { quote: 'Diwali tak chahiye' },
    decision_maker: { quote: 'main hi decide karta hoon' },
    existing_assets: { quote: 'purani site hai wordpress pe' },
    design_expectations: { quote: 'kuch aapke jaisa clean' },
    integrations: { quote: 'razorpay lagana hai' },
  },
});

const verdictFor = (matrix: ReturnType<typeof resolveOnboardingContext>, key: string) =>
  matrix.resolutions.find((r) => r.key === key)!;

describe('A. a client who told us everything is asked nothing', () => {
  test('every field resolves known, and the ask list is empty', () => {
    const matrix = resolveOnboardingContext(complete());
    assert.equal(matrix.toAsk.length, 0, matrix.toAsk.map((r) => r.key).join(', '));
    assert.equal(matrix.counts.known, CONTEXT_FIELDS.length);
    assert.equal(matrix.knownKeys.length, CONTEXT_FIELDS.length);
  });

  test('every known verdict carries the evidence it read, and no question', () => {
    for (const r of resolveOnboardingContext(complete()).resolutions) {
      assert.equal(r.verdict, 'known');
      assert.ok(r.evidence && r.evidence.trim().length > 0, `${r.key} claims known with no evidence`);
      assert.equal(r.question, null, `${r.key} is known and still carries a question`);
    }
  });

  test('a coverage-backed field quotes the client rather than asserting over them', () => {
    const matrix = resolveOnboardingContext(complete());
    assert.match(verdictFor(matrix, 'timeline_assumptions_recorded').evidence!, /Diwali tak chahiye/);
  });
});

describe('B. nothing is claimed known without evidence', () => {
  test('an empty world asks every question and claims nothing', () => {
    const empty: ContextSources = {
      unresolved: [],
      contact: null,
      clientAccount: null,
      project: { id: 'p-1', name: null },
      proposal: null,
      requirement: null,
      latestAcceptedRequirement: null,
      scope: null,
      coverage: {},
    };
    const matrix = resolveOnboardingContext(empty);
    assert.equal(matrix.counts.known, 0);
    assert.equal(matrix.toAsk.length, CONTEXT_FIELDS.length);
    for (const r of matrix.resolutions) {
      assert.equal(r.evidence, null, `${r.key} produced evidence out of nothing`);
      assert.ok(r.question, `${r.key} is unknown and has nothing to ask`);
      assert.ok(r.reason.length > 0);
    }
  });

  test('a contact with no client account behind it is not an identity', () => {
    const matrix = resolveOnboardingContext({ ...complete(), clientAccount: null });
    assert.equal(verdictFor(matrix, 'client_identity_confirmed').verdict, 'missing');
  });

  test('a draft scope is not a confirmed scope', () => {
    const matrix = resolveOnboardingContext({ ...complete(), scope: { id: 's', version: 1, status: 'draft' } });
    const r = verdictFor(matrix, 'scope_version_created');
    assert.equal(r.verdict, 'missing');
    assert.match(r.reason, /still a draft, which is not a confirmation/);
  });

  test('a project named only in whitespace has no name', () => {
    const matrix = resolveOnboardingContext({ ...complete(), project: { id: 'p', name: '   ' } });
    assert.equal(verdictFor(matrix, 'project_name_confirmed').verdict, 'missing');
  });
});

describe('C. the packet’s own verdicts are read, not re-derived', () => {
  test('every marker record_won_handoff can write is either mapped or deliberately not', () => {
    // The markers the door writes, read from the migration itself so a new one
    // added there cannot go unnoticed here.
    const migration = read('supabase/migrations/20260911180000_a_deal_that_is_handed_off.sql');
    const written = new Set(
      [...migration.matchAll(/v_unresolved \|\| '"([a-z_]+)"'::jsonb/g)].map((m) => m[1]!),
    );
    assert.ok(written.size >= 7, `only ${written.size} markers found — the regex has gone stale`);
    // These are about the agency's own record-keeping, not about a field a
    // client could answer, so they are not in the map on purpose.
    const notClientFacing = new Set(['conversation_summary', 'payment_evidence', 'project_rebound']);
    for (const marker of written) {
      if (notClientFacing.has(marker)) {
        assert.ok(!(marker in UNRESOLVED_MEANS), `${marker} is not a client question and should not map to one`);
        continue;
      }
      assert.ok(marker in UNRESOLVED_MEANS, `the packet writes ${marker} and nothing here reads it`);
    }
  });

  test('a marked field is unknown even when the row it names is present', () => {
    // The row exists NOW; the packet says it was not resolved at the win. The
    // packet wins — that is the whole point of reading it.
    const matrix = resolveOnboardingContext({ ...complete(), unresolved: ['accepted_quotation'] });
    const r = verdictFor(matrix, 'accepted_quotation_confirmed');
    assert.equal(r.verdict, 'missing');
    assert.match(r.reason, /no accepted quotation was recorded at the win/);
  });

  test('a contradiction is flagged as conflicting, never asked away as a plain gap', () => {
    const matrix = resolveOnboardingContext({ ...complete(), unresolved: ['project_proposal_differs'] });
    const r = verdictFor(matrix, 'accepted_quotation_confirmed');
    assert.equal(r.verdict, 'conflicting');
    assert.ok(r.question, 'a conflict still gets asked — PM §15 says request explicit clarification');
  });

  test('when one field carries both a gap and a contradiction, the contradiction is what a person sees', () => {
    const matrix = resolveOnboardingContext({
      ...complete(),
      unresolved: ['approval', 'acceptance_actor'],
    });
    assert.equal(verdictFor(matrix, 'commercial_terms_confirmed').verdict, 'conflicting');
  });

  test('a requirement version nobody accepted is a draft, not a confirmation', () => {
    const matrix = resolveOnboardingContext({
      ...complete(),
      unresolved: ['requirement_version_not_accepted'],
    });
    const r = verdictFor(matrix, 'requirements_imported');
    assert.equal(r.verdict, 'missing');
    assert.match(r.reason, /nobody accepted it/);
  });
});

describe('D. stale means superseded, and invents no threshold', () => {
  test('a newer accepted requirement version makes the inherited one stale', () => {
    const matrix = resolveOnboardingContext({
      ...complete(),
      latestAcceptedRequirement: { id: 'r-2', version: 4 },
    });
    const r = verdictFor(matrix, 'requirements_imported');
    assert.equal(r.verdict, 'stale');
    assert.match(r.evidence!, /superseded by 4/);
    assert.ok(mayAsk(r));
  });

  test('a superseded quotation is stale', () => {
    const matrix = resolveOnboardingContext({
      ...complete(),
      proposal: { id: 'q-1', version: 2, status: 'superseded' },
    });
    assert.equal(verdictFor(matrix, 'accepted_quotation_confirmed').verdict, 'stale');
  });

  test('no clock, no interval, no number of days anywhere', () => {
    // A staleness threshold is a business rule nobody has stated. The module
    // must not contain one — and this is the assertion that keeps it out.
    assert.doesNotMatch(CODE, /Date\.now|new Date\(|getTime|\bdays\b|MS_PER|interval/i);
    assert.match(PROSE, /Staleness invents no threshold/);
    // The positive twin: staleness is reachable, by supersession alone.
    const matrix = resolveOnboardingContext({ ...complete(), latestAcceptedRequirement: { id: 'r-9', version: 9 } });
    assert.equal(matrix.counts.stale, 1);
  });
});

describe('E. what it refuses to be', () => {
  test('it asks nothing the agency owes itself', () => {
    // The checklist's other items — the group, the PM, the agents, the
    // kickoff, the activation — are the agency's work. `payment_verified`
    // most of all: proof never auto-verifies, and a PM collecting it would be
    // collecting the one thing it must not.
    const keys = CONTEXT_FIELDS.map((f) => f.key) as string[];
    for (const internal of [
      'payment_verified',
      'whatsapp_group_mapped',
      'project_manager_assigned',
      'specialist_agents_assigned',
      'kickoff_sent',
      'project_activated',
    ]) {
      assert.ok(!keys.includes(internal), `${internal} is the agency’s work, not a client’s answer`);
    }
    // The twin: the client-facing items ARE all here, and each names a real
    // baseline key rather than a key invented for this module.
    const baseline = read('supabase/migrations/20260814120012_a_list_the_admin_can_change.sql');
    for (const key of keys) {
      assert.match(baseline, new RegExp(`'${key}'`), `${key} is not an onboarding baseline item`);
    }
  });

  test('every coverage area it reads is one of Document 09 §9’s fifteen', () => {
    const coverageMigration = read('supabase/migrations/20260822220000_what_the_conversation_already_answered.sql');
    for (const area of Object.values(COVERAGE_AREA_FOR)) {
      assert.match(coverageMigration, new RegExp(`'${area}'`), `${area} is not a qualification area`);
    }
  });

  test('reconfirmation is raised rather than guessed', () => {
    assert.match(MODULE, /ADM-107/);
    assert.match(PROSE, /Guessing\s+would put words in the owner's mouth about what to ask a paying client twice/);
    // And no fifth state was invented to hold a rule nobody has stated.
    assert.doesNotMatch(MODULE, /'needs_reconfirmation'|requires_reconfirmation/);
  });

  test('it is pure — no database, no model, no clock', () => {
    assert.doesNotMatch(CODE, /createClient|supabase|from\('|\.rpc\(|openai|anthropic|runAgent/i);
  });
});

describe('F. the reader follows references and refuses to guess', () => {
  test('a failed read is not an absent fact', () => {
    assert.match(RESOLVER, /if \(projectError\) return err\('INTERNAL'/);
    assert.match(RESOLVER, /if \(handoffError\) return err\('INTERNAL'/);
    assert.match(RESOLVER, /if \(read\.error\) return err\('INTERNAL'/);
    assert.match(RESOLVER, /a resolver that turns a\n \* dropped connection into "the client never told us"/);
  });

  test('no packet is a refusal, not an empty matrix', () => {
    // An empty matrix would read as "this client told us nothing" and have the
    // PM ask eleven questions of somebody who answered them all.
    assert.match(RESOLVER, /if \(!handoff\) return err\('NOT_FOUND'/);
  });

  test('it reads the packet’s references and copies nothing into a Phase 2 table', () => {
    assert.match(RESOLVER, /\.from\('handoffs'\)/);
    assert.doesNotMatch(RESOLVER, /\.insert\(|\.update\(|\.upsert\(/);
  });

  test('it takes the sales → project_manager packet, not whichever handoff is newest', () => {
    assert.match(RESOLVER, /\.eq\('from_agent', 'sales'\)/);
    assert.match(RESOLVER, /\.eq\('to_agent', 'project_manager'\)/);
  });
});
