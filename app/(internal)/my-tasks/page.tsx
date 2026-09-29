import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import {
  isMonthKey,
  monthGrid,
  monthKeyOf,
  monthLabel,
  shiftMonth,
  WEEKDAY_LABELS,
} from '@/lib/admin/month-grid';
import { requireInternal } from '@/lib/auth/session';
import { listMyTasksDetailed, type MyTaskDetail } from '@/modules/projects/my-tasks-queries';
import { listInternalRoster, type RosterMember } from '@/modules/projects/queries';
import { TASK_STATUSES } from '@/modules/projects/schema';
import {
  Badge,
  Card,
  EmptyState,
  FilterChips,
  IconCheck,
  PageHeader,
  Stat,
  StatGrid,
  cx,
  humanize,
  statusTone,
} from '@/ui';

import { TaskDrawerButton } from './task-drawer';
import { MyTaskStatusSelect } from './task-row';

export const metadata: Metadata = { title: 'My tasks' };

const VIEWS = ['list', 'columns', 'calendar'] as const;
type View = (typeof VIEWS)[number];

function viewOf(value: string | undefined): View {
  return (VIEWS as readonly string[]).includes(value ?? '') ? (value as View) : 'list';
}

function dueLabel(clock: AgencyClock, today: string, dueOn: string | null): { label: string; overdue: boolean } {
  if (!dueOn) return { label: 'no due date', overdue: false };
  // Compared as YYYY-MM-DD strings in the agency's own zone (dayKey), not a
  // Date/Date comparison — that would compare against the SERVER's zone,
  // which can disagree with the agency's about what day it currently is.
  return { label: clock.date(`${dueOn}T00:00:00`), overdue: dueOn < today };
}

const PRIORITY_TONE = { p0: 'danger', p1: 'warning', p2: 'neutral', p3: 'neutral' } as const;

function priorityTone(priority: string) {
  return PRIORITY_TONE[priority as keyof typeof PRIORITY_TONE] ?? 'neutral';
}

/**
 * SCR-021 — My Tasks. `projects.tasks.assignee_id` has existed since
 * 20260807120006 with no cross-project reader anywhere: `readPlanBoard` and
 * the development breakdown both scope to one project, which answers "what
 * does this project owe" rather than "what do I personally owe" — a
 * different question this screen is the first to ask.
 *
 * Three views on the same rows (`?view=list|columns|calendar`), a drawer per
 * task, and reassign through `updateTaskAction`. "Due today" is the agency's
 * today, not the server's.
 */
export default async function MyTasksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; month?: string }>;
}) {
  const context = await requireInternal('/my-tasks');
  const clock = await agencyClock();
  const { view: rawView, month: rawMonth } = await searchParams;
  const view = viewOf(rawView);

  const [tasks, roster] = await Promise.all([listMyTasksDetailed(context.userId), listInternalRoster()]);

  const today = clock.dayKey(new Date());
  const overdue = tasks.filter((t) => t.dueOn !== null && t.dueOn < today);
  const dueToday = tasks.filter((t) => t.dueOn === today);
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const inReview = tasks.filter((t) => t.status === 'in_review');

  const month = isMonthKey(rawMonth) ? rawMonth : monthKeyOf(today);

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
          <Stat label="Due today" value={String(dueToday.length)} tone={dueToday.length > 0 ? 'warning' : 'neutral'} />
          <Stat label="Overdue" value={String(overdue.length)} tone={overdue.length > 0 ? 'danger' : 'success'} />
          <Stat label="Blocked" value={String(blocked.length)} tone={blocked.length > 0 ? 'warning' : 'neutral'} />
          <Stat label="Waiting for review" value={String(inReview.length)} tone={inReview.length > 0 ? 'info' : 'neutral'} />
        </StatGrid>
      ) : null}

      {tasks.length > 0 ? (
        <FilterChips
          options={VIEWS.map((v) => ({
            key: v,
            label: humanize(v),
            href: v === 'list' ? '/my-tasks' : `/my-tasks?view=${v}`,
            active: v === view,
          }))}
        />
      ) : null}

      {tasks.length === 0 ? (
        <EmptyState
          icon={<IconCheck size={22} />}
          title="Nothing assigned to you"
          description="Tasks assigned to you on any project's Development tab will appear here."
        />
      ) : view === 'list' ? (
        <ListView tasks={tasks} roster={roster} clock={clock} today={today} />
      ) : view === 'columns' ? (
        <ColumnsView tasks={tasks} roster={roster} clock={clock} today={today} />
      ) : (
        <CalendarView tasks={tasks} roster={roster} month={month} today={today} />
      )}
    </div>
  );
}

