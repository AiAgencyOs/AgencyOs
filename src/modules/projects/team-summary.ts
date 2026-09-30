import { PROJECT_ROLE_LABEL, type ProjectRole } from './project-members-schema';

/**
 * SCR-025 — ONE roster for the Project Team page. The page had two: the people
 * chosen as project members (3) and the people holding a task (1), counted in
 * different tiles, so "Total members 1" sat above a list of three. This is the
 * union, each person once, with the project role when they have one and "Task
 * holder" when they only hold work — and their open work beside them (the
 * workload view). Every figure is a count of stored rows.
 */
export type SummaryMember = { userId: string; fullName: string; orgRole: string; projectRole: ProjectRole };
export type SummaryHolder = { userId: string; fullName: string; role: string };
export type SummaryTask = { assigneeId: string | null; status: string; dueOn: string | null; estimateHours: number | null };

export type TeamPerson = {
  userId: string;
  fullName: string;
  orgRole: string;
  /** The project role, or null for somebody who only holds tasks. */
  projectRole: ProjectRole | null;
  open: number;
  overdue: number;
  blocked: number;
  done: number;
  total: number;
  openHours: number;
};

export const SPECIALIST_ROLES: readonly ProjectRole[] = ['designer', 'developer', 'qa'];
export const TASK_HOLDER_LABEL = 'Task holder (not on the roster)';

export function teamSummary(input: { members: readonly SummaryMember[]; holders: readonly SummaryHolder[]; tasks: readonly SummaryTask[]; todayKey: string }) {
  const byUser = new Map<string, TeamPerson>();
  const blank = (userId: string, fullName: string, orgRole: string, projectRole: ProjectRole | null): TeamPerson => ({ userId, fullName, orgRole, projectRole, open: 0, overdue: 0, blocked: 0, done: 0, total: 0, openHours: 0 });
  for (const m of input.members) byUser.set(m.userId, blank(m.userId, m.fullName, m.orgRole, m.projectRole));
  for (const h of input.holders) if (!byUser.has(h.userId)) byUser.set(h.userId, blank(h.userId, h.fullName, h.role, null));

  for (const t of input.tasks) {
    const p = t.assigneeId ? byUser.get(t.assigneeId) : undefined;
    if (!p) continue;
    p.total += 1;
    if (t.status === 'done') {
      p.done += 1;
      continue;
    }
    p.open += 1;
    if (t.status === 'blocked') p.blocked += 1;
    if (t.dueOn !== null && t.dueOn < input.todayKey) p.overdue += 1;
    p.openHours += t.estimateHours ?? 0;
  }

  const people = [...byUser.values()].sort((a, b) => b.open - a.open || a.fullName.localeCompare(b.fullName));
  const distribution = new Map<string, number>();
  for (const p of people) {
    const label = p.projectRole ? PROJECT_ROLE_LABEL[p.projectRole] : TASK_HOLDER_LABEL;
    distribution.set(label, (distribution.get(label) ?? 0) + 1);
  }
  return {
    people,
    total: people.length,
    onRoster: input.members.length,
    projectManagers: people.filter((p) => p.projectRole === 'project_manager').map((p) => p.fullName),
    specialists: people.filter((p) => p.projectRole !== null && SPECIALIST_ROLES.includes(p.projectRole)).length,
    distribution: [...distribution.entries()].sort((a, b) => b[1] - a[1]),
  };
}
