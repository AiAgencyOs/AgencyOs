/**
 * A lead's score — ADM-88, Decision: reversed by the owner on 2026-09-29.
 *
 * A 0–100 number computed HERE, deterministically, from facts the lead
 * already carries, and stored (by `crm.set_lead_score`) only together with
 * the reasons that add up to it and the inputs it was read from. The old
 * rule refused any score because "the repository has no approved scoring
 * model"; this file IS the model, every weight is written down beside the
 * fact it weighs, and nothing here reads anything a person cannot see on
 * the lead's own page.
 *
 * Pure and dependency-free, like `lead-score-service.ts`'s other half
 * `autonomy.ts` is to the runner: a test calls it with a literal and reads
 * the number back, and the thing that gathers the inputs holds a database
 * client a test has no business holding.
 *
 * ── the weights, and why they add up to 100 ─────────────────────────────
 *
 *   qualification coverage   0–25  Doc 09 §9's fifteen areas, as recorded
 *                                  in crm.qualification_coverage. 25 × the
 *                                  fraction covered, rounded.
 *   budget known               15  qualification.budgetMinor > 0.
 *   decision-maker             15  qualification.isDecisionMaker === true.
 *   timeline stated            10  a timelineNote, or the 'timeline' area
 *                                  covered.
 *   engagement               0–15  the client's own replies on the lead's
 *                                  conversations: 0 → 0, 1–2 → 8, 3+ → 15.
 *   recency                  0–10  days since last activity: ≤2 → 10,
 *                                  ≤7 → 5, else 0.
 *   deal value                  5  an open opportunity with value_minor > 0.
 *   referral                    5  source = 'referral'.
 *                            ───
 *                             100
 *
 * Two deductions, both stated as reasons when they apply:
 *   stale                     −10  new/qualifying and created > 60 days ago.
 *   disqualified            → 0    a disqualified lead scores 0 whatever
 *                                  else is true; the reason says so.
 */

export const COVERAGE_AREA_COUNT = 15;

/**
 * P1-CRM-020 — the points each factor is worth, as DATA. The numbers in the table above are the DEFAULTS (`DEFAULT_LEAD_SCORE_WEIGHTS`); an administrator
 * can save a different, complete set (`crm.p1s_set_lead_score_weights`, versioned and audited, at /settings/lead-scoring) and the database refuses a set
 * whose eight positive maxima do not add up to 100. The thresholds (3+ replies, 2 and 7 days, 60 days) are part of the model and stay here.
 */
export type LeadScoreWeights = {
  coverage_max: number;
  budget_known: number;
  decision_maker: number;
  timeline_stated: number;
  engagement_some: number;
  engagement_many: number;
  recency_fresh: number;
  recency_recent: number;
  deal_value: number;
  referral: number;
  stale_penalty: number;
};

export const LEAD_SCORE_WEIGHT_KEYS = [
  'coverage_max',
  'budget_known',
  'decision_maker',
  'timeline_stated',
  'engagement_some',
  'engagement_many',
  'recency_fresh',
  'recency_recent',
  'deal_value',
  'referral',
  'stale_penalty',
] as const satisfies readonly (keyof LeadScoreWeights)[];

/** The positive maxima: the eight that must add up to 100. */
const POSITIVE_MAXIMA = ['coverage_max', 'budget_known', 'decision_maker', 'timeline_stated', 'engagement_many', 'recency_fresh', 'deal_value', 'referral'] as const;

export const DEFAULT_LEAD_SCORE_WEIGHTS: Readonly<LeadScoreWeights> = Object.freeze({
  coverage_max: 25,
  budget_known: 15,
  decision_maker: 15,
  timeline_stated: 10,
  engagement_some: 8,
  engagement_many: 15,
  recency_fresh: 10,
  recency_recent: 5,
  deal_value: 5,
  referral: 5,
  stale_penalty: 10,
});

/** The same rule `crm.p1s_lead_score_weights_problem` enforces; the database is the authority, this gives the form a message before the round trip. */
export function leadScoreWeightsProblem(w: Partial<Record<string, unknown>>): string | null {
  for (const k of Object.keys(w)) if (!(LEAD_SCORE_WEIGHT_KEYS as readonly string[]).includes(k)) return `unknown weight "${k}"`;
  for (const k of LEAD_SCORE_WEIGHT_KEYS) {
    const v = w[k];
    if (v === undefined) return `weight "${k}" is missing: a set is complete`;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return `weight "${k}" must be a whole number`;
    if (v > 100) return `weight "${k}" cannot exceed 100`;
  }
  const n = w as LeadScoreWeights;
  if (n.stale_penalty > 50) return 'the stale penalty cannot exceed 50';
  if (n.engagement_some > n.engagement_many) return 'a few replies cannot be worth more than many';
  if (n.recency_recent > n.recency_fresh) return 'a week-old reply cannot be worth more than a fresh one';
  const sum = POSITIVE_MAXIMA.reduce((total, k) => total + n[k], 0);
  return sum === 100 ? null : `the positive weights add up to ${sum}, not 100`;
}

