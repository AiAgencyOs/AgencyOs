/**
 * What the reference's project screens draw that no table stores directly —
 * derived, pure, and honest about what it was derived from. No clock, no I/O:
 * the caller passes "today", so every figure here is tested with real inputs.
 *
 *  • progress over time  — completed_at per day (actual) and due_on per day (planned)
 *  • grouping            — the board's "Group by" and the task list's phases
 *  • timeline rows       — a task's bar is start_on → due_on; a phase's bar is
 *                          its tasks' span, or previous phase's due → its own due
 *  • milestone rollups   — tasks done / total under a milestone
 */

const DAY = 86_400_000;

export type TaskFacts = {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  moduleId: string | null;
  milestoneId: string | null;
  parentTaskId: string | null;
  startOn: string | null;
  dueOn: string | null;
  completedAt: string | null;
  createdAt: string;
};

/** A `YYYY-MM-DD` key as a day number, or NaN. */
export function dayNumber(key: string): number {
  return Math.floor(Date.parse(`${key.slice(0, 10)}T00:00:00Z`) / DAY);
}

export function dayKey(n: number): string {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** Top-level tasks only: a subtask is drawn under its parent, never as a card of its own. */
export function topLevelTasks<T extends { parentTaskId: string | null }>(tasks: readonly T[]): T[] {
  return tasks.filter((t) => t.parentTaskId === null);
}

export type ProgressPoint = { key: string; actual: number | null; planned: number };

/**
 * Progress over time: at each sample day, the share of the project's tasks
 * that had been completed by then (`actual`, drawn only up to today) and the
 * share that were due by then (`planned`). Both are counts of real rows over
 * the same denominator, so the two lines meet at 100% when everything is
 * finished on time. Empty when there are no tasks or no window to draw.
 */
export function progressSeries(
  tasks: readonly Pick<TaskFacts, 'dueOn' | 'completedAt'>[],
  window: { start: string | null; end: string | null },
  today: string,
  samples = 10,
): ProgressPoint[] {
  const total = tasks.length;
  if (total === 0) return [];
  const dated = [...tasks.map((t) => t.dueOn), ...tasks.map((t) => t.completedAt?.slice(0, 10) ?? null)].filter((d): d is string => d !== null);
  const startKey = window.start ?? (dated.length > 0 ? dated.reduce((a, b) => (a < b ? a : b)) : today);
  const endCandidates = [window.end, ...dated, today].filter((d): d is string => d !== null);
  const endKey = endCandidates.reduce((a, b) => (a > b ? a : b));
  const first = dayNumber(startKey);
  const last = Math.max(dayNumber(endKey), first + 1);
  const count = Math.max(2, samples);
  const points: ProgressPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const day = Math.round(first + ((last - first) * i) / (count - 1));
    const key = dayKey(day);
    const done = tasks.filter((t) => t.completedAt !== null && t.completedAt.slice(0, 10) <= key).length;
    const due = tasks.filter((t) => t.dueOn !== null && t.dueOn <= key).length;
    points.push({ key, actual: key <= today ? Math.round((done / total) * 100) : null, planned: Math.round((due / total) * 100) });
  }
  return points;
}

export type GroupBy = 'status' | 'assignee' | 'priority' | 'module' | 'phase';
export const GROUP_BY_OPTIONS: readonly { value: GroupBy; label: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'priority', label: 'Priority' },
  { value: 'module', label: 'Module' },
  { value: 'phase', label: 'Phase' },
];

export type GroupLabels = { assignees: ReadonlyMap<string, string>; modules: ReadonlyMap<string, string>; phases: ReadonlyMap<string, string> };

const PRIORITY_ORDER = ['p0', 'p1', 'p2', 'p3'];
const PRIORITY_NAME: Record<string, string> = { p0: 'Critical', p1: 'High', p2: 'Medium', p3: 'Low' };

/**
 * The key a task falls under for a grouping, or `none`. `phase` is the payment
 * milestone the task is filed under (the reference's "Phase 3 – Full
 * Development"): a project that files no task under a milestone has one group,
 * "No phase", never an invented one.
 */
export function groupKeyOf(task: Pick<TaskFacts, 'status' | 'assigneeId' | 'priority' | 'moduleId' | 'milestoneId'>, by: GroupBy): string {
  switch (by) {
    case 'status':
      return task.status;
    case 'assignee':
      return task.assigneeId ?? 'none';
    case 'priority':
      return task.priority;
    case 'module':
      return task.moduleId ?? 'none';
    case 'phase':
      return task.milestoneId ?? 'none';
  }
}

