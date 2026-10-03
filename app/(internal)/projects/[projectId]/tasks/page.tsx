import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { countPeriods, periodDelta, trendOf } from '@/lib/admin/period-delta';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDevelopmentBreakdown, listInternalRoster, listPaymentPlan } from '@/modules/projects/queries';
import { groupsFor, rollup, topLevelTasks } from '@/modules/projects/project-view-derive';
import { TASK_STATUSES } from '@/modules/projects/schema';
import { isCountedTask, isOutstandingTask } from '@/modules/projects/task-transitions';
import { listProjectSprints } from '@/modules/projects/sprint-queries';
import { sprintDay, sprintState } from '@/modules/projects/sprint-schema';
import {
  Avatar,
  Badge,
  buttonClass,
  Card,
  CardHeader,
  EmptyState,
  HeaderFigure,
  humanize,
  IconAlert,
  IconCheck,
  IconClock,
  IconList,
  IconSearch,
  IconUpload,
  inputClass,
  labelClass,
  PermissionDenied,
  ProgressBar,
  selectClass,
  Stat,
  StatGrid,
  StatusBadge,
} from '@/ui';

import { QuickTaskForm } from '../create-in-place';
import { CloseSprintButton, NewSprintForm } from '../sprint-forms';
import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';

export const metadata: Metadata = { title: 'Tasks' };

const PRIORITY: Record<string, { label: string; tone: 'danger' | 'warning' | 'info' | 'neutral' }> = {
  p0: { label: 'Critical', tone: 'danger' },
  p1: { label: 'High', tone: 'warning' },
  p2: { label: 'Medium', tone: 'info' },
  p3: { label: 'Low', tone: 'neutral' },
};

type Search = { q?: string; phase?: string; status?: string; assignee?: string; priority?: string; due?: string; mine?: string; sprint?: string; archived?: string };

/**
 * The project's Tasks tab: every task as a list grouped by phase (the payment
 * milestone a task is filed under), with the Filters rail beside it. The
 * filters are a plain GET form, so they work without JavaScript and a
 * filtered list can be linked. Board, Calendar and Timeline are one click
 * away; nothing here writes except the "Add task" door the overview uses.
 */
