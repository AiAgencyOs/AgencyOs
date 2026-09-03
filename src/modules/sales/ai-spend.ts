import 'server-only';

/**
 * What the agency charged itself for AI, against what AI actually cost —
 * G-201 (Doc 08, QM-11).
 *
 * ── the finding this answers, and the two it does not ─────────────────────
 *
 * QM-09 and QM-10 ask for a **Claude Code / AI agent workload analysis**: an
 * estimate of what building a particular client project will cost in agent
 * time. There is nothing in this repository to build that from. No
 * delivery-side agent has ever run — ADM-82 approved thirteen, two are
 * defined, and the runs that exist are the sales agents reading and drafting
 * — so an "analysis" would be a model guessing token counts for a project
 * nobody has started.
 *
 * That is the fabricated number Doc 05 §35 and ADM-76 both refuse, and it is
 * the same refusal migration 156 made about §21's negotiation limits: the
 * absence is recorded rather than filled in. **QM-09 and QM-10 are not built,
 * and this comment is where a reader will look for why.**
 *
 * ── what CAN be said, truthfully ──────────────────────────────────────────
 *
 * QM-11 is different. The agency sets one number — `pricing_ai_day_rate_rupees`
 * — and every cost floor since G-179 has been computed with it. Whether that
 * number is anywhere near right has never been checkable.
 *
 * Now it is, because both halves are recorded:
 *
 *   BUDGETED   Σ (days × the AI rate) over the quotations drafted in a window,
 *              read from each one's own FROZEN production cost — the rate
 *              that was in force when it was drafted, not today's.
 *
 *   MEASURED   Σ `ai.cost_ledger.cost_minor` over the same window, which is
 *              what this agency's agents actually cost.
 *
 * Same agency, same period, both from rows. No estimate anywhere.
 *
 * ── and the limitation is part of the sentence ────────────────────────────
 *
 * The measured side is what the SALES agents cost — reading messages,
 * drafting quotations, summarising threads. It is not what building the
 * clients' software costs, because nothing here builds software yet. A
 * comparison that hid that would be the fabrication wearing a measurement's
 * clothes, so the sentence says it out loud.
 */

export interface AiSpendComparison {
  /** Whole rupees the quotations in this window budgeted for AI and tooling. */
  budgetedRupees: number;
  /** Whole rupees the agency's own agents actually cost in the same window. */
  measuredRupees: number;
  /** How many quotations contributed a budgeted figure. */
  quotations: number;
  /** How many agent runs the measured figure is made of. */
  runs: number;
  windowDays: number;
}

/**
 * The sentence an owner reads beside the rate they set.
 *
 * Null when there is nothing to say — no quotations with a frozen cost, or no
 * measured spend. A comparison with a zero on one side is not a comparison,
 * and a line that appears on every settings page saying "0 vs 0" is a line
 * nobody reads by the second visit.
 */
export function aiSpendSentence(input: AiSpendComparison): string | null {
  if (input.quotations === 0 || input.runs === 0) return null;
  if (input.budgetedRupees <= 0 && input.measuredRupees <= 0) return null;

  const money = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  const head =
    `Over the last ${input.windowDays} days your quotations budgeted ` +
    `${money(input.budgetedRupees)} for AI and tooling across ${input.quotations} ` +
    `quotation${input.quotations === 1 ? '' : 's'}, and your agents actually cost ` +
    `${money(input.measuredRupees)} across ${input.runs} run${input.runs === 1 ? '' : 's'}.`;

  // The limitation, always, and never softened: these are the SALES agents.
  const caveat =
    'That measured figure is what your own agents cost — reading messages, drafting ' +
    'quotations — not what building the clients’ software costs, because nothing here ' +
    'builds software yet.';

  return `${head} ${caveat}`;
}

/**
 * Whether the rate looks low enough to be worth a second look.
 *
 * Deliberately not a threshold on the RATE itself, which nobody can judge in
 * the abstract, but on the two totals — and deliberately generous. This is
 * the same posture `productionCostNoteFor` takes about price: advisory,
 * silent in the common case, and never blocking. A settings page that cried
 * wolf about a rate would teach its owner to ignore it.
 */
export function aiSpendLooksLow(input: AiSpendComparison): boolean {
  if (input.quotations === 0 || input.runs === 0) return false;
  if (input.budgetedRupees <= 0) return input.measuredRupees > 0;
  return input.measuredRupees > input.budgetedRupees * 2;
}
