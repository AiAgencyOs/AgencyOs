import { cumulativeLadder, phaseSevenGate } from '@/modules/projects/payment-structure';

/**
 * Saying where a project is on Finance §12's ladder — G-268.
 *
 * G-251 wrote the gate as a pure function nothing computed the number for.
 * G-264 computed the number and gave the function a caller — and that caller,
 * `readPaymentProgress`, has itself never been read by anything. The rule has
 * now been half-checked twice: stated, then derived, and never shown to the
 * person it is about.
 *
 * This is the wording, kept pure so it can be exercised without a database and
 * without a browser. It decides nothing: `phaseSevenGate` owns "100% or it
 * stays shut" and `finance.project_payment_progress` owns the percentage.
 *
 * The distinction the whole module exists to preserve is between **three**
 * states that a careless page renders identically as *0%*:
 *
 *   * **unreadable** — the read failed and we do not know;
 *   * **unmeasurable** — no plan adds to 100%, so there is no percentage;
 *   * **measured at zero** — a real plan with nothing verified yet.
 *
 * The first is a fault, the second is a missing payment plan, and the third is
 * an unpaid client. Three different people fix those.
 */

export type LadderProgress = {
  verifiedPercent: number | null;
  measurable: boolean;
  milestones: number;
  verifiedMilestones: number;
  gate: { open: boolean; shortfallPercent: number };
};

export type LadderRung = {
  cumulative: number;
  /** Cleared means *verified* — captured-and-verified less refunds (ADM-04). */
  cleared: boolean;
};

/**
 * The rungs of §12's ladder with the ones this project has cleared.
 *
 * The ladder is `cumulativeLadder()`'s, not a second copy: 30/20/30/20 is
 * ADM-105's and a page restating it is a second thing to keep in step.
 *
 * An unmeasurable project gets the rungs with **none** cleared rather than an
 * empty list, because the ladder is what the client agreed to and showing
 * nothing would read as "this project has no payment plan at all" — which is
 * a different fact, and one the caption says in words.
 */
export function ladderRungs(progress: LadderProgress): LadderRung[] {
  // Stated rather than encoded as a sentinel. The first draft used -1 as the
  // unmeasurable percentage so the comparison "just worked" — and a red-proof
  // swapping it to 0 changed nothing, because the locked ladder has no 0%
  // rung. A control no test can bite is a comment with a semicolon.
  if (!progress.measurable) {
    return cumulativeLadder().map((rung) => ({ cumulative: rung.cumulative, cleared: false }));
  }

  const verified = progress.verifiedPercent ?? 0;
  return cumulativeLadder().map((rung) => ({
    cumulative: rung.cumulative,
    cleared: verified >= rung.cumulative,
  }));
}

/**
 * One sentence about the money, and one about the gate.
 *
 * `null` for a read that failed — the caller says so in its own words, because
 * "could not read" belongs with the rest of the page's error handling and not
 * inside a describer that would have to invent a tone for it.
 */
export function describeLadder(progress: LadderProgress): { money: string; gate: string } {
  if (!progress.measurable) {
    return {
      // Not "0% verified". No percentage exists, and printing one invites
      // somebody to chase a client who has not been billed anything.
      money: 'No payment plan on this project adds to 100%, so there is no percentage to verify against.',
      gate: 'The final phase stays shut until a payment plan exists and is fully verified.',
    };
  }

  const percent = progress.verifiedPercent ?? 0;
  const money =
    `${percent}% of the payment plan is verified — ` +
    `${progress.verifiedMilestones} of ${progress.milestones} priced milestone` +
    `${progress.milestones === 1 ? '' : 's'}.`;

  if (progress.gate.open) {
    return {
      money,
      // Deliberately "may open" rather than "is open": nothing in this
      // deployment unlocks Phase 7, because Phases 4–6 do not exist yet. A
      // page claiming the phase opened would be describing a step nobody took.
      gate: 'Fully verified — the final phase may open.',
    };
  }

  return {
    money,
    gate: `The final phase stays shut: ${progress.gate.shortfallPercent}% is still to be verified.`,
  };
}

/**
 * What *verified* costs, said once, where somebody reads the number.
 *
 * Both halves are surprises to a person watching their bank account: money
 * that has arrived does not count until an Admin confirms it (ADM-04, Finance
 * §6), and a refund takes the percentage back down rather than leaving a
 * high-water mark.
 */
export const LADDER_CAPTION =
  'Verified means an Admin confirmed the payment against the bank — money received but not yet ' +
  'confirmed counts for nothing here, and a refund takes the percentage back down.';

/**
 * The row `finance.project_payment_progress` returns, shaped once.
 *
 * Pure, and the **only** place the gate is applied, because the service and
 * the query both reach the same rule by different doors and two copies of
 * "what an unmeasurable plan means" is how the two doors start to disagree.
 *
 * An unmeasurable plan is **forced shut** rather than passed through as 0.
 * `phaseSevenGate(0)` answers the same today — but it would be answering a
 * question about a percentage nobody computed, and the day somebody relaxes
 * that function an unmeasurable project would open the last phase on
 * arithmetic that does not exist.
 */
export function toLadderProgress(row: {
  verified_percent?: number | null;
  plan_total_percent?: number | null;
  measurable?: boolean;
  milestones?: number;
  verified_milestones?: number;
}): LadderProgress & { planTotalPercent: number | null } {
  const measurable = row.measurable === true;
  const verifiedPercent = measurable ? Number(row.verified_percent ?? 0) : null;

  return {
    verifiedPercent,
    planTotalPercent:
      row.plan_total_percent === null || row.plan_total_percent === undefined
        ? null
        : Number(row.plan_total_percent),
    measurable,
    milestones: row.milestones ?? 0,
    verifiedMilestones: row.verified_milestones ?? 0,
    gate: measurable ? phaseSevenGate(verifiedPercent!) : { open: false, shortfallPercent: 100 },
  };
}
