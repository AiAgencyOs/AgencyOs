import { err, ok, type Result } from '@/lib/result';

import { definitionFor, type EvidenceKind } from './registry';

/**
 * The verification contract — G-125 conditions 3, 8 and 9; decisions ADM-82
 * and ADM-83.
 *
 * ── the rule ──────────────────────────────────────────────────────────────
 *
 * **Completion is a verdict on evidence, never a claim.** An agent submits
 * outputs; something else decides whether they amount to done. ADM-82 puts it
 * plainly: no agent may declare another agent's work complete, and none may
 * declare its own.
 *
 * `ai.handoffs` already refuses a completed row with no verification — that is
 * the database half, and it cannot be talked around. This is the half that
 * decides what verification *means*: which evidence was required, whether it
 * is present, whether it passed, and whether the agent offering the verdict is
 * allowed to give one.
 *
 * ── why a falling test count is a failure ─────────────────────────────────
 *
 * Every gate can pass while the work is wrong, if the work removed a gate. In
 * this repository a migration was once regenerated from an older copy and
 * silently dropped a branch that would have broken every proposal write —
 * typecheck, lint and tests all passed, because the failure was *absence*
 * rather than error. A diff caught it; nothing automated would have.
 *
 * So the count is evidence in its own right. Tests passing is not the same as
 * tests existing, and an agent that deletes a failing test has satisfied every
 * other gate in this file.
 *
 * ── what this deliberately does not do ────────────────────────────────────
 *
 * It does not run anything. Evidence is produced by the gates that already
 * exist — `tsc`, `eslint`, `node --test`, the verify scripts, `check-record`,
 * `next build` — and recorded. A verifier that generated its own evidence
 * would be marking its own homework one level up.
 */

export type Evidence =
  | { readonly kind: 'typecheck'; readonly passed: boolean; readonly detail?: string }
  | { readonly kind: 'lint'; readonly passed: boolean; readonly detail?: string }
  | {
      readonly kind: 'tests';
      readonly passed: boolean;
      /** Total collected, not merely those that ran green. See above. */
      readonly total: number;
      readonly failed: number;
    }
  | { readonly kind: 'live'; readonly passed: boolean; readonly script: string }
  | { readonly kind: 'record'; readonly passed: boolean }
  | { readonly kind: 'build'; readonly passed: boolean }
  | {
      readonly kind: 'requirement';
      readonly passed: boolean;
      readonly requirementVersionId: string;
    }
  | { readonly kind: 'approval'; readonly passed: boolean; readonly approvalRequestId: string };

export type Verdict =
  | { readonly outcome: 'verified'; readonly evidence: readonly Evidence[] }
  | { readonly outcome: 'rejected'; readonly reasons: readonly string[] };

/**
 * The baseline a test count is measured against.
 *
 * Passed in rather than read, because the verifier must not be the thing that
 * decides what "before" was — that is the same self-marking problem the
 * producer ≠ verifier rule exists to prevent, moved into a number.
 */
export type VerificationContext = {
  readonly producer: string;
  readonly verifier: string;
  readonly testBaseline?: number;
};

/**
 * Decide whether submitted evidence amounts to completion.
 *
 * Refusals are ordered so the most structural failure is reported first: an
 * illegitimate verifier is a different problem from missing evidence, and
 * reporting the second while the first is true would send somebody to fix the
 * wrong thing.
 */
export function verdictFor(
  evidence: readonly Evidence[],
  context: VerificationContext,
): Result<Verdict> {
  // ── 1. is this verifier allowed to give a verdict at all ───────────────
  //
  // ADM-82's producer ≠ verifier rule, at runtime. The registry enforces it
  // at build time for the *declared* verifier; this catches a caller passing
  // a different one.
  if (context.verifier === context.producer) {
    return err(
      'FORBIDDEN',
      `${context.producer} cannot verify its own work. Completion is a verdict, and a producer does not give it.`,
    );
  }

  const verifier = definitionFor(context.verifier);
  if (!verifier) {
    return err('FORBIDDEN', `No agent "${context.verifier}" is defined, so it cannot verify anything.`);
  }

  const producer = definitionFor(context.producer);
  if (!producer) {
    return err('INTERNAL', `No agent "${context.producer}" is defined, so there is nothing to verify.`);
  }

  // ── 2. was the required evidence supplied ──────────────────────────────
  const required = producer.verification.requiredEvidence;
  const supplied = new Set(evidence.map((e) => e.kind));
  const missing = required.filter((k) => !supplied.has(k));

  const reasons: string[] = [];
  for (const kind of missing) {
    reasons.push(`${producer.key} requires ${kind} evidence and none was supplied`);
  }

  // ── 3. did it pass ─────────────────────────────────────────────────────
  for (const item of evidence) {
    if (!item.passed) {
      reasons.push(`${item.kind} did not pass`);
    }
  }

  // ── 4. did the work remove a gate ──────────────────────────────────────
  //
  // Checked separately from `passed`, because a suite with a deleted test
  // passes. This is the only rule here that can fail while every other signal
  // is green, which is exactly why it exists.
  const tests = evidence.find((e): e is Extract<Evidence, { kind: 'tests' }> => e.kind === 'tests');
  if (tests && context.testBaseline !== undefined && tests.total < context.testBaseline) {
    reasons.push(
      `the test count fell from ${context.testBaseline} to ${tests.total} — ` +
        'passing is not the same as existing, and work that removes a gate satisfies every other check',
    );
  }

  if (reasons.length > 0) {
    return ok({ outcome: 'rejected', reasons });
  }

  return ok({ outcome: 'verified', evidence });
}

/**
 * Whether a verdict may move a handoff to `completed`.
 *
 * The database refuses a completed row with no verification; this refuses one
 * whose verification is a rejection. Both are needed: the constraint cannot
 * read the verdict's meaning, and this cannot be the only guard.
 */
export function mayComplete(verdict: Verdict): boolean {
  return verdict.outcome === 'verified';
}

/**
 * What happens to rejected work — ADM-83.
 *
 * A QA rejection is an internal verification verdict, **not a consequential
 * business action**, so it needs no approval and is final as a verdict. The
 * work returns to its producer with the reasons; retry is bounded by the
 * producer's own `retry.maxAttempts`; exhaustion escalates to a human.
 *
 * `failed_permanent` rather than a downgraded claim of partial completion:
 * ADM-83 forbids silently completing with partial evidence, so there is no
 * third option to fall back to.
 */
export function nextAfterRejection(
  producerKey: string,
  attemptsSoFar: number,
): 'running' | 'failed_permanent' {
  const producer = definitionFor(producerKey);
  const limit = producer?.retry.maxAttempts ?? 0;
  return attemptsSoFar < limit ? 'running' : 'failed_permanent';
}

/** The evidence kinds a definition may require, re-exported for callers. */
export type { EvidenceKind };
