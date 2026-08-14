import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  mayComplete,
  nextAfterRejection,
  verdictFor,
  type Evidence,
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
