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

export function scoreLead(inputs: LeadScoreInputs): LeadScore {
  const reasons: LeadScoreReason[] = [];
  const covered = new Set(inputs.coveredAreas);

  const coveragePoints = Math.round((Math.min(covered.size, COVERAGE_AREA_COUNT) / COVERAGE_AREA_COUNT) * 25);
  reasons.push({
    code: 'coverage',
    points: coveragePoints,
    detail: `${covered.size} of ${COVERAGE_AREA_COUNT} qualification areas covered`,
  });

  if (inputs.budgetMinor !== null && inputs.budgetMinor > 0) {
    reasons.push({ code: 'budget_known', points: 15, detail: 'a budget is recorded on the qualification' });
  }

  if (inputs.isDecisionMaker === true) {
    reasons.push({ code: 'decision_maker', points: 15, detail: 'the contact is recorded as the decision-maker' });
  }

  if ((inputs.timelineNote ?? '').trim() !== '' || covered.has('timeline')) {
    reasons.push({ code: 'timeline_stated', points: 10, detail: 'a timeline has been stated' });
  }

  const replies = Math.max(0, Math.floor(inputs.clientReplies));
  const engagementPoints = replies === 0 ? 0 : replies <= 2 ? 8 : 15;
  reasons.push({
    code: 'engagement',
    points: engagementPoints,
    detail: replies === 0 ? 'the client has not replied' : `${replies} client repl${replies === 1 ? 'y' : 'ies'}`,
  });

  const quietDays = daysBetween(inputs.lastActivityAt, inputs.asOf);
  const recencyPoints = quietDays <= 2 ? 10 : quietDays <= 7 ? 5 : 0;
  reasons.push({
    code: 'recency',
    points: recencyPoints,
    detail: quietDays === 0 ? 'active today' : `last activity ${quietDays} day${quietDays === 1 ? '' : 's'} ago`,
  });

  if (inputs.dealValueMinor !== null && inputs.dealValueMinor > 0) {
    reasons.push({ code: 'deal_value', points: 5, detail: `an opportunity with a value is open${inputs.dealStage ? ` (${inputs.dealStage})` : ''}` });
  }

  if (inputs.source === 'referral') {
    reasons.push({ code: 'referral', points: 5, detail: 'came by referral' });
  }

  const ageDays = daysBetween(inputs.createdAt, inputs.asOf);
  if ((inputs.status === 'new' || inputs.status === 'qualifying') && ageDays > 60) {
    reasons.push({ code: 'stale', points: -10, detail: `${inputs.status} for ${ageDays} days` });
  }

  let score = Math.max(0, Math.min(100, reasons.reduce((sum, r) => sum + r.points, 0)));

  if (inputs.status === 'disqualified') {
    reasons.push({ code: 'disqualified', points: -score, detail: 'the lead is disqualified, so it scores 0' });
    score = 0;
  }

  return { score, reasons, inputs };
}
