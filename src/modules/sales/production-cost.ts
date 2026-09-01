/**
 * What it costs to make — G-179.
 *
 * The pricing principle the owner stated, in code:
 *
 *     production cost × 2    minimum
 *     production cost × 2.5  recommended
 *     production cost × 3    premium
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A SECOND PRICING ENGINE, AND MUST NOT BECOME ONE
 *
 * `pricing-reference.ts` answers *what has this agency charged for a shape
 * like this* — fitted to 45 real quotations, from the outside in. This
 * answers a different question: *what would it cost us to build*, from the
 * inside out. They disagree often, and the disagreement is the useful part.
 *
 * A zero-trust audit found that the second question had no answer at all:
 * no production cost, no AI cost, no multiplier, nothing in the repository
 * that could produce one. So a quotation could sit below cost and nothing
 * in the system would know.
 *
 * Both are ADVISORY and APPROVER-ONLY. ADM-22 and ADM-07 leave the price
 * with the owner, and a control that overrides them has quietly moved the
 * decision into code. Neither of these blocks a draft, and neither is ever
 * drawn on a document a client receives.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHERE THE NUMBERS COME FROM, AND WHY NONE OF THEM IS HARD-CODED
 *
 * The audit's other pricing finding was that the corpus formula lives in a
 * TypeScript literal: the owner cannot change their own pricing without an
 * engineer. Every input here is an organization setting instead, written
 * through `core.set_organization_setting` and audited like any other.
 *
 *   pricing_day_rate_rupees      what a developer-day costs the agency
 *   pricing_ai_day_rate_rupees   what AI and tooling cost per developer-day
 *   pricing_multiplier_min       the floor band      (the owner's ×2)
 *   pricing_multiplier_target    the recommended one (×2.5)
 *   pricing_multiplier_max       the premium one     (×3)
 *
 * **Unconfigured means silent.** An agency that has not set its rates gets
 * exactly the behaviour it had before this existed, rather than a note
 * about a model it never asked for. The settings page is where the absence
 * is visible; a quotation is not.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHERE THE EFFORT COMES FROM
 *
 * The model that wrote the line estimates its days. That is the only honest
 * source: the corpus timeline band is derived FROM the price, so using it
 * here would make the cost a function of the price and the whole comparison
 * circular.
 *
 * A scope where no line carries an estimate produces no cost, and says
 * nothing. Half-estimated is treated the same way — a cost built from three
 * of five lines is not a cost, it is an underestimate wearing one, and
 * printing it beside a price would be worse than printing nothing.
 */

/** Whole rupees throughout, like every other price in this module. */
export interface ProductionCost {
  /** Developer-days the model estimated, summed across the lines. */
  days: number;
  /** days × (day rate + AI day rate), in whole rupees. */
  costRupees: number;
  /** The three reference bands, rounded to the nearest ₹5,000 like the corpus. */
  minimumRupees: number;
  recommendedRupees: number;
  premiumRupees: number;
  /** The derivation, in the order it was applied — shown, never summarised. */
  basis: readonly string[];
}

export interface CostSettings {
  dayRateRupees: number;
  aiDayRateRupees: number;
  multiplierMin: number;
  multiplierTarget: number;
  multiplierMax: number;
}

/**
 * The five settings, or null when they are absent, unreadable or incoherent.
 *
 * Incoherent is deliberately in that list. A configuration where the minimum
 * band exceeds the premium one produces three numbers in an order nobody can
 * act on, and the honest answer to a contradictory configuration is to say
 * nothing rather than to pick a reading of it.
 */
