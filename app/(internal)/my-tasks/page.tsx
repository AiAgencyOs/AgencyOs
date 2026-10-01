import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { isMonthKey, monthKeyOf } from '@/lib/admin/month-grid';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listMyCompletedTasks, listMyTasksDetailed, type MyTaskDetail } from '@/modules/projects/my-tasks-queries';
import { listInternalRoster, type RosterMember } from '@/modules/projects/queries';
import { readTaskCollabFor, type TaskCollab } from '@/modules/projects/task-collab-queries';
import { readTaskTimeFor, type TaskTime } from '@/modules/projects/time-log-queries';
import { TASK_STATUSES } from '@/modules/projects/schema';
import {
  buttonClass,
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
  inputClass,
  MonthGrid,
  PageHeader,
  selectClass,
  Stat,
  StatGrid,
  statusTone,
  TONE_CHIP,
  TONE_TEXT,
  type CalendarEntry,
  type Tone,
} from '@/ui';

import { TaskDrawerButton } from './task-drawer';
import { MyTaskAdd } from './my-task-add';
import { listProjects } from '@/modules/projects/queries';

type TimeUser = { currentUserId: string; canDeleteAny: boolean; today: string };
const timeFor = (time: Record<string, TaskTime>, user: TimeUser, taskId: string) => ({ task: time[taskId] ?? { taskId, totalHours: 0, entries: [] }, ...user });
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
  searchParams: Promise<{ view?: string; month?: string; q?: string; project?: string; priority?: string; status?: string }>;
}) {
  const context = await requireInternal('/my-tasks');
  const clock = await agencyClock();
  const { view: rawView, month: rawMonth, q: rawQ, project: rawProject, priority: rawPriority, status: rawStatus } = await searchParams;
  const view = viewOf(rawView);

  const [allTasks, roster, completed, projectList] = await Promise.all([listMyTasksDetailed(context.userId), listInternalRoster(), listMyCompletedTasks(context.userId), listProjects(200)]);
  const mayAdd = can(context, 'task.write');
  // The toolbar is a plain GET form, so it filters without JavaScript; the figures above stay the whole list.
  const q = (rawQ ?? '').trim().toLowerCase();
  const projectOptions = [...new Map(allTasks.map((t) => [t.projectId, t.projectName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const tasks = allTasks.filter(
    (t) =>
      (!q || t.title.toLowerCase().includes(q)) &&
      (!rawProject || t.projectId === rawProject) &&
      (!rawPriority || t.priority === rawPriority) &&
      (!rawStatus || t.status === rawStatus),
  );
  const doneTasks = completed.tasks.filter(
    (t) =>
      (!q || t.title.toLowerCase().includes(q)) &&
      (!rawProject || t.projectId === rawProject) &&
      (!rawPriority || t.priority === rawPriority) &&
      (!rawStatus || rawStatus === 'done'),
  );
  const filtering = allTasks.length !== tasks.length;
  // SCR-021: the checklist, comments, attachments and blocker per task, read
  // once for the list so the drawer opens from what the page already holds.
  const collab = await readTaskCollabFor([...tasks, ...doneTasks].map((t) => t.id), clock);
  const today = clock.dayKey(new Date());
  // Decision 4 of 2026-09-29: the hours logged per task, for the drawer's
  // Time section. Who is looking decides which entries they may delete.
  const time = await readTaskTimeFor([...tasks, ...doneTasks].map((t) => t.id));
  const timeUser: TimeUser = { currentUserId: context.userId, canDeleteAny: can(context, 'project.write'), today };
  const all = allTasks;
  const overdue = all.filter((t) => t.dueOn !== null && dueLabel(clock, t.dueOn).overdue);
  // SCR-021's three asks beside the reference's own figures: due today,
  // blocked, and waiting for review — the agency's today, not the server's.
  const dueToday = all.filter((t) => t.dueOn === today);
  const blocked = all.filter((t) => t.status === 'blocked');
  const month = isMonthKey(rawMonth) ? rawMonth : monthKeyOf(today);
  const byStatus = (s: string) => (s === 'done' ? doneTasks : tasks.filter((t) => t.status === s));
  const byStatusAll = (s: string) => all.filter((t) => t.status === s);
  const columns = TASK_STATUSES.filter((s) => s !== 'done');
  const pct = (n: number) => (all.length > 0 ? `${Math.round((n / all.length) * 100)}%` : undefined);
  const name = context.fullName ?? context.email;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="My tasks"
        description={allTasks.length === 0 ? 'Nothing assigned to you right now.' : 'Manage and track all your tasks across projects.'}
        actions={
          <span className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1">
            <Avatar name={name} size="sm" />
            <span className="text-[13px] font-medium">{name}</span>
          </span>
        }
      />

      {allTasks.length > 0 ? (
        <StatGrid cols={5}>
          <Stat label="Open tasks" value={String(allTasks.length)} caption="Assigned to me" tone="brand" icon={<IconCheck size={16} />} />
          <Stat label="To do" value={String(byStatusAll('todo').length)} caption={pct(byStatusAll('todo').length)} tone="warning" icon={<IconList size={16} />} />
          <Stat label="In progress" value={String(byStatusAll('in_progress').length)} caption={pct(byStatusAll('in_progress').length)} tone="info" icon={<IconClock size={16} />} />
          <Stat label="In review" value={String(byStatusAll('in_review').length)} caption={pct(byStatusAll('in_review').length)} tone="accent" icon={<IconSearch size={16} />} />
          <Stat label="Overdue" value={String(overdue.length)} caption={overdue.length > 0 ? 'Past their due date' : 'Nothing overdue'} tone={overdue.length > 0 ? 'danger' : 'success'} icon={<IconAlert size={16} />} />
        </StatGrid>
      ) : null}

      {allTasks.length > 0 ? (
        <StatGrid>
          <Stat label="Due today" value={String(dueToday.length)} caption={dueToday.length > 0 ? 'Finish these first' : 'Nothing due today'} tone={dueToday.length > 0 ? 'warning' : 'neutral'} icon={<IconCalendar size={16} />} />
          <Stat label="Blocked" value={String(blocked.length)} caption={blocked.length > 0 ? 'Waiting on something' : 'Nothing blocked'} tone={blocked.length > 0 ? 'warning' : 'neutral'} icon={<IconAlert size={16} />} />
          <Stat label="Waiting for review" value={String(byStatusAll('in_review').length)} caption="Submitted, not yet accepted" tone="accent" icon={<IconSearch size={16} />} />
          <Stat label="Without a due date" value={String(all.filter((t) => t.dueOn === null).length)} caption="Not on the calendar" tone="neutral" icon={<IconClock size={16} />} />
        </StatGrid>
      ) : null}

      {allTasks.length > 0 ? (
        <form method="get" action="/my-tasks" className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2 shadow-xs">
          <input type="hidden" name="view" value={view} />
          <label className="relative w-full sm:w-auto sm:min-w-[14rem] sm:flex-1 sm:max-w-xs">
            <span className="sr-only">Search tasks</span>
            <IconSearch size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <input name="q" defaultValue={rawQ ?? ''} placeholder="Search tasks…" className={cx(inputClass, 'pl-8')} />
          </label>
          <select name="project" aria-label="Filter by project" defaultValue={rawProject ?? ''} className={cx(selectClass, 'sm:w-auto sm:min-w-[9rem]')}>
            <option value="">All projects</option>
            {projectOptions.map(([id, projectName]) => (
              <option key={id} value={id}>{projectName}</option>
            ))}
          </select>
          <select name="priority" aria-label="Filter by priority" defaultValue={rawPriority ?? ''} className={cx(selectClass, 'sm:w-auto sm:min-w-[8rem]')}>
            <option value="">All priorities</option>
            {Object.entries(PRIORITY).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <select name="status" aria-label="Filter by status" defaultValue={rawStatus ?? ''} className={cx(selectClass, 'sm:w-auto sm:min-w-[8rem]')}>
            <option value="">All statuses</option>
            {[...columns, 'done' as const].map((c) => (
              <option key={c} value={c}>{humanize(c)}</option>
            ))}
          </select>
          <button type="submit" className={buttonClass('secondary', 'sm')}>Filter</button>
          {filtering || rawQ ? (
            <Link href={view === 'columns' ? '/my-tasks' : `/my-tasks?view=${view}`} className="text-[13px] font-medium text-brand hover:underline">Reset</Link>
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted">{filtering ? `${tasks.length} of ${allTasks.length}` : allTasks.length} task{allTasks.length === 1 ? '' : 's'}</span>
            <FilterChips
              options={VIEWS.map((v) => ({
                key: v,
                label: humanize(v),
                href: `/my-tasks?${new URLSearchParams({ ...(v === 'columns' ? {} : { view: v }), ...Object.fromEntries(Object.entries({ q: rawQ, project: rawProject, priority: rawPriority, status: rawStatus }).filter(([, val]) => val)) as Record<string, string> }).toString()}`,
                active: v === view,
              }))}
            />
          </span>
        </form>
      ) : null}


      {tasks.length > 0 && view === 'list' ? <ListView tasks={tasks} roster={roster} collab={collab} time={time} timeUser={timeUser} clock={clock} today={today} /> : null}
      {tasks.length > 0 && view === 'calendar' ? <CalendarView tasks={tasks} roster={roster} collab={collab} time={time} timeUser={timeUser} month={month} today={today} /> : null}

      {(tasks.length > 0 || doneTasks.length > 0) && view === 'columns' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[...columns, 'done' as const].map((s) => {
            const tone = s === 'todo' ? 'warning' : statusTone(s);
            const list = byStatus(s);
            return (
              <section key={s} className="flex flex-col rounded-xl border border-line bg-surface-sunken/60">
                <h2 className={cx('flex items-center gap-2 rounded-t-xl px-3 py-2.5 text-[13px] font-semibold', HEADER_TINT[tone], TONE_TEXT[tone])}>
                  {COLUMN_ICON[s]}
                  <span className="text-foreground">{s === 'todo' ? 'To do' : s === 'done' ? 'Completed' : humanize(s)}</span>
                  <span className={cx('tabular rounded-full px-1.5 py-0.5 text-[10px] font-semibold', TONE_CHIP[tone])}>{s === 'done' ? completed.total : list.length}</span>
                </h2>
                <ul className="flex min-h-[80px] flex-1 flex-col gap-2 p-2">
                  {list.length === 0 ? <li className="px-2 py-4 text-center text-xs text-faint">No tasks</li> : null}
                  {list.map((t: MyTaskDetail) => {
                    const due = dueLabel(clock, t.dueOn);
                    const p = PRIORITY[t.priority] ?? { label: t.priority.toUpperCase(), tone: 'neutral' as Tone };
                    return (
                      <li key={t.id} className="rounded-lg border border-line bg-surface p-3 shadow-xs">
                        <TaskDrawerButton task={t} roster={roster} collab={collab[t.id]} time={timeFor(time, timeUser, t.id)} className="text-left text-[13px] font-medium leading-snug text-foreground underline-offset-2 hover:underline" />
                        {t.status === 'blocked' && collab[t.id]?.blocked.reason ? (
                          <p className="mt-1 line-clamp-2 text-[11px] text-danger" title={collab[t.id]?.blocked.reason ?? undefined}>
                            Blocked: {collab[t.id]?.blocked.reason}
                          </p>
                        ) : null}
                        {(collab[t.id]?.progress.total ?? 0) > 0 ? (
                          <p className="tabular mt-1 text-[11px] text-muted">
                            {collab[t.id]?.progress.done}/{collab[t.id]?.progress.total} checklist steps
                          </p>
                        ) : null}
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
                {mayAdd && s !== 'blocked' && s !== 'in_review' ? (
                  <MyTaskAdd status={s as 'todo' | 'in_progress' | 'done'} statusLabel={s === 'todo' ? 'To do' : s === 'done' ? 'Completed' : humanize(s)} projects={projectList.map((p) => ({ id: p.id, name: p.name }))} />
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}

      {allTasks.length > 0 && tasks.length === 0 ? (
        <EmptyState
          icon={<IconSearch size={22} />}
          title="No task matches these filters"
          description="Reset the filters to see every task assigned to you."
          action={<Link href="/my-tasks" className={buttonClass('secondary', 'sm')}>Reset filters</Link>}
        />
      ) : null}

      {allTasks.length === 0 ? (
        <EmptyState
          icon={<IconCheck size={22} />}
          title="Nothing assigned to you"
          description="Tasks assigned to you on any project's Development tab will appear here."
          action={<Link href="/projects" className={buttonClass('secondary', 'sm')}>Open projects</Link>}
        />
      ) : null}
    </div>
  );
}

/** SCR-021's list mode: one row per task, soonest due first, the drawer on the title. */
function ListView({ tasks, roster, collab, time, timeUser, clock, today }: { tasks: MyTaskDetail[]; roster: RosterMember[]; collab: Record<string, TaskCollab>; time: Record<string, TaskTime>; timeUser: TimeUser; clock: AgencyClock; today: string }) {
  return (
    <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface shadow-xs">
      {tasks.map((t) => {
        const due = dueLabel(clock, t.dueOn);
        const p = PRIORITY[t.priority] ?? { label: t.priority.toUpperCase(), tone: 'neutral' as Tone };
        return (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
            <div className="flex min-w-0 flex-col gap-0.5">
              <TaskDrawerButton task={t} roster={roster} collab={collab[t.id]} time={timeFor(time, timeUser, t.id)} />
              <span className="text-xs text-muted">
                <Link href={`/projects/${t.projectId}/board`} className="underline-offset-2 hover:underline">
                  {t.projectName}
                </Link>
                {t.moduleName ? <> · {t.moduleName}</> : null}
                {' · '}
                <span className={due.overdue ? 'text-danger' : t.dueOn === today ? 'text-warning' : undefined}>
                  {due.overdue ? `Overdue · ${due.label}` : t.dueOn === today ? 'Due today' : due.label}
                </span>
                {(collab[t.id]?.progress.total ?? 0) > 0 ? <> · {collab[t.id]?.progress.done}/{collab[t.id]?.progress.total} steps</> : null}
              </span>
              {t.status === 'blocked' && collab[t.id]?.blocked.reason ? <span className="text-xs text-danger">Blocked: {collab[t.id]?.blocked.reason}</span> : null}
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
function CalendarView({ tasks, roster, collab, time, timeUser, month, today }: { tasks: MyTaskDetail[]; roster: RosterMember[]; collab: Record<string, TaskCollab>; time: Record<string, TaskTime>; timeUser: TimeUser; month: string; today: string }) {
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
                <TaskDrawerButton task={t} roster={roster} collab={collab[t.id]} time={timeFor(time, timeUser, t.id)} />
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
