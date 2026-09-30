/**
 * Project health — the one at-risk rule, shared by the projects list and the
 * dashboard's project health table (SCR-001 "Project health table", bucket
 * F rule 1: the same rule, not a second one).
 *
 * Pure. A project is AT RISK when it carries a Phase 4 escalation or its
 * end date has passed while it is still open; it is ON TRACK otherwise; a
 * finished or cancelled project is DONE and never at risk. `todayKey` is
 * the agency's own day (`clock.dayKey`), never the server's.
 */

export type ProjectHealth = 'on_track' | 'at_risk' | 'done';

export type ProjectHealthInput = {
  status: string;
  endsOn: string | null;
  /** True when a Phase 4 escalation names this project. */
  escalated: boolean;
  /** `YYYY-MM-DD` in the agency's zone. */
  todayKey: string;
};

const CLOSED = new Set(['completed', 'cancelled']);

export function isLate(input: Pick<ProjectHealthInput, 'status' | 'endsOn' | 'todayKey'>): boolean {
  return !CLOSED.has(input.status) && input.endsOn !== null && input.endsOn < input.todayKey;
}

export function projectHealth(input: ProjectHealthInput): ProjectHealth {
  if (CLOSED.has(input.status)) return 'done';
  if (input.escalated || isLate(input)) return 'at_risk';
  return 'on_track';
}

export const PROJECT_HEALTH_LABEL: Record<ProjectHealth, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  done: 'Done',
};

export const PROJECT_HEALTH_TONE: Record<ProjectHealth, 'success' | 'danger' | 'neutral'> = {
  on_track: 'success',
  at_risk: 'danger',
  done: 'neutral',
};

/** Why it is at risk, in the words the projects list uses. */
export function projectHealthReason(input: ProjectHealthInput): string | null {
  if (projectHealth(input) !== 'at_risk') return null;
  const reasons = [input.escalated ? 'escalated' : '', isLate(input) ? 'past due' : ''].filter(Boolean);
  return reasons.join(' · ');
}