export function costSettingsFrom(settings: unknown): CostSettings | null {
  if (!settings || typeof settings !== 'object') return null;
  const bag = settings as Record<string, unknown>;

  const number = (key: string): number | null => {
    const raw = bag[key];
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const dayRateRupees = number('pricing_day_rate_rupees');
  const aiDayRateRupees = number('pricing_ai_day_rate_rupees');
  const multiplierMin = number('pricing_multiplier_min');
  const multiplierTarget = number('pricing_multiplier_target');
  const multiplierMax = number('pricing_multiplier_max');

  if (
    dayRateRupees === null ||
    aiDayRateRupees === null ||
    multiplierMin === null ||
    multiplierTarget === null ||
    multiplierMax === null
  ) {
    return null;
  }

  // A day that costs nothing is not a configuration, it is an empty field
  // that parsed. The multipliers must be in order and above one — a "price"
  // at or below cost is not a band anybody meant to configure.
  if (dayRateRupees <= 0 || aiDayRateRupees < 0) return null;
  if (!(multiplierMin > 1 && multiplierMin <= multiplierTarget && multiplierTarget <= multiplierMax)) {
    return null;
  }

  return { dayRateRupees, aiDayRateRupees, multiplierMin, multiplierTarget, multiplierMax };
}

export interface EffortScope {
  items: ReadonlyArray<{ description: string; effortDays?: number | null }>;
}

function round5k(n: number): number {
  return Math.round(n / 5_000) * 5_000;
}

/**
 * What this scope costs to build, and the three bands above it.
 *
 * Null when the agency has no rates configured, and null when the scope is
 * not fully estimated — see the module header for why a partial estimate is
 * refused rather than extrapolated.
 */
export function productionCostFor(
  scope: EffortScope,
  settings: CostSettings | null,
): ProductionCost | null {
  if (!settings) return null;
  if (scope.items.length === 0) return null;

  const estimated = scope.items.filter(
    (i) => typeof i.effortDays === 'number' && Number.isFinite(i.effortDays) && i.effortDays > 0,
  );
  if (estimated.length !== scope.items.length) return null;

  const days = estimated.reduce((sum, i) => sum + (i.effortDays as number), 0);
  const perDay = settings.dayRateRupees + settings.aiDayRateRupees;
  const costRupees = Math.round(days * perDay);

  const money = (n: number) => `₹${n.toLocaleString('en-IN')}`;
  const basis = [
    `${days} developer-day(s) estimated across ${scope.items.length} line(s)`,
    `× ${money(perDay)} per day (${money(settings.dayRateRupees)} build + ${money(settings.aiDayRateRupees)} AI and tooling)`,
    `= ${money(costRupees)} to produce`,
  ];

  return {
    days,
    costRupees,
    minimumRupees: round5k(costRupees * settings.multiplierMin),
    recommendedRupees: round5k(costRupees * settings.multiplierTarget),
    premiumRupees: round5k(costRupees * settings.multiplierMax),
    basis,
  };
}

/**
 * What gets frozen onto the quotation — the same discipline G-172 chose.
 *
 * The figure recorded has to be the one that was in front of the decider.
 * Recomputing it at render time would answer a different question: what
 * TODAY'S day rate says about an August quotation. That is a re-judgement
 * with hindsight rather than a record — and these rates are now editable
 * from a settings page, so they will move, which is exactly the drift that
 * would silently rewrite history.
 *
 * A type alias rather than an interface: only aliases get an implicit index
 * signature, and this shape is written straight into a jsonb column typed as
 * Json.
 */
export type StoredProductionCost = {
  days: number;
  costRupees: number;
  minimumRupees: number;
  recommendedRupees: number;
  premiumRupees: number;
  basis: string[];
};

export function storedProductionCostFor(
  scope: EffortScope,
  settings: CostSettings | null,
): StoredProductionCost | null {
  const cost = productionCostFor(scope, settings);
  if (!cost) return null;
  return {
    days: cost.days,
    costRupees: cost.costRupees,
    minimumRupees: cost.minimumRupees,
    recommendedRupees: cost.recommendedRupees,
    premiumRupees: cost.premiumRupees,
    basis: [...cost.basis],
  };
}

/**
 * The sentence the approver reads, or null when there is nothing to say.
 *
 * Two rules keep this from becoming noise, and they are the same two
 * `pricingNoteFor` uses.
 *
 * It is silent when the proposed price is at or above the MINIMUM band,
 * because everything from there upwards is the owner pricing their own work
 * and needs no comment. It speaks when a price is below the floor the owner's
 * own multiplier defines — the one case this whole model exists to surface,
 * and the one the corpus formula cannot see, because the corpus records what
 * this agency CHARGED and not what it cost.
 *
 * It never says a price is wrong. The owner may have every reason to take
 * work at cost; the note's job is to make sure that was a decision.
 *
 * Reads the FROZEN block rather than recomputing — see `StoredProductionCost`.
 */
export function productionCostNoteFor(input: {
  proposedRupees: number;
  cost: StoredProductionCost | null | undefined;
}): string | null {
  const cost = input.cost;
  if (!cost) return null;
  if (input.proposedRupees <= 0) return null;
  if (!Number.isFinite(cost.costRupees) || cost.costRupees <= 0) return null;
  if (!Number.isFinite(cost.minimumRupees) || cost.minimumRupees <= 0) return null;
  if (input.proposedRupees >= cost.minimumRupees) return null;

  const money = (n: number) => `₹${n.toLocaleString('en-IN')}`;
  const belowCost = input.proposedRupees < cost.costRupees;

  return [
    `FOR THE APPROVER ONLY — not shown to the client.`,
    `This draft is ${money(input.proposedRupees)}.`,
    `${(cost.basis ?? []).join('; ')}.`,
    `Your own bands: minimum ${money(cost.minimumRupees)}, recommended ${money(cost.recommendedRupees)}, premium ${money(cost.premiumRupees)}.`,
    belowCost
      ? `This price is BELOW what the work costs to produce — the agency pays to do it.`
      : `This price is above cost but below your minimum band.`,
    `The rates and multipliers behind these figures are yours, on the Settings page. The price is yours to set.`,
  ].join(' ');
}