/** The groups that exist among `tasks` for a grouping, in the order a reader expects, with a display label each. `order` fixes the status order and the phase order. */
export function groupsFor(
  tasks: readonly Pick<TaskFacts, 'status' | 'assigneeId' | 'priority' | 'moduleId' | 'milestoneId'>[],
  by: GroupBy,
  labels: GroupLabels,
  order: { statuses: readonly string[]; phases: readonly string[] },
): { key: string; label: string }[] {
  const keys = [...new Set(tasks.map((t) => groupKeyOf(t, by)))];
  const rank = (key: string): number => {
    if (by === 'status') return order.statuses.indexOf(key);
    if (by === 'priority') return PRIORITY_ORDER.indexOf(key);
    if (by === 'phase') return order.phases.indexOf(key);
    return 0;
  };
  const label = (key: string): string => {
    if (by === 'status') return key;
    if (by === 'priority') return PRIORITY_NAME[key] ?? key;
    if (by === 'assignee') return key === 'none' ? 'Unassigned' : (labels.assignees.get(key) ?? 'Unknown');
    if (by === 'module') return key === 'none' ? 'No module' : (labels.modules.get(key) ?? 'Unknown module');
    return key === 'none' ? 'No phase' : (labels.phases.get(key) ?? 'Unknown phase');
  };
  return keys
    .map((key) => ({ key, label: label(key), rank: rank(key) }))
    .sort((a, b) => {
      if (a.key === 'none') return 1;
      if (b.key === 'none') return -1;
      if (by === 'assignee' || by === 'module') return a.label.localeCompare(b.label);
      return (a.rank < 0 ? 99 : a.rank) - (b.rank < 0 ? 99 : b.rank);
    })
    .map(({ key, label: l }) => ({ key, label: l }));
}

export type Rollup = { total: number; done: number; percent: number };

export function rollup(tasks: readonly Pick<TaskFacts, 'status'>[]): Rollup {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** A task's bar on the timeline, or null when it has no date to stand on. Start is start_on, else the due day (a one-day bar). */
export function taskWindow(task: Pick<TaskFacts, 'startOn' | 'dueOn'>): { start: string; end: string } | null {
  if (task.dueOn === null && task.startOn === null) return null;
  const end = task.dueOn ?? (task.startOn as string);
  const start = task.startOn ?? end;
  return start <= end ? { start, end } : { start: end, end };
}

export type PhaseFacts = { id: string; name: string; dueOn: string | null; metAt: string | null; status: string };

/**
 * A phase's window: from its tasks' earliest start to its due date (or its
 * tasks' latest end when it has none). Without task dates the window opens the
 * day after the previous phase's due date, or on the project's start. Null
 * when nothing dates it at all — the row is listed, no bar is invented.
 */
export function phaseWindow(
  phase: PhaseFacts,
  previousDue: string | null,
  projectStart: string | null,
  tasks: readonly Pick<TaskFacts, 'startOn' | 'dueOn'>[],
): { start: string; end: string } | null {
  const windows = tasks.map(taskWindow).filter((w): w is { start: string; end: string } => w !== null);
  const taskStart = windows.length > 0 ? windows.reduce((a, w) => (w.start < a ? w.start : a), windows[0]!.start) : null;
  const taskEnd = windows.length > 0 ? windows.reduce((a, w) => (w.end > a ? w.end : a), windows[0]!.end) : null;
  const end = phase.dueOn ?? taskEnd;
  if (end === null) return null;
  const opens = previousDue !== null ? dayKey(dayNumber(previousDue) + 1) : projectStart;
  const start = taskStart ?? opens ?? end;
  return start <= end ? { start, end } : { start: end, end };
}

/** A phase's state for the Gantt legend: done, current (first unmet with work under way), late, or upcoming. */
export function phaseState(phase: PhaseFacts, roll: Rollup, today: string, isFirstUnmet: boolean): 'done' | 'current' | 'upcoming' | 'late' {
  if (phase.metAt !== null || phase.status === 'met') return 'done';
  if (phase.dueOn !== null && phase.dueOn < today) return 'late';
  if (isFirstUnmet || roll.done > 0) return 'current';
  return 'upcoming';
}

/** "Due in 12 days", "Due today", "3 days overdue" — the milestone rail's line. */
export function dueLine(dueOn: string | null, today: string): string {
  if (dueOn === null) return 'No due date';
  const n = daysBetween(today, dueOn);
  if (n === 0) return 'Due today';
  if (n > 0) return `${n} day${n === 1 ? '' : 's'} left`;
  return `${-n} day${n === -1 ? '' : 's'} overdue`;
}

/** Days in an inclusive window ("7 Days" in the reference). */
export function inclusiveDays(start: string, end: string): number {
  return daysBetween(start, end) + 1;
}
