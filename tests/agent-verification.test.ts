import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  decideVerdict,
  mayComplete,
  nextAfterRejection,
  verdictFor,
  type Evidence,
  type EvidenceKind,
  type VerifiableAgent,
} from '../src/modules/agents/verification.ts';

/**
 * The verification contract — G-125 conditions 3, 8 and 9; ADM-82 and ADM-83.
 *
 * **Completion is a verdict on evidence, never a claim.** These tests are the
 * ones ADM-82's rule stands or falls on, so they are written as attempts to
 * get a false completion accepted rather than as demonstrations that a true
 * one is.
 */

const pass = (kind: Evidence['kind']): Evidence => {
  switch (kind) {
    case 'tests':
      return { kind: 'tests', passed: true, total: 1443, failed: 0 };
    case 'live':
      return { kind: 'live', passed: true, script: 'verify-something.mjs' };
    case 'requirement':
      return { kind: 'requirement', passed: true, requirementVersionId: 'r1' };
    case 'approval':
      return { kind: 'approval', passed: true, approvalRequestId: 'a1' };
    default:
      return { kind, passed: true } as Evidence;
  }
};

const ctx = (over: Partial<{ producer: string; verifier: string; testBaseline: number }> = {}) => ({
  producer: 'requirement_collector',
  verifier: 'quality_assurance',
  ...over,
});

describe('A. a producer cannot verify itself', () => {
  test('the same agent on both sides is refused outright', () => {
    // ADM-82's rule at runtime. The registry enforces it at build time for the
    // *declared* verifier; this catches a caller passing a different one.
    const r = verdictFor([pass('requirement')], ctx({ verifier: 'requirement_collector' }));
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error.message, /cannot verify its own work/);
  });

  test('and the refusal precedes every other check', () => {
    // An illegitimate verifier is a different problem from missing evidence.
    // Reporting the second while the first is true sends somebody to fix the
    // wrong thing — so the order is part of the contract, not a detail.
    const r = verdictFor([], ctx({ verifier: 'requirement_collector' }));
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error.message, /cannot verify its own work/);
  });

  test('an undefined verifier cannot give a verdict', () => {
    const r = verdictFor([pass('requirement')], ctx({ verifier: 'not_an_agent' }));
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error.message, /cannot verify anything/);
  });
});

describe('B. evidence is required, not optional', () => {
  test('missing required evidence is a rejection, not a pass', () => {
    // requirement_collector requires 'requirement' evidence. Supplying none
    // is the plainest form of a false completion claim.
    const r = verdictFor([], ctx());
    assert.equal(r.ok, true);
    const v = r.ok ? r.data : null;
    assert.equal(v?.outcome, 'rejected');
    assert.match(
      (v?.outcome === 'rejected' ? v.reasons : []).join(' '),
      /requires requirement evidence and none was supplied/,
    );
  });

  test('failed evidence is a rejection even when it is present', () => {
    const r = verdictFor(
      [{ kind: 'requirement', passed: false, requirementVersionId: 'r1' }],
      ctx(),
    );
    const v = r.ok ? r.data : null;
    assert.equal(v?.outcome, 'rejected');
    assert.match((v?.outcome === 'rejected' ? v.reasons : []).join(' '), /requirement did not pass/);
  });

  test('and a verdict of rejected may never complete a handoff', () => {
    const r = verdictFor([], ctx());
    assert.equal(mayComplete(r.ok ? r.data : { outcome: 'rejected', reasons: [] }), false);
  });

  test('complete evidence verifies', () => {
    const r = verdictFor([pass('requirement')], ctx());
    const v = r.ok ? r.data : null;
    assert.equal(v?.outcome, 'verified');
    assert.equal(mayComplete(v!), true);
  });
});

describe('C. a falling test count is a failure', () => {
  test('fewer tests than the baseline is rejected even when everything passes', () => {
    // The only rule here that can fail while every other signal is green.
    // In this repository a migration was once regenerated from an older copy
    // and silently dropped a branch that would have broken every proposal
    // write — typecheck, lint and tests all passed, because the failure was
    // absence rather than error.
    const r = verdictFor(
      [pass('requirement'), { kind: 'tests', passed: true, total: 1400, failed: 0 }],
      ctx({ testBaseline: 1443 }),
    );
    const v = r.ok ? r.data : null;
    assert.equal(v?.outcome, 'rejected');
    assert.match(
      (v?.outcome === 'rejected' ? v.reasons : []).join(' '),
      /test count fell from 1443 to 1400/,
    );
  });

  test('and the reason says why passing is not the same as existing', () => {
    const r = verdictFor(
      [pass('requirement'), { kind: 'tests', passed: true, total: 1, failed: 0 }],
      ctx({ testBaseline: 100 }),
    );
    const v = r.ok ? r.data : null;
    assert.match(
      (v?.outcome === 'rejected' ? v.reasons : []).join(' '),
      /passing is not the same as existing/,
    );
  });

  test('a growing count is fine', () => {
    const r = verdictFor(
      [pass('requirement'), { kind: 'tests', passed: true, total: 1500, failed: 0 }],
      ctx({ testBaseline: 1443 }),
    );
    assert.equal((r.ok ? r.data : null)?.outcome, 'verified');
  });

  test('and with no baseline the count is not invented', () => {
    // A verifier that guessed a baseline would be deciding what "before" was,
    // which is the self-marking problem moved into a number.
    const r = verdictFor(
      [pass('requirement'), { kind: 'tests', passed: true, total: 3, failed: 0 }],
      ctx(),
    );
    assert.equal((r.ok ? r.data : null)?.outcome, 'verified');
  });
});

