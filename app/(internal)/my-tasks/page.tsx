import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { listMyTasks, type MyTaskRow } from '@/modules/projects/queries';
import { Badge, EmptyState, IconCheck, PageHeader, Stat, StatGrid } from '@/ui';

import { MyTaskStatusSelect } from './task-row';

export const metadata: Metadata = { title: 'My tasks' };

function dueLabel(clock: AgencyClock, dueOn: string | null): { label: string; overdue: boolean } {
  if (!dueOn) return { label: 'no due date', overdue: false };
  // Compared as YYYY-MM-DD strings in the agency's own zone (dayKey), not a
  // Date/Date comparison — that would compare against the SERVER's zone,
  // which can disagree with the agency's about what day it currently is.
  const overdue = dueOn < clock.dayKey(new Date());
  return { label: clock.date(dueOn), overdue };
}

/**
 * SCR-021 — My Tasks. `projects.tasks.assignee_id` has existed since
 * 20260807120006 with no cross-project reader anywhere: `readPlanBoard` and
 * the development breakdown both scope to one project, which answers "what
 * does this project owe" rather than "what do I personally owe" — a
 * different question this screen is the first to ask.
 */
export default async function MyTasksPage() {
  const context = await requireInternal('/my-tasks');
  const clock = await agencyClock();

  const tasks = await listMyTasks(context.userId);
  const overdue = tasks.filter((t) => {
    if (!t.dueOn) return false;
    return dueLabel(clock, t.dueOn).overdue;
  });
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const inReview = tasks.filter((t) => t.status === 'in_review');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="My tasks"
        description={
          tasks.length === 0
            ? 'Nothing assigned to you right now.'
            : `${tasks.length} open task${tasks.length === 1 ? '' : 's'} across every project, soonest due first.`
        }
      />

      {tasks.length > 0 ? (
        <StatGrid>
          <Stat label="Assigned to me" value={String(tasks.length)} />
          <Stat label="Overdue" value={String(overdue.length)} tone={overdue.length > 0 ? 'danger' : 'success'} />
          <Stat label="Blocked" value={String(blocked.length)} tone={blocked.length > 0 ? 'warning' : 'neutral'} />
          <Stat label="Waiting for review" value={String(inReview.length)} />
        </StatGrid>
      ) : null}

      {tasks.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {tasks.map((t: MyTaskRow) => {
            const due = dueLabel(clock, t.dueOn);
            return (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium">{t.title}</span>
                  <span className="text-xs text-muted">
                    <Link href={`/projects/${t.projectId}/development`} className="underline-offset-2 hover:underline">
                      {t.projectName}
                    </Link>
                    {' · '}
                    <span className={due.overdue ? 'text-danger' : undefined}>{due.overdue ? `overdue — ${due.label}` : due.label}</span>
                  </span>
                </div>
                <span className="flex items-center gap-2">
                  <Badge tone="brand">{t.priority}</Badge>
                  <MyTaskStatusSelect task={t} />
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          icon={<IconCheck size={22} />}
          title="Nothing assigned to you"
          description="Tasks assigned to you on any project's Development tab will appear here."
        />
      )}
    </div>
  );
}