export default async function ProjectTasksPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<Search> }) {
  const { projectId } = await params;
  const sp = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/tasks`);
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const project = await getProject(projectId);
  if (!project) notFound();

  const [{ tasks: allTasks, modules }, roster, phases, sprints, clock, clientName] = await Promise.all([
    listDevelopmentBreakdown(projectId, { includeArchived: sp.archived === '1' }),
    listInternalRoster(),
    listPaymentPlan(projectId),
    listProjectSprints(projectId),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
  ]);
  const tasks = topLevelTasks(allTasks);
  // T1-1: cancelled and archived tasks are listed (so they can be found) but are not outstanding work: no figure counts them.
  const counted = tasks.filter(isCountedTask);
  const todayKey = clock.dayKey(new Date());
  const weekEnd = new Date(`${todayKey}T00:00:00Z`);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const weekEndKey = weekEnd.toISOString().slice(0, 10);
  const nameByUser = new Map(roster.map((r) => [r.userId, r.fullName]));
  const phaseName = new Map(phases.map((m) => [m.id, m.name]));
  const sprintName = new Map(sprints.map((sp0) => [sp0.id, sp0.name]));

  const q = (sp.q ?? '').trim().toLowerCase();
  const visible = tasks.filter(
    (t) =>
      (!q || t.title.toLowerCase().includes(q)) &&
      (!sp.phase || (sp.phase === 'none' ? t.milestoneId === null : t.milestoneId === sp.phase)) &&
      (!sp.status || t.status === sp.status) &&
      (!sp.assignee || (sp.assignee === 'none' ? t.assigneeId === null : t.assigneeId === sp.assignee)) &&
      (!sp.priority || t.priority === sp.priority) &&
      (!sp.sprint || (sp.sprint === 'none' ? t.sprintId === null : t.sprintId === sp.sprint)) &&
      (!sp.due ||
        (sp.due === 'overdue' && isOutstandingTask(t) && t.dueOn !== null && t.dueOn < todayKey) ||
        (sp.due === 'week' && t.dueOn !== null && t.dueOn >= todayKey && t.dueOn <= weekEndKey) ||
        (sp.due === 'none' && t.dueOn === null)) &&
      (sp.mine !== '1' || t.assigneeId === context.userId),
  );
  const filtering = visible.length !== tasks.length;

  const groups = groupsFor(visible, 'phase', { assignees: nameByUser, modules: new Map(), phases: phaseName }, { statuses: [], phases: phases.map((m) => m.id) });
  const whole = rollup(tasks);
  const count = (s: string) => counted.filter((t) => t.status === s).length;
  const share = (n: number) => (counted.length > 0 ? `${Math.round((n / counted.length) * 100)}%` : '0%');
  const completedTrend = trendOf(periodDelta(countPeriods(counted.map((t) => t.completedAt), new Date())));
  const createdTrend = trendOf(periodDelta(countPeriods(counted.map((t) => t.createdAt), new Date())));
  const daysLeft = project.ends_on ? Math.ceil((new Date(`${project.ends_on}T00:00:00Z`).getTime() - new Date(`${todayKey}T00:00:00Z`).getTime()) / 86_400_000) : null;

  const workload = [...new Set(counted.map((t) => t.assigneeId).filter((id): id is string => id !== null))]
    .map((id) => {
      const mine = counted.filter((t) => t.assigneeId === id);
      return { id, name: nameByUser.get(id) ?? 'Unknown', done: mine.filter((t) => t.status === 'done').length, total: mine.length };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  const canWrite = can(context, 'task.write');
  const base = `/projects/${projectId}`;

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader
        project={project}
        clock={clock}
        clientName={clientName}
        canEdit={can(context, 'project.write')}
        aside={
          <HeaderFigure value={`${whole.percent}%`} label="Overall progress">
            <ProgressBar value={whole.percent} showValue={false} label="Overall progress" tone="brand" />
          </HeaderFigure>
        }
      />

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={6}>
        <Stat compact label="Total tasks" value={String(counted.length)} caption="All phases" tone="brand" icon={<IconList size={16} />} trend={createdTrend} />
        <Stat compact label="Completed" value={String(count('done'))} caption={share(count('done'))} tone="success" icon={<IconCheck size={16} />} trend={completedTrend} />
        <Stat compact label="In progress" value={String(count('in_progress'))} caption={share(count('in_progress'))} tone="info" icon={<IconClock size={16} />} />
        <Stat compact label="Pending" value={String(count('todo'))} caption={share(count('todo'))} tone="warning" icon={<IconList size={16} />} />
        <Stat compact label="Blocked" value={String(count('blocked'))} caption={share(count('blocked'))} tone={count('blocked') > 0 ? 'danger' : 'neutral'} icon={<IconAlert size={16} />} />
        <Stat compact label="Overall progress" value={`${whole.percent}%`} caption={daysLeft === null ? 'No due date set' : daysLeft >= 0 ? `Due in ${daysLeft} days` : `${-daysLeft} days overdue`} tone="brand" icon={<IconCheck size={16} />} />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_17rem]">
        <section aria-labelledby="task-list-heading" className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-3 shadow-xs sm:p-4">
          <h2 id="task-list-heading" className="sr-only">Task list</h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`${buttonClass('secondary', 'sm')} border-brand bg-brand-soft text-brand`} aria-current="page">List view</span>
            <Link href={`${base}/board`} className={buttonClass('secondary', 'sm')}>Board view</Link>
            <Link href={`${base}/timeline`} className={buttonClass('secondary', 'sm')}>Timeline</Link>
            <Link href={`${base}/calendar`} className={buttonClass('secondary', 'sm')}>Calendar view</Link>
            <span className="ml-auto text-xs text-muted">{filtering ? `${visible.length} of ${tasks.length}` : tasks.length} task{tasks.length === 1 ? '' : 's'}</span>
            {canWrite ? <QuickTaskForm projectId={projectId} modules={modules.map((m) => ({ id: m.id, name: m.name }))} /> : null}
          </div>

          {visible.length === 0 ? (
            <EmptyState
              title={filtering ? 'No task matches these filters' : 'No tasks yet'}
              description={filtering ? 'Reset the filters to see every task on this project.' : 'Add the first task to start the list.'}
              action={<Link href={filtering ? `${base}/tasks` : `${base}/board`} className={buttonClass('secondary', 'sm')}>{filtering ? 'Reset filters' : 'Open the board'}</Link>}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                    <th className="w-8 py-2 pr-2">#</th>
                    <th className="py-2 pr-3">Task name</th>
                    <th className="py-2 pr-3">Phase</th>
                    <th className="py-2 pr-3">Sprint</th>
                    <th className="py-2 pr-3">Assigned to</th>
                    <th className="py-2 pr-3">Priority</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Due date</th>
                    <th className="py-2 text-right">Est. time</th>
                  </tr>
                </thead>
                {groups.map((g) => {
                  const rows = visible.filter((t) => (t.milestoneId ?? 'none') === g.key);
                  const r = rollup(rows);
                  let n = 0;
                  return (
                    <tbody key={g.key} className="divide-y divide-line">
                      <tr className="bg-brand-soft/60">
                        <th colSpan={9} scope="colgroup" className="px-2 py-2 text-left text-[13px] font-semibold text-foreground">
                          {g.label} <span className="font-normal text-muted">({r.done}/{r.total} completed)</span>
                        </th>
                      </tr>
                      {rows.map((t) => {
                        n += 1;
                        const p = PRIORITY[t.priority] ?? { label: t.priority, tone: 'neutral' as const };
                        return (
                          <tr key={t.id} className="hover:bg-surface-hover">
                            <td className="tabular py-2 pr-2 text-muted">{n}</td>
                            <td className="py-2 pr-3">
                              <Link href={`${base}/development/tasks/${t.id}`} className={`font-medium text-foreground hover:underline ${t.status === 'done' || t.status === 'cancelled' || t.archivedAt ? 'text-muted line-through' : ''}`}>{t.title}</Link>
                            </td>
                            <td className="py-2 pr-3 text-muted">{t.milestoneId ? (phaseName.get(t.milestoneId) ?? '—') : '—'}</td>
                            <td className="py-2 pr-3 text-muted">{t.sprintId ? (sprintName.get(t.sprintId) ?? '—') : '—'}</td>
                            <td className="py-2 pr-3">
                              {t.assigneeId ? (
                                <span className="flex items-center gap-2"><Avatar name={nameByUser.get(t.assigneeId) ?? '?'} size="sm" /><span className="truncate text-muted">{nameByUser.get(t.assigneeId) ?? 'Unknown'}</span></span>
                              ) : (
                                <span className="text-muted">Unassigned</span>
                              )}
                            </td>
                            <td className="py-2 pr-3"><Badge tone={p.tone}>{p.label}</Badge></td>
                            <td className="py-2 pr-3"><StatusBadge status={t.status} dot={false} /></td>
                            <td className="whitespace-nowrap py-2 pr-3 text-muted">{t.dueOn ? clock.date(t.dueOn) : '—'}</td>
                            <td className="tabular py-2 text-right text-muted">{t.estimateHours !== null ? `${t.estimateHours}h` : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  );
                })}
              </table>
            </div>
          )}
        </section>

        <div className="flex min-w-0 flex-col gap-4">
          <form method="get" action={`${base}/tasks`} className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold tracking-tight text-foreground">Filters</h2>
              <Link href={`${base}/tasks`} className="text-[13px] font-medium text-brand hover:underline">Reset</Link>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="f-q" className={labelClass}>Search</label>
              <span className="relative">
                <IconSearch size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                <input id="f-q" name="q" defaultValue={sp.q ?? ''} placeholder="Search tasks…" className={`${inputClass} pl-8`} />
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="f-phase" className={labelClass}>Phase</label>
              <select id="f-phase" name="phase" defaultValue={sp.phase ?? ''} className={selectClass}>
                <option value="">All phases</option>
                {phases.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
                <option value="none">No phase</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="f-sprint" className={labelClass}>Sprint</label>
              <select id="f-sprint" name="sprint" defaultValue={sp.sprint ?? ''} className={selectClass}>
                <option value="">All sprints</option>
                {sprints.map((s0) => (
                  <option key={s0.id} value={s0.id}>{s0.name}</option>
                ))}
                <option value="none">Not in a sprint</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="f-status" className={labelClass}>Status</label>
              <select id="f-status" name="status" defaultValue={sp.status ?? ''} className={selectClass}>
                <option value="">All statuses</option>
                {TASK_STATUSES.map((s) => (
                  <option key={s} value={s}>{humanize(s)}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="f-assignee" className={labelClass}>Assigned to</label>
              <select id="f-assignee" name="assignee" defaultValue={sp.assignee ?? ''} className={selectClass}>
                <option value="">All members</option>
                <option value="none">Unassigned</option>
                {roster.map((r) => (
                  <option key={r.userId} value={r.userId}>{r.fullName}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="f-priority" className={labelClass}>Priority</label>
              <select id="f-priority" name="priority" defaultValue={sp.priority ?? ''} className={selectClass}>
                <option value="">All priorities</option>
                {Object.entries(PRIORITY).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="f-due" className={labelClass}>Due date</label>
              <select id="f-due" name="due" defaultValue={sp.due ?? ''} className={selectClass}>
                <option value="">All dates</option>
                <option value="overdue">Overdue</option>
                <option value="week">Due this week</option>
                <option value="none">No due date</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-[13px] text-foreground">
              <input type="checkbox" name="archived" value="1" defaultChecked={sp.archived === '1'} className="h-4 w-4 rounded border-line-strong" />
              Show archived
            </label>
            <label className="flex items-center gap-2 text-[13px] text-foreground">
              <input type="checkbox" name="mine" value="1" defaultChecked={sp.mine === '1'} className="h-4 w-4 rounded border-line-strong" />
              Show my tasks only
            </label>
            <button type="submit" className={buttonClass('primary', 'sm')}>Filter</button>
          </form>

          <Card>
            <CardHeader title="Sprints" description="Fixed-length working periods of this project. A task sits in one." />
            <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
              {sprints.length === 0 ? (
                <p className="text-[13px] text-muted">No sprint yet{canWrite ? ' — create the first below.' : '.'}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {sprints.map((s0) => {
                    const state = sprintState(s0, todayKey);
                    const day = sprintDay(s0, todayKey);
                    return (
                      <li key={s0.id} className="flex flex-col gap-0.5 rounded-lg border border-line px-3 py-2 text-[13px]">
                        <span className="flex flex-wrap items-center gap-2">
                          <Link href={`${base}/tasks?sprint=${s0.id}`} className="font-medium text-foreground hover:underline">{s0.name}</Link>
                          <Badge tone={state === 'active' ? 'success' : state === 'upcoming' ? 'info' : state === 'ended' ? 'warning' : 'neutral'}>{state === 'ended' ? 'Ended, still open' : humanize(state)}</Badge>
                          {canWrite && !s0.closedAt ? <span className="ml-auto"><CloseSprintButton projectId={projectId} sprintId={s0.id} name={s0.name} /></span> : null}
                        </span>
                        <span className="text-xs text-muted">
                          {clock.date(s0.startsOn)} – {clock.date(s0.endsOn)} · {s0.lengthDays} days{day ? ` · day ${day.day} of ${day.of}` : ''}
                        </span>
                        <span className="tabular text-xs text-muted">{s0.done}/{s0.tasks} task{s0.tasks === 1 ? '' : 's'} done</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {canWrite ? <NewSprintForm projectId={projectId} defaultStart={todayKey} suggestedName={`Sprint ${sprints.length + 1}`} /> : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Team workload" actions={<Link href={`${base}/team`} className="text-[13px] font-medium text-brand hover:underline">View All</Link>} />
            {workload.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No task is assigned yet.</p>
            ) : (
              <ul className="flex flex-col gap-2.5 px-4 pb-4 sm:px-5">
                {workload.map((w) => (
                  <li key={w.id} className="flex items-center gap-2 text-[13px]">
                    <Avatar name={w.name} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{w.name}</span>
                    <span className="tabular text-xs text-muted">{w.done}/{w.total}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Quick actions" />
            <ul className="flex flex-col px-3 pb-3 text-[13px]">
              {[
                { label: 'Open the board', href: `${base}/board`, icon: <IconList size={14} /> },
                { label: 'View timeline', href: `${base}/timeline`, icon: <IconClock size={14} /> },
                { label: 'View milestones', href: `${base}/milestones`, icon: <IconCheck size={14} /> },
                { label: 'Export tasks', href: `/api/projects/${projectId}/report/pdf`, icon: <IconUpload size={14} /> },
              ].map((a) => (
                <li key={a.label}>
                  <Link href={a.href} className="flex h-9 items-center gap-2 rounded-lg px-2 font-medium text-foreground hover:bg-surface-hover">
                    <span className="text-muted">{a.icon}</span>
                    {a.label}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