describe('D. what happens after a rejection', () => {
  test('work returns to the producer while attempts remain', () => {
    // requirement_collector allows 3 attempts.
    assert.equal(nextAfterRejection('requirement_collector', 0), 'running');
    assert.equal(nextAfterRejection('requirement_collector', 2), 'running');
  });

  test('and exhaustion escalates rather than downgrading the claim', () => {
    // ADM-83 forbids silently completing with partial evidence, so there is no
    // third option to fall back to.
    assert.equal(nextAfterRejection('requirement_collector', 3), 'failed_permanent');
    assert.equal(nextAfterRejection('requirement_collector', 99), 'failed_permanent');
  });

  test('an undefined producer gets no retries at all', () => {
    assert.equal(nextAfterRejection('not_an_agent', 0), 'failed_permanent');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. A third agent may not certify somebody else's work
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADM-82, stated as an absolute:
 *
 *   "THE ORCHESTRATOR MUST NOT judge completion, act as QA, override QA, or
 *    certify delivery. QA is the independent verifier and no other agent may
 *    declare another agent's work complete."
 *
 * `verdictFor` refused a producer verifying itself, and refused an undefined
 * verifier. It never asked whether the verifier was **the producer's declared
 * verifier** — so any defined third agent could certify anyone's work.
 *
 * That could not be tested with the real registry: two agents are defined,
 * only one is not a producer, and so every legitimate call happens to be the
 * declared pair. The rule held by arithmetic. It stops holding the moment
 * `orchestrator` or `developer` is defined — the two layer-1 agents ADM-82
 * still requires — which is exactly the next thing anyone would build.
 *
 * So the decision is exercised against a registry that has a third agent in
 * it, before one exists. `decideVerdict` is the code `verdictFor` runs; only
 * the lookup is supplied.
 */

const A = (
  key: string,
  verifiedBy: string | null,
  requiredEvidence: EvidenceKind[] = [],
  mayVerify = false,
): VerifiableAgent => ({
  key,
  mayVerify,
  verification: { requiredEvidence, verifiedBy },
  retry: { maxAttempts: 3 },
});

/** Layer 1 as ADM-82 grants it, with the two agents that do not exist yet. */
const ROSTER: readonly VerifiableAgent[] = [
  A('requirement_collector', 'quality_assurance', ['requirement']),
  A('quality_assurance', null, [], true),
  A('orchestrator', 'quality_assurance'),
  A('developer', 'quality_assurance', ['tests']),
];
const registry = (key: string) => ROSTER.find((a) => a.key === key) ?? null;

const GOOD: Evidence[] = [{ kind: 'requirement', passed: true, requirementVersionId: 'v1' }];
const say = (r: ReturnType<typeof decideVerdict>) => (r.ok ? '' : r.error.message);

describe('F. only the declared verifier may give a verdict', () => {
  test('the declared verifier can — the control', () => {
    // Without this the suite could pass by refusing everything.
    const r = decideVerdict(GOOD, { producer: 'requirement_collector', verifier: 'quality_assurance' }, registry);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.data.outcome, 'verified');
  });

  test('the orchestrator cannot, and ADM-82 says so by name', () => {
    // The case that was reachable only once a third agent existed. The
    // orchestrator is defined, is not the producer, and supplies perfect
    // evidence — and before this check it received `verified`.
    const r = decideVerdict(GOOD, { producer: 'requirement_collector', verifier: 'orchestrator' }, registry);
    assert.equal(r.ok, false);
    assert.match(say(r), /orchestrator is not requirement_collector's verifier/);
    assert.match(say(r), /ADM-82 makes that quality_assurance/);
  });

  test('nor can a peer producer', () => {
    const r = decideVerdict(GOOD, { producer: 'requirement_collector', verifier: 'developer' }, registry);
    assert.equal(r.ok, false);
    assert.match(say(r), /No other agent may declare another agent's work complete/);
  });

  test('an agent with no declared verifier cannot have its work completed at all', () => {
    // QA itself. ADM-83: nothing verifies the verifier, and a chain of
    // verifiers verifying verifiers has no end and no extra safety.
    const r = decideVerdict([], { producer: 'quality_assurance', verifier: 'orchestrator' }, registry);
    assert.equal(r.ok, false);
    assert.match(say(r), /quality_assurance declares no verifier/);
  });

  test('perfect evidence does not buy authority', () => {
    // Every gate green, from an agent that may not give a verdict. The
    // refusal is about who is speaking, not about what they brought.
    const everything: Evidence[] = [
      { kind: 'requirement', passed: true, requirementVersionId: 'v1' },
      { kind: 'typecheck', passed: true },
      { kind: 'lint', passed: true },
      { kind: 'tests', passed: true, total: 9_999, failed: 0 },
      { kind: 'build', passed: true },
      { kind: 'record', passed: true },
    ];
    const r = decideVerdict(everything, { producer: 'requirement_collector', verifier: 'orchestrator' }, registry);
    assert.equal(r.ok, false);
    assert.match(say(r), /is not requirement_collector's verifier/);
  });
});

describe('F. being named as the verifier does not confer the authority', () => {
  // check-record §14 refuses a definition whose `verifiedBy` names an agent
  // without `mayVerify`. This is the runtime half, and it exists because the
  // build-time half protects the repository while this protects the call — a
  // stale database row, a hand-edited registry, or a definition the checker
  // has not seen yet all arrive here rather than there.
  //
  // Added after removing the runtime check left every test in this file green:
  // in both the real registry and the fixture above, every declared verifier
  // happens to be QA, so the check had nothing to refuse. The same shape of
  // gap this whole file exists to close.
  const APPOINTED: readonly VerifiableAgent[] = [
    A('developer', 'orchestrator', ['tests']),
    A('orchestrator', 'quality_assurance'),
    A('quality_assurance', null, [], true),
  ];
  const appointed = (key: string) => APPOINTED.find((a) => a.key === key) ?? null;

  test('an orchestrator named as verifier is still refused', () => {
    const r = decideVerdict(
      [{ kind: 'tests', passed: true, total: 10, failed: 0 }],
      { producer: 'developer', verifier: 'orchestrator' },
      appointed,
    );
    assert.equal(r.ok, false);
    assert.match(say(r), /orchestrator may not verify anything/);
    assert.match(say(r), /being named as developer's verifier does not confer it/);
  });

  test('and the refusal is about authority, not about evidence', () => {
    // Perfect evidence, correctly declared pair, and still no.
    const r = decideVerdict(
      [{ kind: 'tests', passed: true, total: 10, failed: 0 }],
      { producer: 'developer', verifier: 'orchestrator' },
      appointed,
    );
    assert.equal(r.ok, false);
    assert.ok(!/requires tests evidence/.test(say(r)));
  });

  test('while a legitimately declared QA is accepted in the same registry', () => {
    // The control. Without it this section could pass by refusing everything.
    const r = decideVerdict([], { producer: 'orchestrator', verifier: 'quality_assurance' }, appointed);
    assert.equal(r.ok, true);
  });
});

describe('F. the refusals stay in their stated order', () => {
  test('self-verification is refused before the declared-verifier check', () => {
    // Otherwise the message would name the producer as its own verifier,
    // which reads as a registry defect rather than as the rule it is.
    const r = decideVerdict(GOOD, { producer: 'requirement_collector', verifier: 'requirement_collector' }, registry);
    assert.equal(r.ok, false);
    assert.match(say(r), /cannot verify its own work/);
  });

  test('an undefined verifier is refused before the producer is resolved', () => {
    const r = decideVerdict(GOOD, { producer: 'requirement_collector', verifier: 'ghost' }, registry);
    assert.equal(r.ok, false);
    assert.match(say(r), /No agent "ghost" is defined/);
  });

  test('and the declared-verifier check precedes the evidence check', () => {
    // An illegitimate verifier bringing NO evidence must be told which
    // problem is the real one. Reporting "evidence missing" would send
    // somebody to fix the wrong thing.
    const r = decideVerdict([], { producer: 'developer', verifier: 'orchestrator' }, registry);
    assert.equal(r.ok, false);
    assert.match(say(r), /is not developer's verifier/);
    assert.ok(!/requires tests evidence/.test(say(r)), 'it reported the evidence gap instead');
  });
});

describe('F. the real registry still agrees with itself', () => {
  test("requirement_collector's declared verifier is the one that works", () => {
    const r = verdictFor(GOOD, { producer: 'requirement_collector', verifier: 'quality_assurance' });
    assert.equal(r.ok, true);
  });

  test('and QA cannot have its own work verified, by anyone', () => {
    // Reachable against the real registry, unlike the case above.
    const r = verdictFor([], { producer: 'quality_assurance', verifier: 'requirement_collector' });
    assert.equal(r.ok, false);
    assert.match(say(r), /declares no verifier/);
  });
});
