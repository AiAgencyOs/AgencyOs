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
};

export type ProjectHealth = { level: 'healthy' | 'at_risk' | 'blocked'; label: string; reasons: string[] };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function projectHealth(input: ProjectHealthInput): ProjectHealth {
  const reasons: string[] = [];
  let level: ProjectHealth['level'] = 'healthy';

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
  if (input.overdueTasks > 0) risk(`${plural(input.overdueTasks, 'task is', 'tasks are')} past due`);
  if (input.overdueMilestones > 0) risk(`${plural(input.overdueMilestones, 'milestone is', 'milestones are')} past due and not met`);
  if (input.blockingDefects > 0) risk(`${plural(input.blockingDefects, 'open defect', 'open defects')} would block a release`);
  if (input.pendingClaims > 0) risk(`${plural(input.pendingClaims, 'payment claim', 'payment claims')} waiting on verification`);

  const LABEL: Record<ProjectHealth['level'], string> = { healthy: 'Healthy', at_risk: 'At risk', blocked: 'Blocked' };
  return { level, label: LABEL[level], reasons };
}
