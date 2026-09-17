/**
 * The operational plan's closed vocabularies — Project Planning §7, §8, §15.
 *
 * Pure, with no `server-only`, so a surface, a test or a job can all read the
 * same lists. They are closed on purpose: every value here is one a locked
 * document names, and a fourth kind or an eighth phase would be a lifecycle
 * invented in a constant.
 */

/** §7's three maps — major milestones, finance gates, client approval points. */
export const PLAN_MILESTONE_KINDS = ['operational', 'finance_gate', 'client_approval'] as const;
export type PlanMilestoneKind = (typeof PLAN_MILESTONE_KINDS)[number];

/**
 * The phases these four documents actually name.
 *
 * `phase_2` is this one, `phase_3` is what it hands to, and 4–7 come from
 * ADM-105's milestone triggers and Finance §7's 100% gate. There is no
 * `phase_8`: no locked document in this set names one.
 */
export const PLAN_PHASES = ['phase_2', 'phase_3', 'phase_4', 'phase_5', 'phase_6', 'phase_7'] as const;
export type PlanPhase = (typeof PLAN_PHASES)[number];

/** A milestone's state. Set by a person — nothing here derives it from a date. */
export const PLAN_MILESTONE_STATUSES = ['planned', 'at_risk', 'met', 'missed', 'not_applicable'] as const;
export type PlanMilestoneStatus = (typeof PLAN_MILESTONE_STATUSES)[number];
