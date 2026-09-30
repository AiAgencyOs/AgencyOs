/**
 * Project health — SCR-026's panel and SCR-018's filter, one rule.
 *
 * Pure so the Reports page, the PDF export and the projects list can never
 * disagree: healthy when nothing below is true; at risk when something is
 * late or escalated; blocked when work cannot move at all. Every input is
 * a count the page already read; nothing here is estimated.
 */
export type ProjectHealthInput = {
  status: string;
  blockedTasks: number;
  unmetDependencies: number;
  overdueTasks: number;
  overdueMilestones: number;
  /** Open defects that block a release (qa's own `blocksDelivery` rule). */
  blockingDefects: number;
  /** Phase 4 stop states (`/projects/escalations`). */
  escalations: number;
  /** Payment claims waiting on verification. */
  pendingClaims: number;
  /** The project's own end date has passed while it is still open. */
  pastDue?: boolean;
};

export type ProjectHealth = { level: 'healthy' | 'at_risk' | 'blocked'; label: string; reasons: string[] };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function projectHealth(input: ProjectHealthInput): ProjectHealth {
  const reasons: string[] = [];
  let level: ProjectHealth['level'] = 'healthy';
  // A finished or cancelled project has nothing left to be healthy about.
  if (input.status === 'completed' || input.status === 'cancelled') return { level, label: 'Healthy', reasons };

  if (input.blockedTasks > 0) {
    level = 'blocked';
    reasons.push(`${plural(input.blockedTasks, 'task is', 'tasks are')} blocked`);
  }
  if (input.unmetDependencies > 0) {
    level = 'blocked';
    reasons.push(`${plural(input.unmetDependencies, 'plan dependency is', 'plan dependencies are')} unmet`);
  }
  if (input.escalations > 0) {
    level = 'blocked';
    reasons.push(`${plural(input.escalations, 'escalation', 'escalations')} waiting on a person`);
  }
  if (input.status === 'on_hold') {
    level = 'blocked';
    reasons.push('the project is on hold');
  }

  const risk = (reason: string) => {
    if (level === 'healthy') level = 'at_risk';
    reasons.push(reason);
  };
  if (input.pastDue) risk('the project is past its due date');
  if (input.overdueTasks > 0) risk(`${plural(input.overdueTasks, 'task is', 'tasks are')} past due`);
  if (input.overdueMilestones > 0) risk(`${plural(input.overdueMilestones, 'milestone is', 'milestones are')} past due and not met`);
  if (input.blockingDefects > 0) risk(`${plural(input.blockingDefects, 'open defect', 'open defects')} would block a release`);
  if (input.pendingClaims > 0) risk(`${plural(input.pendingClaims, 'payment claim', 'payment claims')} waiting on verification`);

  const LABEL: Record<ProjectHealth['level'], string> = { healthy: 'Healthy', at_risk: 'At risk', blocked: 'Blocked' };
  return { level, label: LABEL[level], reasons };
}

/**
 * The facts `readProjectLifecycles` holds for one project, plus the three the
 * caller reads itself, folded into the one rule. The projects list, the project
 * Overview and Reports all end here, so "On track" on one screen and "Blocked"
 * on another (the SCR-018 / SCR-019 contradiction) cannot happen.
 */
export function healthOfProject(
  project: { status: string; endsOn: string | null },
  facts: { blockedTasks: number; unmetDependencies: number; overdueTasks: number; overdueMilestones: number; blockingDefects: number },
  extra: { escalated: boolean; pendingClaims: number; todayKey: string },
): ProjectHealth {
  return projectHealth({
    status: project.status,
    blockedTasks: facts.blockedTasks,
    unmetDependencies: facts.unmetDependencies,
    overdueTasks: facts.overdueTasks,
    overdueMilestones: facts.overdueMilestones,
    blockingDefects: facts.blockingDefects,
    escalations: extra.escalated ? 1 : 0,
    pendingClaims: extra.pendingClaims,
    pastDue: project.endsOn !== null && project.endsOn < extra.todayKey,
  });
}

/**
 * One progress figure for every screen: milestones met when the project has a
 * payment plan, else tasks done. The header on the Overview, the Board, the
 * Reports tile and the projects list all read this, never their own sum.
 */
export function overallProgress(counts: { milestonesTotal: number; milestonesMet: number; tasksTotal: number; tasksDone: number }): number {
  if (counts.milestonesTotal > 0) return Math.round((counts.milestonesMet / counts.milestonesTotal) * 100);
  if (counts.tasksTotal > 0) return Math.round((counts.tasksDone / counts.tasksTotal) * 100);
  return 0;
}

/**
 * One "final delivery date" for the Milestones and Plan pages: the latest due
 * date among the project's milestones, else the project's own end date; and the
 * days from `todayKey` to that same date (negative once it has passed).
 */
export function finalDelivery(milestoneDueDates: readonly (string | null)[], endsOn: string | null, todayKey: string): { date: string | null; daysLeft: number | null } {
  const latest = milestoneDueDates.filter((d): d is string => d !== null).sort().at(-1) ?? endsOn;
  if (!latest) return { date: null, daysLeft: null };
  return { date: latest, daysLeft: Math.round((Date.parse(`${latest}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) / 86_400_000) };
}

/** What `overallProgress` counted, in the words a header prints beside the figure. */
export function overallProgressLabel(counts: { milestonesTotal: number; tasksTotal: number }): string {
  return counts.milestonesTotal > 0 ? 'Overall progress · milestones met' : counts.tasksTotal > 0 ? 'Overall progress · tasks done' : 'Overall progress';
}