function ListView({
  tasks,
  roster,
  clock,
  today,
}: {
  tasks: MyTaskDetail[];
  roster: RosterMember[];
  clock: AgencyClock;
  today: string;
}) {
  return (
    <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
      {tasks.map((t) => {
        const due = dueLabel(clock, today, t.dueOn);
        return (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
            <div className="flex min-w-0 flex-col gap-0.5">
              <TaskDrawerButton task={t} roster={roster} />
              <span className="text-xs text-muted">
                <Link href={`/projects/${t.projectId}/development`} className="underline-offset-2 hover:underline">
                  {t.projectName}
                </Link>
                {t.moduleName ? <> · {t.moduleName}</> : null}
                {' · '}
                <span className={due.overdue ? 'text-danger' : t.dueOn === today ? 'text-warning' : undefined}>
                  {due.overdue ? `overdue — ${due.label}` : t.dueOn === today ? 'due today' : due.label}
                </span>
              </span>
            </div>
            <span className="flex items-center gap-2">
              <Badge tone={priorityTone(t.priority)}>{t.priority.toUpperCase()}</Badge>
              <MyTaskStatusSelect task={t} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ColumnsView({
  tasks,
  roster,
  clock,
  today,
}: {
  tasks: MyTaskDetail[];
  roster: RosterMember[];
  clock: AgencyClock;
  today: string;
}) {
  const columns = TASK_STATUSES.filter((s) => s !== 'done');
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {columns.map((status) => {
        const colTasks = tasks.filter((t) => t.status === status);
        return (
          <Card key={status} className="flex flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
              <Badge tone={statusTone(status)} dot>
                {humanize(status)}
              </Badge>
              <span className="text-xs text-muted tabular">{colTasks.length}</span>
            </div>
            <div className="flex flex-1 flex-col gap-2 p-2">
              {colTasks.length > 0 ? (
                colTasks.map((t) => {
                  const due = dueLabel(clock, today, t.dueOn);
                  return (
                    <div key={t.id} className="rounded-lg border border-line bg-surface p-3 shadow-xs">
                      <TaskDrawerButton
                        task={t}
                        roster={roster}
                        className="text-left text-[13px] font-medium leading-snug text-foreground underline-offset-2 hover:underline"
                      />
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Badge tone={priorityTone(t.priority)}>{t.priority.toUpperCase()}</Badge>
                        <span className="text-xs text-muted">{t.projectName}</span>
                      </div>
                      {t.dueOn ? (
                        <p className={cx('mt-1.5 text-xs', due.overdue ? 'text-danger' : 'text-muted')}>
                          {due.overdue ? 'Overdue — ' : 'Due '}
                          {due.label}
                        </p>
                      ) : null}
                    </div>
                  );
                })
              ) : (
                <p className="px-2 py-3 text-center text-xs text-faint">Empty</p>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function CalendarView({
  tasks,
  roster,
  month,
  today,
}: {
  tasks: MyTaskDetail[];
  roster: RosterMember[];
  month: string;
  today: string;
}) {
  const byDay = new Map<string, MyTaskDetail[]>();
  for (const t of tasks) {
    if (!t.dueOn) continue;
    const list = byDay.get(t.dueOn) ?? [];
    list.push(t);
    byDay.set(t.dueOn, list);
  }
  const undated = tasks.filter((t) => !t.dueOn);
  const weeks = monthGrid(month);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{monthLabel(month)}</h2>
        <span className="flex items-center gap-1">
          <Link href={`/my-tasks?view=calendar&month=${shiftMonth(month, -1)}`} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-hover">
            ← Previous
          </Link>
          <Link href={`/my-tasks?view=calendar&month=${monthKeyOf(today)}`} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-hover">
            Today
          </Link>
          <Link href={`/my-tasks?view=calendar&month=${shiftMonth(month, 1)}`} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-hover">
            Next →
          </Link>
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <div className="grid min-w-[700px] grid-cols-7 border-b border-line bg-surface-sunken">
          {WEEKDAY_LABELS.map((d) => (
            <div key={d} className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
              {d}
            </div>
          ))}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} className="grid min-w-[700px] grid-cols-7 border-b border-line last:border-0">
            {week.map((day) => {
              const dayTasks = byDay.get(day.key) ?? [];
              return (
                <div
                  key={day.key}
                  className={cx(
                    'min-h-24 border-r border-line p-1.5 last:border-0',
                    !day.inMonth && 'bg-surface-sunken/60',
                    day.key === today && 'bg-brand-soft/40',
                  )}
                >
                  <span
                    className={cx(
                      'text-xs tabular',
                      day.key === today ? 'font-semibold text-brand' : day.inMonth ? 'text-foreground' : 'text-faint',
                    )}
                  >
                    {day.dayOfMonth}
                  </span>
                  <ul className="mt-1 flex flex-col gap-1">
                    {dayTasks.map((t) => (
                      <li key={t.id}>
                        <TaskDrawerButton
                          task={t}
                          roster={roster}
                          className={cx(
                            'block w-full truncate rounded px-1.5 py-0.5 text-left text-xs',
                            day.key < today ? 'bg-danger-soft text-danger' : 'bg-brand-soft text-brand',
                          )}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {undated.length > 0 ? (
        <p className="text-[13px] text-muted">
          {undated.length} task{undated.length === 1 ? ' has' : 's have'} no due date and {undated.length === 1 ? 'is' : 'are'} not on the calendar — set one from the list view.
        </p>
      ) : null}
    </div>
  );
}
