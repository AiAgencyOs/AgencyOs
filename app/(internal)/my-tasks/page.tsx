import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { listMyTasks, type MyTaskRow } from '@/modules/projects/queries';
import { TASK_STATUSES } from '@/modules/projects/schema';
import {
  Avatar,
  Badge,
  cx,
  EmptyState,
  humanize,
  IconAlert,
  IconCalendar,
  IconCheck,
  IconClock,
  IconList,
  IconSearch,
  PageHeader,
  Stat,
  StatGrid,
  statusTone,
  TONE_CHIP,
  TONE_TEXT,
  type Tone,
} from '@/ui';

import { MyTaskStatusSelect } from './task-row';

export const metadata: Metadata = { title: 'My tasks' };

function dueLabel(clock: AgencyClock, dueOn: string | null): { label: string; overdue: boolean } {
  if (!dueOn) return { label: 'No due date', overdue: false };
  // Compared as YYYY-MM-DD strings in the agency's own zone (dayKey), not a
  // Date/Date comparison — that would compare against the SERVER's zone,
  // which can disagree with the agency's about what day it currently is.
  const overdue = dueOn < clock.dayKey(new Date());
  return { label: clock.date(dueOn), overdue };
}

const PRIORITY: Record<string, { label: string; tone: Tone }> = {
  p0: { label: 'Critical', tone: 'danger' },
  p1: { label: 'High', tone: 'warning' },
  p2: { label: 'Medium', tone: 'info' },
  p3: { label: 'Low', tone: 'neutral' },
};

const COLUMN_ICON: Record<string, React.ReactNode> = {
  todo: <IconList size={14} />,
  in_progress: <IconClock size={14} />,
  blocked: <IconAlert size={14} />,
  in_review: <IconSearch size={14} />,
};

const HEADER_TINT: Record<Tone, string> = {
  neutral: 'bg-surface-sunken',
  brand: 'bg-brand-soft',
  accent: 'bg-accent-soft',
  success: 'bg-success-soft',
  warning: 'bg-warning-soft',
  danger: 'bg-danger-soft',
  info: 'bg-info-soft',
};

/**
 * SCR-021 — My Tasks, as the reference draws it: a KPI row and a column per
 * status, each card carrying the project, the due date and the priority,
 * with the status control on the card. `projects.tasks.assignee_id` has
 * existed since 20260807120006 with no cross-project reader anywhere:
 * `readPlanBoard` and the development breakdown both scope to one project,
 * which answers "what does this project owe" rather than "what do I
 * personally owe" — a different question this screen is the first to ask.
 *
 * Server-rendered columns rather than the drag board: the write here is the
 * same `setTaskStatusAction` behind a select, which also works without
 * JavaScript, and a person's own list rarely needs dragging.
 */
export default async function MyTasksPage() {
  const context = await requireInternal('/my-tasks');
  const clock = await agencyClock();

  const tasks = await listMyTasks(context.userId);
  const overdue = tasks.filter((t) => t.dueOn !== null && dueLabel(clock, t.dueOn).overdue);
  const byStatus = (s: string) => tasks.filter((t) => t.status === s);
  const columns = TASK_STATUSES.filter((s) => s !== 'done');
  const pct = (n: number) => (tasks.length > 0 ? `${Math.round((n / tasks.length) * 100)}%` : undefined);
  const name = context.fullName ?? context.email;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="My tasks"
        description={tasks.length === 0 ? 'Nothing assigned to you right now.' : 'Manage and track all your tasks across projects.'}
        actions={
          <span className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1">
            <Avatar name={name} size="sm" />
            <span className="text-[13px] font-medium">{name}</span>
          </span>
        }
      />

      {tasks.length > 0 ? (
        <StatGrid cols={5}>
          <Stat label="Open tasks" value={String(tasks.length)} caption="Assigned to me" tone="brand" icon={<IconCheck size={16} />} />
          <Stat label="To do" value={String(byStatus('todo').length)} caption={pct(byStatus('todo').length)} tone="warning" icon={<IconList size={16} />} />
          <Stat label="In progress" value={String(byStatus('in_progress').length)} caption={pct(byStatus('in_progress').length)} tone="info" icon={<IconClock size={16} />} />
          <Stat label="In review" value={String(byStatus('in_review').length)} caption={pct(byStatus('in_review').length)} tone="accent" icon={<IconSearch size={16} />} />
          <Stat label="Overdue" value={String(overdue.length)} caption={overdue.length > 0 ? 'Past their due date' : 'Nothing overdue'} tone={overdue.length > 0 ? 'danger' : 'success'} icon={<IconAlert size={16} />} />
        </StatGrid>
      ) : null}

      {tasks.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {columns.map((s) => {
            const tone = s === 'todo' ? 'warning' : statusTone(s);
            const list = byStatus(s);
            return (
              <section key={s} className="flex flex-col rounded-xl border border-line bg-surface-sunken/60">
                <h2 className={cx('flex items-center gap-2 rounded-t-xl px-3 py-2.5 text-[13px] font-semibold', HEADER_TINT[tone], TONE_TEXT[tone])}>
                  {COLUMN_ICON[s]}
                  <span className="text-foreground">{humanize(s)}</span>
                  <span className={cx('tabular rounded-full px-1.5 py-0.5 text-[10px] font-semibold', TONE_CHIP[tone])}>{list.length}</span>
                </h2>
                <ul className="flex min-h-[80px] flex-1 flex-col gap-2 p-2">
                  {list.length === 0 ? <li className="px-2 py-4 text-center text-xs text-faint">No tasks</li> : null}
                  {list.map((t: MyTaskRow) => {
                    const due = dueLabel(clock, t.dueOn);
                    const p = PRIORITY[t.priority] ?? { label: t.priority.toUpperCase(), tone: 'neutral' as Tone };
                    return (
                      <li key={t.id} className="rounded-lg border border-line bg-surface p-3 shadow-xs">
                        <p className="text-[13px] font-medium leading-snug text-foreground">{t.title}</p>
                        <Link href={`/projects/${t.projectId}/board`} className="mt-0.5 block truncate text-xs text-muted hover:text-brand">
                          {t.projectName}
                        </Link>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5">
                          <span className={cx('flex items-center gap-1 text-[11px]', due.overdue ? 'font-medium text-danger' : 'text-muted')}>
                            <IconCalendar size={12} />
                            {due.overdue ? `Overdue · ${due.label}` : due.label}
                          </span>
                          <Badge tone={p.tone}>{p.label}</Badge>
                        </div>
                        <div className="mt-2 border-t border-line pt-2">
                          <MyTaskStatusSelect task={t} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
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
