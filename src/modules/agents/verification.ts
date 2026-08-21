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
  return decideVerdict(evidence, context, definitionFor);
}

/** The minimum a definition must state for a verdict to be decidable. */
export type VerifiableAgent = {
  readonly key: string;
  /** ADM-82: QA, and nobody else. See the registry field of the same name. */
  readonly mayVerify: boolean;
  readonly verification: {
    readonly requiredEvidence: readonly EvidenceKind[];
    readonly verifiedBy: string | null;
  };
  readonly retry: { readonly maxAttempts: number };
};

/**
 * The same decision, with the registry handed in rather than imported.
 *
 * Split for the reason `decideTool` was: two agents are defined, only one of
 * them is not a producer, and so **every legitimate call happens to be the
 * declared pair**. The rule that a third agent may not verify somebody else's
 * work could not be exercised at all — it held by arithmetic, and arithmetic
 * stops holding the moment ADM-82's remaining layer-1 agents are defined.
 *
 * `verdictFor` supplies the real registry and behaves exactly as before.
 */
export function decideVerdict(
  evidence: readonly Evidence[],
  context: VerificationContext,
  lookup: (key: string) => VerifiableAgent | null,
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

  const verifier = lookup(context.verifier);
  if (!verifier) {
    return err('FORBIDDEN', `No agent "${context.verifier}" is defined, so it cannot verify anything.`);
  }

  const producer = lookup(context.producer);
  if (!producer) {
    return err('INTERNAL', `No agent "${context.producer}" is defined, so there is nothing to verify.`);
  }

  // ── 1b. is this verifier THE producer's verifier ───────────────────────
  //
  // The half that was missing, and it was missing in the direction that
  // matters. Step 1 refuses an agent verifying itself; nothing refused a
  // *third* agent verifying somebody else's work. With two agents defined and
  // only one of them not a producer, every legitimate call happened to be the
  // declared pair — so the rule held by arithmetic rather than by check.
  //
  // ADM-82 is absolute about it: **"THE ORCHESTRATOR MUST NOT judge
  // completion, act as QA, override QA, or certify delivery. QA is the
  // independent verifier and no other agent may declare another agent's work
  // complete."** The moment `orchestrator` or `developer` is defined — the two
  // layer-1 agents ADM-82 still requires — the arithmetic stops holding and
  // this returns `verified` for an agent with no authority to give one.
  //
  // `verifiedBy` has been on the definition since F4, and `ai.agent_verifiers`
  // mirrors it in Postgres for the handoff completion guard. This is the third
  // reader, and the first one on the path a verdict actually takes.
  const declaredVerifier = producer.verification.verifiedBy;

  if (declaredVerifier === null) {
    // QA itself, today. ADM-83: nothing verifies the verifier, and a chain of
    // verifiers verifying verifiers has no end and no extra safety. So work by
    // an agent with no declared verifier cannot be completed through a verdict
    // at all — which is a refusal, not a gap.
    return err(
      'FORBIDDEN',
      `${producer.key} declares no verifier, so its work cannot be completed by a verdict.`,
    );
  }

  if (declaredVerifier !== context.verifier) {
    return err(
      'FORBIDDEN',
      `${context.verifier} is not ${producer.key}'s verifier — ADM-82 makes that ${declaredVerifier}. ` +
        "No other agent may declare another agent's work complete.",
    );
  }

  // ── 1c. was this agent ever entitled to verify anything ────────────────
  //
  // The check above asks whether the DECLARED verifier is speaking. It cannot
  // ask whether the declaration was legitimate — a definition writing
  // `verifiedBy: 'orchestrator'` satisfies it while breaking the rule it
  // exists to enforce, and ADM-82 names that exact violation: *"THE
  // ORCHESTRATOR MUST NOT judge completion, act as QA, override QA, or
  // certify delivery."*
  //
  // check-record §14 refuses such a definition at build time. This is the
  // runtime half, and it is here because a build-time check protects the
  // repository while this protects the call.
  if (!verifier.mayVerify) {
    return err(
      'FORBIDDEN',
      `${verifier.key} may not verify anything — ADM-82 gives that authority to QA alone, ` +
        `and being named as ${producer.key}'s verifier does not confer it.`,
    );
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
