/**
 * The locked project payment structure — ADM-105, Phase 2 Finance §2.
 *
 * **What the owner decided, and what it displaced.**
 *
 * The Phase 2 Finance specification locks four milestones — 30 · 20 · 30 · 20 —
 * as *compulsory for the standard project payment structure*, triggered by
 * Phase 2 and by the completion of Phases 4, 5 and 6. This repository already
 * had a payment schedule: `sales/quotation-standards.ts` derives a QUOTATION's
 * schedule from the corpus families (40/30/30 below ₹1,00,000, 30/30/25/15
 * from ₹1,00,000, both triggered by demo events) or from a structure the owner
 * configured and froze onto the quotation.
 *
 * They disagree, and the disagreement was raised rather than resolved:
 * **ADM-105, answered 2026-09-16 — the locked 30/20/30/20 governs.**
 *
 * **The tension that survives the answer, stated rather than hidden.** A
 * client who accepted a quotation whose document showed 40/30/30 will receive
 * a first invoice for 30%. That is a difference between a document a client
 * read and a bill they are sent, and no amount of code makes it not one. What
 * the code can do is refuse to hide it: `structureDiffersFromQuotation` names
 * the difference so a person sees it before the invoice goes out, and nothing
 * here overwrites a payment plan a person configured by hand.
 *
 * Pure, and deliberately so: percentages, cumulative gates and the arithmetic
 * that turns them into money are the part the Finance specification is most
 * emphatic about — *"Use deterministic code/config for money, tax, percentages
 * and gates; never rely on free-form LLM arithmetic as source of truth."*
 */

/** Which phase's completion releases each milestone's invoice — Finance §2 and §8. */
export type MilestoneTrigger = 'phase_2' | 'phase_4_completed' | 'phase_5_completed' | 'phase_6_completed';

export type LockedMilestone = {
  /** M1–M4, the names Finance §2 uses. */
  readonly key: 'M1' | 'M2' | 'M3' | 'M4';
  readonly position: number;
  readonly percent: number;
  readonly trigger: MilestoneTrigger;
  /** What the client sees on the plan. */
  readonly name: string;
  /** The financial purpose Finance §2 gives it, for the record rather than the client. */
  readonly purpose: string;
};

/**
 * ADM-105's answer, transcribed. Four rows, in order, summing to 100.
 *
 * **Mandatory, not "only if needed"** — Finance §2 says so in those words, and
 * §21 says not to make the post-Phase-4/5/6 triggers optional. So all four are
 * installed together at Phase 2 rather than one at a time as their phases
 * arrive: a structure that grows a milestone whenever somebody remembers is a
 * structure a client can be under-billed by.
 */
export const LOCKED_PAYMENT_STRUCTURE: readonly LockedMilestone[] = [
  {
    key: 'M1',
    position: 1,
    percent: 30,
    trigger: 'phase_2',
    name: 'Advance (30%)',
    purpose: 'Advance payment; opens the Phase 2 kickoff gate.',
  },
  {
    key: 'M2',
    position: 2,
    percent: 20,
    trigger: 'phase_4_completed',
    name: 'On UI prototype approval (20%)',
    purpose: 'UI prototype approval milestone.',
  },
  {
    key: 'M3',
    position: 3,
    percent: 30,
    trigger: 'phase_5_completed',
    name: 'On development completion (30%)',
    purpose: 'Full development completion milestone.',
  },
  {
    key: 'M4',
    position: 4,
    percent: 20,
    trigger: 'phase_6_completed',
    name: 'On testing completion (20%)',
    purpose: 'Final testing and QA completion; opens the 100% gate for Phase 7.',
  },
];

/**
 * The cumulative percentage verified once each milestone is paid — 30, 50, 80,
 * 100 (Finance §2 and §12).
 *
 * Derived rather than written down a second time. The specification states
 * both the per-milestone percentages and the cumulative ladder, and a reader
 * who finds them as two constants has two things to keep in step.
 */
export function cumulativeAfter(key: LockedMilestone['key']): number {
  let total = 0;
  for (const milestone of LOCKED_PAYMENT_STRUCTURE) {
    total += milestone.percent;
    if (milestone.key === key) return total;
  }
  return total;
}

/** The whole ladder, for a gate that needs to say what is still owed. */
export function cumulativeLadder(): ReadonlyArray<{ key: LockedMilestone['key']; cumulative: number }> {
  return LOCKED_PAYMENT_STRUCTURE.map((m) => ({ key: m.key, cumulative: cumulativeAfter(m.key) }));
}

/**
 * Phase 7 opens only at 100% VERIFIED — Finance §7, §12.
 *
 * Takes the verified percentage rather than reading it, so the rule can be
 * exercised without a database, and returns what is missing rather than a
 * bare false: a gate that says "no" without saying what is owed is a gate
 * somebody has to go and investigate.
 */
export function phaseSevenGate(verifiedPercent: number): { open: boolean; shortfallPercent: number } {
  const shortfall = Math.max(0, 100 - verifiedPercent);
  return { open: shortfall === 0, shortfallPercent: shortfall };
}

/**
 * The money, to the paisa, with the last row absorbing the remainder.
 *
 * The same rule `quotation-standards.ts` states as Part L — *Σ milestones =
 * total* — and the same arithmetic, because two ways of splitting money is one
 * too many. A budget no percentage divides cleanly still sums to the budget.
 */
export function lockedAmountsFor(budgetMinor: number): number[] {
  const rows: number[] = [];
  let taken = 0;
  LOCKED_PAYMENT_STRUCTURE.forEach((milestone, index) => {
    const amount =
      index === LOCKED_PAYMENT_STRUCTURE.length - 1
        ? budgetMinor - taken
        : Math.round((budgetMinor * milestone.percent) / 100);
    rows.push(amount);
    taken += amount;
  });
  return rows;
}

/**
 * Whether the quotation the client accepted showed a different shape.
 *
 * ADM-105 settled which structure governs; it did not make the difference
 * disappear. A client who read 40/30/30 and is billed 30% first is owed the
 * explanation, and the person sending the invoice is owed the warning — so the
 * comparison is a value a surface can render, not a comment nobody reads.
 *
 * Null when the quotation carried no schedule, which is every quotation
 * drafted before the owner configured terms.
 */
export function structureDiffersFromQuotation(
  quotationPercents: readonly number[] | null | undefined,
): { differs: boolean; quotation: readonly number[]; locked: readonly number[] } | null {
  if (!quotationPercents || quotationPercents.length === 0) return null;
  const locked = LOCKED_PAYMENT_STRUCTURE.map((m) => m.percent);
  const differs =
    quotationPercents.length !== locked.length ||
    quotationPercents.some((pct, index) => pct !== locked[index]);
  return { differs, quotation: [...quotationPercents], locked };
}
