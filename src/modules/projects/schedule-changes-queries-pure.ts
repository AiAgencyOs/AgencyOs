import type { ScheduleChange } from './schedule-changes-queries';

/** "13 Oct 2026 → 20 Oct 2026", with "no date" for a cleared or first date. */
export function describeScheduleMove(change: Pick<ScheduleChange, 'wasOn' | 'nowOn'>, date: (isoDay: string) => string): string {
  const show = (d: string | null) => (d ? date(d) : 'no date');
  return `${show(change.wasOn)} → ${show(change.nowOn)}`;
}

export const SCHEDULE_KIND_LABEL: Record<ScheduleChange['kind'], string> = { task: 'Task due date', milestone: 'Milestone due date', project: 'Project due date' };

/** Where the changed thing lives. */
export function scheduleChangeHref(c: Pick<ScheduleChange, 'kind' | 'subjectId' | 'projectId'>): string {
  const base = `/projects/${c.projectId}`;
  if (c.kind === 'task') return `${base}/development/tasks/${c.subjectId}`;
  if (c.kind === 'milestone') return `${base}/milestones?milestone=${c.subjectId}`;
  return `${base}/calendar`;
}
