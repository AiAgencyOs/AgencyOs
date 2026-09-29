import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { isMonthKey, monthKeyOf } from '@/lib/admin/month-grid';
import { requireInternal } from '@/lib/auth/session';
import { listMyTasksDetailed, type MyTaskDetail } from '@/modules/projects/my-tasks-queries';
import { listInternalRoster, type RosterMember } from '@/modules/projects/queries';
import { TASK_STATUSES } from '@/modules/projects/schema';
import {
  Avatar,
  Badge,
  cx,
  EmptyState,
  FilterChips,
  humanize,
  IconAlert,
  IconCalendar,
  IconCheck,
  IconClock,
  IconList,
  IconSearch,
  MonthGrid,
  PageHeader,
  Stat,
  StatGrid,
  statusTone,
  TONE_CHIP,
  TONE_TEXT,
  type CalendarEntry,
  type Tone,
} from '@/ui';

import { TaskDrawerButton } from './task-drawer';
import { MyTaskStatusSelect } from './task-row';

const VIEWS = ['columns', 'list', 'calendar'] as const;
type View = (typeof VIEWS)[number];

function viewOf(value: string | undefined): View {
  return (VIEWS as readonly string[]).includes(value ?? '') ? (value as View) : 'columns';
}

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
  const overdue = tasks.filter((t) => t.dueOn !== null && dueLabel(clock, t.dueOn).overdue);
  // SCR-021's three asks beside the reference's own figures: due today,
  // blocked, and waiting for review — the agency's today, not the server's.
  const dueToday = tasks.filter((t) => t.dueOn === today);
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const month = isMonthKey(rawMonth) ? rawMonth : monthKeyOf(today);
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
        <StatGrid>
          <Stat label="Due today" value={String(dueToday.length)} caption={dueToday.length > 0 ? 'Finish these first' : 'Nothing due today'} tone={dueToday.length > 0 ? 'warning' : 'neutral'} icon={<IconCalendar size={16} />} />
          <Stat label="Blocked" value={String(blocked.length)} caption={blocked.length > 0 ? 'Waiting on something' : 'Nothing blocked'} tone={blocked.length > 0 ? 'warning' : 'neutral'} icon={<IconAlert size={16} />} />
          <Stat label="Waiting for review" value={String(byStatus('in_review').length)} caption="Submitted, not yet accepted" tone="accent" icon={<IconSearch size={16} />} />
          <Stat label="Without a due date" value={String(tasks.filter((t) => t.dueOn === null).length)} caption="Not on the calendar" tone="neutral" icon={<IconClock size={16} />} />
        </StatGrid>
      ) : null}

      {tasks.length > 0 ? (
        <FilterChips
          options={VIEWS.map((v) => ({
            key: v,
            label: humanize(v),
            href: v === 'columns' ? '/my-tasks' : `/my-tasks?view=${v}`,
            active: v === view,
          }))}
        />
      ) : null}

      {tasks.length > 0 && view === 'list' ? <ListView tasks={tasks} roster={roster} clock={clock} today={today} /> : null}
      {tasks.length > 0 && view === 'calendar' ? <CalendarView tasks={tasks} roster={roster} month={month} today={today} /> : null}

      {tasks.length > 0 && view === 'columns' ? (
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
                  {list.map((t: MyTaskDetail) => {
                    const due = dueLabel(clock, t.dueOn);
                    const p = PRIORITY[t.priority] ?? { label: t.priority.toUpperCase(), tone: 'neutral' as Tone };
                    return (
                      <li key={t.id} className="rounded-lg border border-line bg-surface p-3 shadow-xs">
                        <TaskDrawerButton task={t} roster={roster} className="text-left text-[13px] font-medium leading-snug text-foreground underline-offset-2 hover:underline" />
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
      ) : null}

      {tasks.length === 0 ? (
        <EmptyState
          icon={<IconCheck size={22} />}
          title="Nothing assigned to you"
          description="Tasks assigned to you on any project's Development tab will appear here."
        />
      ) : null}
    </div>
  );
}

/** SCR-021's list mode: one row per task, soonest due first, the drawer on the title. */
function ListView({ tasks, roster, clock, today }: { tasks: MyTaskDetail[]; roster: RosterMember[]; clock: AgencyClock; today: string }) {
  return (
    <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface shadow-xs">
      {tasks.map((t) => {
        const due = dueLabel(clock, t.dueOn);
        const p = PRIORITY[t.priority] ?? { label: t.priority.toUpperCase(), tone: 'neutral' as Tone };
        return (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
            <div className="flex min-w-0 flex-col gap-0.5">
              <TaskDrawerButton task={t} roster={roster} />
              <span className="text-xs text-muted">
                <Link href={`/projects/${t.projectId}/board`} className="underline-offset-2 hover:underline">
                  {t.projectName}
                </Link>
                {t.moduleName ? <> · {t.moduleName}</> : null}
                {' · '}
                <span className={due.overdue ? 'text-danger' : t.dueOn === today ? 'text-warning' : undefined}>
                  {due.overdue ? `Overdue · ${due.label}` : t.dueOn === today ? 'Due today' : due.label}
                </span>
              </span>
            </div>
            <span className="flex items-center gap-2">
              <Badge tone={p.tone}>{p.label}</Badge>
              <MyTaskStatusSelect task={t} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * SCR-021's calendar mode: the design system's month grid over due dates.
 * A day key is a plain `date`, so no zone is involved; "today" is the
 * agency's day. Tasks with no due date are counted underneath rather than
 * given one.
 */
function CalendarView({ tasks, roster, month, today }: { tasks: MyTaskDetail[]; roster: RosterMember[]; month: string; today: string }) {
  const entriesByDate: Record<string, CalendarEntry[]> = {};
  for (const t of tasks) {
    if (!t.dueOn) continue;
    (entriesByDate[t.dueOn] ??= []).push({
      label: t.title,
      tone: t.dueOn < today ? 'danger' : t.dueOn === today ? 'warning' : 'brand',
      href: `/projects/${t.projectId}/board`,
    });
  }
  const undated = tasks.filter((t) => !t.dueOn);
  const inMonth = tasks.filter((t) => t.dueOn?.startsWith(month)).sort((a, b) => (a.dueOn ?? '').localeCompare(b.dueOn ?? ''));

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-line bg-surface p-3 shadow-xs sm:p-4">
        <MonthGrid month={month} entriesByDate={entriesByDate} todayKey={today} monthHref={(m) => `/my-tasks?view=calendar&month=${m}`} />
      </div>
      {inMonth.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface shadow-xs">
          {inMonth.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
              <span className="flex min-w-0 items-center gap-2">
                <span className={cx('tabular text-xs', (t.dueOn ?? '') < today ? 'text-danger' : 'text-muted')}>{t.dueOn?.slice(8)}</span>
                <TaskDrawerButton task={t} roster={roster} />
              </span>
              <span className="text-xs text-muted">{t.projectName}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {undated.length > 0 ? (
        <p className="text-[13px] text-muted">
          {undated.length} task{undated.length === 1 ? ' has' : 's have'} no due date and {undated.length === 1 ? 'is' : 'are'} not on the calendar — set one from the task drawer.
        </p>
      ) : null}
    </div>
  );
}