export type LeadScoreInputs = {
  source: string;
  status: string;
  /** ISO. */
  createdAt: string;
  /** ISO — `crm.leads.updated_at`, the same value the list shows as "Last activity". */
  lastActivityAt: string;
  /** ISO — the moment the score is computed against, so it is reproducible. */
  asOf: string;
  budgetMinor: number | null;
  isDecisionMaker: boolean | null;
  timelineNote: string | null;
  /** The qualification areas recorded as covered, deduplicated. */
  coveredAreas: readonly string[];
  /** Messages the client wrote on this lead's conversations. */
  clientReplies: number;
  /** The open opportunity's value, if there is one. */
  dealValueMinor: number | null;
  dealStage: string | null;
};

export type LeadScoreReason = {
  code:
    | 'coverage'
    | 'budget_known'
    | 'decision_maker'
    | 'timeline_stated'
    | 'engagement'
    | 'recency'
    | 'deal_value'
    | 'referral'
    | 'stale'
    | 'disqualified';
  points: number;
  detail: string;
};

export type LeadScore = {
  score: number;
  reasons: readonly LeadScoreReason[];
  inputs: LeadScoreInputs;
};

const DAY = 86_400_000;

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / DAY));
}

export function scoreLead(inputs: LeadScoreInputs, weights: Readonly<LeadScoreWeights> = DEFAULT_LEAD_SCORE_WEIGHTS): LeadScore {
  const reasons: LeadScoreReason[] = [];
  const covered = new Set(inputs.coveredAreas);

  const coveragePoints = Math.round((Math.min(covered.size, COVERAGE_AREA_COUNT) / COVERAGE_AREA_COUNT) * weights.coverage_max);
  reasons.push({
    code: 'coverage',
    points: coveragePoints,
    detail: `${covered.size} of ${COVERAGE_AREA_COUNT} qualification areas covered`,
  });

  if (inputs.budgetMinor !== null && inputs.budgetMinor > 0) {
    reasons.push({ code: 'budget_known', points: weights.budget_known, detail: 'a budget is recorded on the qualification' });
  }

  if (inputs.isDecisionMaker === true) {
    reasons.push({ code: 'decision_maker', points: weights.decision_maker, detail: 'the contact is recorded as the decision-maker' });
  }

  if ((inputs.timelineNote ?? '').trim() !== '' || covered.has('timeline')) {
    reasons.push({ code: 'timeline_stated', points: weights.timeline_stated, detail: 'a timeline has been stated' });
  }

  const replies = Math.max(0, Math.floor(inputs.clientReplies));
  const engagementPoints = replies === 0 ? 0 : replies <= 2 ? weights.engagement_some : weights.engagement_many;
  reasons.push({
    code: 'engagement',
    points: engagementPoints,
    detail: replies === 0 ? 'the client has not replied' : `${replies} client repl${replies === 1 ? 'y' : 'ies'}`,
  });

  const quietDays = daysBetween(inputs.lastActivityAt, inputs.asOf);
  const recencyPoints = quietDays <= 2 ? weights.recency_fresh : quietDays <= 7 ? weights.recency_recent : 0;
  reasons.push({
    code: 'recency',
    points: recencyPoints,
    detail: quietDays === 0 ? 'active today' : `last activity ${quietDays} day${quietDays === 1 ? '' : 's'} ago`,
  });

  if (inputs.dealValueMinor !== null && inputs.dealValueMinor > 0) {
    reasons.push({ code: 'deal_value', points: weights.deal_value, detail: `an opportunity with a value is open${inputs.dealStage ? ` (${inputs.dealStage})` : ''}` });
  }

  if (inputs.source === 'referral') {
    reasons.push({ code: 'referral', points: weights.referral, detail: 'came by referral' });
  }

  const ageDays = daysBetween(inputs.createdAt, inputs.asOf);
  if ((inputs.status === 'new' || inputs.status === 'qualifying') && ageDays > 60) {
    reasons.push({ code: 'stale', points: -weights.stale_penalty, detail: `${inputs.status} for ${ageDays} days` });
  }

  let score = Math.max(0, Math.min(100, reasons.reduce((sum, r) => sum + r.points, 0)));

  if (inputs.status === 'disqualified') {
    reasons.push({ code: 'disqualified', points: -score, detail: 'the lead is disqualified, so it scores 0' });
    score = 0;
  }

  return { score, reasons, inputs };
}
