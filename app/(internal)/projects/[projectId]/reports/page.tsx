import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { isDayKey, shiftDay } from '@/lib/admin/month-grid';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readProjectMargin } from '@/modules/finance/margin-queries';
import { readProjectBudgetVariance } from '@/modules/finance/budget-variance-queries';
import { listExpenses, listProjectInvoices } from '@/modules/finance/queries';
import {
  getProject,
  listDevelopmentBreakdown,
  listInternalRoster,
  listPaymentPlan,
  readProjectSpend,
} from '@/modules/projects/queries';
import { listReportTasks, weekStartOf, weeksBetween } from '@/modules/projects/report-queries';
import { composeRecentActivity, resourceBars } from '@/modules/projects/report-cards';
import { listProjectFiles } from '@/modules/projects/queries';
import { readProjectTime } from '@/modules/projects/time-log-queries';
import { listPaymentClaims } from '@/modules/finance/queries';
import { readBlockersAcrossProjects } from '@/modules/projects/blockers-queries';
import { overallProgress, projectHealth } from '@/modules/projects/project-health';
import { listPhaseFourEscalations } from '@/modules/projects/queries';
import { listDefects } from '@/modules/qa/queries';
import { blocksDelivery, type DefectSeverity, type DefectStatus } from '@/modules/qa/schema';
import {
  BarChart,
  buttonClass,
  Card,
  CardHeader,
  DonutChart,
  humanize,
  IconAlert,
  IconCheck,
  IconClock,
  IconDownload,
  IconFlag,
  IconRupee,
  IconUsage,
  inputClass,
  labelClass,
  PermissionDenied,
  ProgressBar,
  Avatar,
  Stat,
  StatGrid,
  cx,
  TrendChart,
  ViewAll,
} from '@/ui';

/** Default completion-trend window: the last twelve weeks, ending today. */
const DEFAULT_WEEKS = 12;

import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';

export const metadata: Metadata = { title: 'Project report' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

const SEVERITY_COLOR: Record<string, string> = {
  blocker: 'var(--danger)',
  major: 'var(--warning)',
  minor: 'var(--info)',
  trivial: 'var(--faint)',
};

/**
 * SCR-026 — one project's report: the org-wide Reports page narrowed to a
 * single project, built from the readers each tab already uses (plan,
 * board, QA, invoices, expenses, agent spend). Every figure is one the tab
 * it summarises prints; nothing here is computed that the rest of the app
 * does not also show. No stored trend series exists, so nothing is
 * extrapolated — the completion figures are milestones met and tasks done,
 * not a projection.
 */
export default async function ProjectReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { projectId } = await params;
  const { from: rawFrom, to: rawTo } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/reports`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const mayReadMoney = can(context, 'invoice.read');
  const [plan, breakdown, defects, invoices, expenses, spend, roster, clock, clientName, time, margin] = await Promise.all([
    listPaymentPlan(projectId),
    listDevelopmentBreakdown(projectId),
    listDefects(projectId),
    mayReadMoney ? listProjectInvoices(projectId) : Promise.resolve([]),
    mayReadMoney ? listExpenses(1000) : Promise.resolve([]),
    readProjectSpend(projectId),
    listInternalRoster(),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
    // Decision 4 of 2026-09-29: hours logged, per person and per task; costed
    // at each person's day-of-log rate by decision E2 of 2026-09-30. The cost
    // figures render only where `invoice.read` holds (mayReadMoney).
    readProjectTime(projectId),
    // Margin — decision: reversed by the owner on 2026-09-29. Cash basis, time cost included.
    mayReadMoney ? readProjectMargin(projectId) : Promise.resolve(null),
  ]);
  // SCR-026: the health panel's inputs — the same facts the projects list and
  // the PDF export read, through one pure rule (`projectHealth`).
  const [blockers, escalations, claims] = await Promise.all([
    readBlockersAcrossProjects(),
    listPhaseFourEscalations(),
    mayReadMoney ? listPaymentClaims(projectId) : Promise.resolve([]),
  ]);
  // Budget vs actual — decision F5 of 2026-09-30 (reopened): the budget
  // against expenses + AI cost + time cost, with the monthly burn. The same
  // pure function Finance › Expenses uses.
  const variance = mayReadMoney ? await readProjectBudgetVariance(projectId) : null;
  const timeCsvHref = `/api/projects/${projectId}/report/time`;
  const pdfHref = `/api/projects/${projectId}/report/pdf`;

  const currency = project.currency;
  const { tasks, modules } = breakdown;
  const tasksDone = tasks.filter((t) => t.status === 'done').length;
  const today = clock.dayKey(new Date());

  // SCR-026: the completion trend — tasks completed per ISO week from
  // `tasks.completed_at`, over `?from=&to=` (default: the last twelve
  // weeks). `listReportTasks` also feeds the CSV route, so the file is the
  // page. No stored series exists; every point is a count of real rows.
  const to = isDayKey(rawTo) ? rawTo : today;
  const from = isDayKey(rawFrom) && rawFrom <= to ? rawFrom : shiftDay(to, -(DEFAULT_WEEKS * 7 - 1));
  const reportTasks = await listReportTasks(projectId, { from, to });
  const completedInRange = reportTasks.filter((t) => t.completedAt !== null);
  const weeks = weeksBetween(from, to);
  const countByWeek = new Map<string, number>(weeks.map((w) => [w, 0]));
  for (const t of completedInRange) {
    const week = weekStartOf(clock.dayKey(t.completedAt as string));
    if (countByWeek.has(week)) countByWeek.set(week, (countByWeek.get(week) ?? 0) + 1);
  }
  const trend = weeks.map((w) => ({ week: clock.date(`${w}T00:00:00`), completed: countByWeek.get(w) ?? 0 }));
  const reportBase = `/projects/${projectId}/reports`;
  const csvHref = `/api/projects/${projectId}/report?from=${from}&to=${to}`;
  const tasksOverdue = tasks.filter((t) => t.status !== 'done' && t.dueOn && t.dueOn < today).length;
  const milestonesMet = plan.filter((m) => m.met_at).length;
  const completion = overallProgress({ milestonesTotal: plan.length, milestonesMet, tasksTotal: tasks.length, tasksDone });

  const byStatus = new Map<string, number>();
  for (const t of tasks) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
  const byPriority = new Map<string, number>();
  for (const t of tasks) byPriority.set(t.priority, (byPriority.get(t.priority) ?? 0) + 1);
  const byAssignee = new Map<string, { total: number; done: number }>();
  for (const t of tasks) {
    const key = t.assigneeId ?? 'unassigned';
    const row = byAssignee.get(key) ?? { total: 0, done: 0 };
    row.total += 1;
    if (t.status === 'done') row.done += 1;
    byAssignee.set(key, row);
  }
  const nameOf = (id: string) => (id === 'unassigned' ? 'Unassigned' : (roster.find((m) => m.userId === id)?.fullName ?? 'Former member'));

  const openDefects = defects.filter((d) => d.status === 'open');
  const blocking = openDefects.filter((d) => blocksDelivery({ status: d.status as DefectStatus, severity: d.severity as DefectSeverity })).length;
  const bySeverity = new Map<string, number>();
  for (const d of openDefects) bySeverity.set(d.severity, (bySeverity.get(d.severity) ?? 0) + 1);

  const invoiced = invoices.reduce((n, i) => n + (i.status === 'void' ? 0 : i.total_minor), 0);
  const paid = invoices.reduce((n, i) => n + i.paid_minor, 0);
  const projectExpenses = expenses.filter((e) => e.projectId === projectId);
  const spent = projectExpenses.reduce((n, e) => n + e.amountMinor, 0);
  const aiCost = spend.reduce((n, r) => n + r.costMinor, 0);
  const aiRuns = spend.reduce((n, r) => n + r.runs, 0);
  const budget = project.budget_minor ?? 0;
  const milestonesOverdue = plan.filter((m) => !m.met_at && m.due_on && m.due_on < today).length;
  const mine = blockers.find((b) => b.projectId === projectId);
  const health = projectHealth({
    status: project.status,
    blockedTasks: mine?.blockedTasks.length ?? 0,
    unmetDependencies: mine?.dependencies.length ?? 0,
    overdueTasks: tasksOverdue,
    overdueMilestones: milestonesOverdue,
    blockingDefects: blocking,
    escalations: escalations.filter((e) => e.projectId === projectId).length,
    pendingClaims: claims.filter((c) => c.status === 'pending').length,
    pastDue: project.ends_on !== null && project.ends_on < today,
  });
  const overdueTasks = tasks.filter((t) => t.status !== 'done' && t.dueOn && t.dueOn < today);
  // Recent Activity — a timeline of what each table already timestamps (not the audit log); Resource Usage — hours per person.
  const projectFiles = await listProjectFiles(projectId);
  const activity = composeRecentActivity({
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, completedAt: t.completedAt ?? null, assigneeName: t.assigneeId ? nameOf(t.assigneeId) : null })),
    milestones: plan,
    defects,
    files: projectFiles,
  }, 5, projectId);
  const resources = resourceBars(time.people);

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={can(context, 'project.write')} />

      <ProjectSubNav projectId={projectId} />

      <section aria-labelledby="reports-title" className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="reports-title" className="text-xl font-bold tracking-tight text-foreground">Project Reports</h2>
          <p className="text-[13px] text-muted">Track progress, performance, team activity and key insights</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
        <form action={reportBase} method="GET" className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>From</span>
            <input type="date" name="from" defaultValue={from} max={to} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>To</span>
            <input type="date" name="to" defaultValue={to} className={inputClass} />
          </label>
          <button type="submit" className={buttonClass('secondary', 'sm')}>
            Apply
          </button>
          {rawFrom || rawTo ? (
            <Link href={reportBase} className={buttonClass('ghost', 'sm')}>
              Last {DEFAULT_WEEKS} weeks
            </Link>
          ) : null}
        </form>
        <a href={csvHref} className={cx(buttonClass('secondary', 'sm'), 'sm:ml-auto')}>
          <IconDownload size={14} />
          Export CSV
        </a>
        {/* SCR-026: the report as a document, through src/lib/pdf — the same readers and the same health rule as this page. */}
        <a href={`${pdfHref}?from=${from}&to=${to}`} className={buttonClass('secondary', 'sm')}>
          <IconDownload size={14} />
          Export PDF
        </a>
        </div>
      </section>

      <StatGrid cols={5}>
        <Stat label="Completion" value={`${completion}%`} caption={plan.length > 0 ? `${milestonesMet} of ${plan.length} milestones met` : `${tasksDone} of ${tasks.length} tasks done`} tone="brand" icon={<IconFlag size={16} />} href={`/projects/${projectId}/plan`} />
        <Stat label="Tasks" value={`${tasksDone}/${tasks.length}`} caption={tasksOverdue > 0 ? `${tasksOverdue} overdue` : `${modules.length} modules`} tone={tasksOverdue > 0 ? 'warning' : 'info'} icon={<IconCheck size={16} />} href={`/projects/${projectId}/board`} />
        <Stat label="Open defects" value={String(openDefects.length)} caption={blocking > 0 ? `${blocking} block delivery` : 'None block delivery'} tone={blocking > 0 ? 'danger' : openDefects.length > 0 ? 'warning' : 'success'} icon={<IconAlert size={16} />} href={`/projects/${projectId}/qa`} />
        {mayReadMoney ? (
          <Stat label="Invoiced / paid" value={money(paid, currency)} caption={`of ${money(invoiced, currency)} invoiced${budget > 0 ? ` · budget ${money(budget, currency)}` : ''}`} tone="success" icon={<IconRupee size={16} />} href="/invoices" />
        ) : (
          <Stat label="Schedule" value={project.ends_on ? clock.date(project.ends_on) : '—'} caption="Due date" tone="neutral" icon={<IconClock size={16} />} />
        )}
        <Stat label="AI cost" value={aiCost > 0 ? money(aiCost, 'INR') : '—'} caption={aiRuns > 0 ? `${aiRuns} agent runs` : 'No runs attributed'} tone="accent" icon={<IconUsage size={16} />} href={`/projects/${projectId}/design`} />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
        <CardHeader
          title="Task Completion Trend"
          description={`Tasks completed per week (Monday start), ${clock.date(`${from}T00:00:00`)} – ${clock.date(`${to}T00:00:00`)} · ${completedInRange.length} in range.`}
          actions={<ViewAll href={`/projects/${projectId}/board`} label="Board" />}
        />
        {completedInRange.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No task was completed in this range.</p>
        ) : (
          <div className="px-4 pb-4 sm:px-5">
            <TrendChart data={trend} series={[{ key: 'completed', label: 'Completed' }]} xKey="week" height={200} />
          </div>
        )}
      </Card>

        <Card>
          <CardHeader title="Task Distribution" actions={<ViewAll href={`/projects/${projectId}/board`} label="Board" />} />
          {tasks.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No tasks yet.</p>
          ) : (
            <div className="grid gap-4 px-4 pb-4 sm:px-5">
              <DonutChart data={[...byStatus.entries()].map(([label, value]) => ({ label: humanize(label), value }))} totalLabel="Tasks" height={170} />
              <BarChart data={[...byPriority.entries()].map(([label, value]) => ({ label: humanize(label), value }))} height={170} />
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Team Activity" actions={<ViewAll href={`/projects/${projectId}/team`} label="Team" />} />
          {byAssignee.size === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing assigned yet.</p>
          ) : (
            <ul className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
              {[...byAssignee.entries()]
                .sort((a, b) => b[1].total - a[1].total)
                .map(([id, row]) => (
                  <li key={id} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between text-[13px]">
                      <span className="font-medium">{nameOf(id)}</span>
                      <span className="text-muted tabular">{row.done}/{row.total}</span>
                    </div>
                    <ProgressBar value={row.total > 0 ? (row.done / row.total) * 100 : 0} label={`${nameOf(id)} tasks done`} />
                  </li>
                ))}
            </ul>
          )}
        </Card>

      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader title="Phase Progress" actions={<ViewAll href={`/projects/${projectId}/plan`} label="Plan" />} />
          {plan.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No payment plan yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {plan.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px] sm:px-5">
                  <span className={m.met_at ? 'text-muted line-through' : ''}>{m.position + 1}. {m.name}</span>
                  <span className="text-xs text-muted">
                    {m.met_at ? `met ${clock.date(m.met_at)}` : m.due_on ? (m.due_on < today ? <span className="text-danger">late · due {clock.date(m.due_on)}</span> : `due ${clock.date(m.due_on)}`) : 'undated'}
                    {m.payment_percent !== null ? ` · ${Number(m.payment_percent)}%` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Upcoming Deadlines" actions={<ViewAll href={`/projects/${projectId}/plan`} />} />
          {plan.filter((m) => !m.met_at && m.due_on).length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing dated ahead.</p>
          ) : (
            <ul className="divide-y divide-line">
              {plan.filter((m) => !m.met_at && m.due_on).slice(0, 5).map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 px-4 py-2 text-[13px] sm:px-5">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">{m.name}</span>
                    <span className="block text-xs text-muted">{m.due_on ? clock.date(m.due_on) : ''}</span>
                  </span>
                  <span className={cx('shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium', m.due_on && m.due_on < today ? 'bg-danger-soft text-danger' : 'bg-info-soft text-info')}>{m.due_on && m.due_on < today ? 'Late' : 'Upcoming'}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Recent Activity" description="Tasks done, milestones met, defects raised and files added — from each table's own dates, not the audit log." />
          {activity.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing has happened on this project yet.</p>
          ) : (
            <ul className="flex flex-col gap-2.5 px-4 pb-4 sm:px-5">
              {activity.map((e) => (
                <li key={e.key} className="flex items-start gap-2.5 text-[13px]">
                  <span className={cx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', e.tone === 'success' ? 'bg-success-soft text-success' : e.tone === 'warning' ? 'bg-warning-soft text-warning' : e.tone === 'info' ? 'bg-info-soft text-info' : 'bg-brand-soft text-brand')}>
                    <IconCheck size={13} />
                  </span>
                  <span className="min-w-0">
                    <span className="block break-words">{e.who ? <span className="font-medium">{e.who} </span> : null}{e.verb} {e.href ? <Link href={e.href} className="font-medium hover:underline">{e.subject}</Link> : <span className="font-medium">{e.subject}</span>}</span>
                    <span className="block text-xs text-muted">{clock.dateTime(e.at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader title="Resource Usage" description="Hours logged per person — the busiest is the full bar." actions={<ViewAll href={`/projects/${projectId}/team`} label="Team" />} />
          {resources.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No time logged yet. Hours are logged per task from the task drawer.</p>
          ) : (
            <ul className="flex flex-col gap-2.5 px-4 pb-4 sm:px-5">
              {resources.map((r) => (
                <li key={r.name} className="flex items-center gap-2.5 text-[13px]">
                  <Avatar name={r.name} size="sm" />
                  <span className="w-28 shrink-0 truncate">{r.name}</span>
                  <ProgressBar value={r.percentOfBusiest} tone="brand" showValue={false} label={`${r.name}: ${r.hours} hours`} className="flex-1" />
                  <span className="tabular w-14 shrink-0 text-right text-xs text-muted">{r.hours} h</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Project Health" />
          <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
            <div className={cx('rounded-xl px-4 py-3', health.level === 'blocked' ? 'bg-danger-soft text-danger' : health.level === 'at_risk' ? 'bg-warning-soft text-warning' : 'bg-success-soft text-success')}>
              <p className="text-lg font-bold">{health.label}</p>
              <p className="text-[13px]">{health.reasons.length === 0 ? 'No blocked work, nothing past due, no release-blocking defect.' : `${health.reasons.length} reason${health.reasons.length === 1 ? '' : 's'}.`}</p>
            </div>
        {health.reasons.length > 0 ? (
          <ul className="flex flex-wrap gap-2 ">
            {health.reasons.map((r) => (
              <li key={r}>
                <Link
                  href={
                    /task/.test(r) ? `/projects/${projectId}/board` : /milestone/.test(r) ? `/projects/${projectId}/plan` : /defect/.test(r) ? `/projects/${projectId}/qa` : /claim/.test(r) ? `/projects/${projectId}` : /escalation/.test(r) ? '/projects/escalations' : `/projects/${projectId}/plan`
                  }
                  className={cx('inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset', health.level === 'blocked' ? 'bg-danger-soft text-danger ring-danger/25' : 'bg-warning-soft text-warning ring-warning/30')}
                >
                  {r}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
          </div>
        </Card>
        <Card>
          <CardHeader title="Risks & Issues" actions={<ViewAll href={`/projects/${projectId}/qa`} label="QA" />} />
          {openDefects.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No open defects.</p>
          ) : (
            <div className="px-4 pb-4 sm:px-5">
              <BarChart
                data={['blocker', 'major', 'minor', 'trivial'].filter((s) => bySeverity.has(s)).map((s) => ({ label: humanize(s), value: bySeverity.get(s) ?? 0 }))}
                colors={['blocker', 'major', 'minor', 'trivial'].filter((s) => bySeverity.has(s)).map((s) => SEVERITY_COLOR[s] ?? 'var(--brand)')}
                height={170}
              />
            </div>
          )}
          {/* SCR-026: each risk opens the underlying defect or task, not just the card. */}
          {openDefects.length > 0 ? (
            <ul className="divide-y divide-line border-t border-line">
              {openDefects.slice(0, 8).map((d) => (
                <li key={d.id}>
                  <Link href={`/projects/${projectId}/qa#defect-${d.id}`} className="flex items-center justify-between gap-2 px-4 py-1.5 text-[13px] hover:bg-surface-hover sm:px-5">
                    <span className="truncate">{d.title}</span>
                    <span className={cx('shrink-0 text-xs', d.severity === 'blocker' ? 'text-danger' : 'text-muted')}>{humanize(d.severity)}</span>
                  </Link>
                </li>
              ))}
              {openDefects.length > 8 ? <li className="px-4 py-1.5 text-xs text-muted sm:px-5">and {openDefects.length - 8} more on the QA tab.</li> : null}
            </ul>
          ) : null}
          {overdueTasks.length > 0 ? (
            <ul className="divide-y divide-line border-t border-line">
              {overdueTasks.slice(0, 6).map((t) => (
                <li key={t.id}>
                  <Link href={`/projects/${projectId}/development/tasks/${t.id}`} className="flex items-center justify-between gap-2 px-4 py-1.5 text-[13px] hover:bg-surface-hover sm:px-5">
                    <span className="truncate">{t.title}</span>
                    <span className="shrink-0 text-xs text-warning">past due {t.dueOn ? clock.date(t.dueOn) : ''}</span>
                  </Link>
                </li>
              ))}
              {overdueTasks.length > 6 ? <li className="px-4 py-1.5 text-xs text-muted sm:px-5">and {overdueTasks.length - 6} more on the Board.</li> : null}
            </ul>
          ) : null}
        </Card>

      </div>

      <Card>
        <CardHeader
          title="Time"
          description={
            time.entryCount > 0
              ? `${time.totalHours} h logged in ${time.entryCount} entr${time.entryCount === 1 ? 'y' : 'ies'} by ${time.people.length} ${time.people.length === 1 ? 'person' : 'people'}.${
                  mayReadMoney
                    ? ` Cost ${money(time.costMinor, 'INR')} at each person's rate on the day of the log${time.uncostedHours > 0 ? `; ${time.uncostedHours} h uncosted — no rate on those days` : ''}. Cost, not billing.`
                    : ' Nothing here is billed.'
                }`
              : 'No time logged yet. Hours are logged per task from the task drawer (decision 4 of 2026-09-29).'
          }
          actions={
            <a href={timeCsvHref} className={buttonClass('ghost', 'sm')}>
              <IconDownload size={14} />
              Time CSV
            </a>
          }
        />
        {time.entryCount === 0 ? null : (
          <div className="grid gap-4 px-4 pb-4 sm:grid-cols-2 sm:px-5">
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Per person</p>
              <ul className="flex flex-col gap-1 text-[13px]">
                {time.people.map((p) => (
                  <li key={p.personId} className="flex items-baseline justify-between gap-2">
                    <span className="truncate">{p.personName}</span>
                    <span className="tabular text-muted">
                      {p.hours} h · {p.entries}
                      {mayReadMoney ? ` · ${money(p.costMinor, 'INR')}` : ''}
                      {mayReadMoney && p.uncostedHours > 0 ? <span className="ml-1 text-warning">{p.uncostedHours} h uncosted</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Per task</p>
              <ul className="flex flex-col gap-1 text-[13px]">
                {time.tasks.slice(0, 12).map((t) => (
                  <li key={t.taskId} className="flex items-baseline justify-between gap-2">
                    <Link href={`/projects/${projectId}/development/tasks/${t.taskId}`} className="truncate underline-offset-2 hover:underline">{t.taskTitle}</Link>
                    <span className="tabular text-muted">
                      {t.hours} h · {t.entries}
                      {mayReadMoney ? ` · ${money(t.costMinor, 'INR')}` : ''}
                      {mayReadMoney && t.uncostedHours > 0 ? <span className="ml-1 text-warning">{t.uncostedHours} h uncosted</span> : null}
                    </span>
                  </li>
                ))}
                {time.tasks.length > 12 ? <li className="text-xs text-muted">and {time.tasks.length - 12} more in the CSV.</li> : null}
              </ul>
            </div>
          </div>
        )}
      </Card>

        {mayReadMoney ? (
          <Card>
            {/* Margin — decision: reversed by the owner on 2026-09-29. Cash-basis estimate: paid − (expenses + AI cost + time cost); time costed per person by decision E2 of 2026-09-30. */}
            <CardHeader title="Money" description="Invoiced and paid against budget and recorded cost, and the margin between what was paid and what was spent — a cash-basis estimate." actions={<ViewAll href="/finance/expenses" label="Expenses" />} />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 pb-4 text-[13px] sm:grid-cols-6 sm:px-5">
              <div><dt className="text-xs text-muted">Budget</dt><dd className="tabular font-medium">{budget > 0 ? money(budget, currency) : '—'}</dd></div>
              <div><dt className="text-xs text-muted">Invoiced</dt><dd className="tabular font-medium">{money(invoiced, currency)}</dd></div>
              <div><dt className="text-xs text-muted">Paid</dt><dd className="tabular font-medium text-success">{money(paid, currency)}</dd></div>
              <div><dt className="text-xs text-muted">Expenses recorded</dt><dd className="tabular font-medium text-danger">{money(spent, currency)}</dd></div>
              <div><dt className="text-xs text-muted">AI cost</dt><dd className="tabular font-medium">{aiCost > 0 ? money(aiCost, 'INR') : '—'}</dd></div>
              <div><dt className="text-xs text-muted">Time cost</dt><dd className="tabular font-medium">{margin && margin.timeCostMinor > 0 ? money(margin.timeCostMinor, 'INR') : '—'}</dd></div>
            </dl>
            {margin ? (
              <div className="mx-4 mb-4 rounded-lg border border-line bg-canvas px-4 py-3 sm:mx-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-muted">Margin · {margin.label}</span>
                  <span className={cx('tabular text-base font-semibold', margin.marginMinor < 0 ? 'text-danger' : 'text-success')}>
                    {money(margin.marginMinor, currency)}
                    {margin.marginPercent !== null ? <span className="ml-2 text-xs font-normal text-muted">{margin.marginPercent}% of paid</span> : null}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {money(margin.paidMinor, currency)} paid − ({money(margin.expensesMinor, currency)} expenses + {money(margin.aiCostMinor, 'INR')} AI cost + {money(margin.timeCostMinor, 'INR')} time cost). Invoiced-but-unpaid amounts are not counted.
                  {' '}Time is costed at each person&rsquo;s rate on the day of the log.
                  {margin.uncostedHours > 0 ? <span className="text-warning"> {margin.uncostedHours} h uncosted — no rate on those days; those hours are not in the cost.</span> : null}
                </p>
              </div>
            ) : null}
            {variance ? (
              <div className="mx-4 mb-4 rounded-lg border border-line bg-canvas px-4 py-3 sm:mx-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-muted">Budget vs actual · decision F5</span>
                  {variance.varianceMinor !== null ? (
                    <span className={cx('tabular text-base font-semibold', variance.standing === 'over' ? 'text-danger' : variance.standing === 'under' ? 'text-success' : 'text-foreground')}>
                      {variance.varianceMinor < 0 ? '−' : ''}{money(Math.abs(variance.varianceMinor), currency)} {variance.standing === 'over' ? 'over' : variance.standing === 'under' ? 'under' : 'on'} budget
                      <span className="ml-2 text-xs font-normal text-muted">{variance.consumedPercent}% consumed</span>
                    </span>
                  ) : (
                    <span className="text-[13px] text-muted">No budget recorded — the variance is unknowable, not zero.</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted">
                  {mayReadMoney ? `Actual ${money(variance.actualMinor, currency)} = ${money(variance.expensesMinor, currency)} expenses + ${money(variance.aiCostMinor, 'INR')} AI cost + ${money(variance.timeCostMinor, 'INR')} time cost.` : null}
                  {variance.averageBurnMinor > 0 ? ` Average burn ${money(variance.averageBurnMinor, currency)} per month over ${variance.monthly.filter((m) => m.totalMinor > 0).length} month${variance.monthly.filter((m) => m.totalMinor > 0).length === 1 ? '' : 's'} with cost${variance.monthsLeftAtBurn !== null ? `; ${variance.monthsLeftAtBurn} month${variance.monthsLeftAtBurn === 1 ? '' : 's'} of budget left at that burn` : ''}.` : ' Nothing has burned yet.'}
                  {mayReadMoney && variance.uncostedHours > 0 ? <span className="text-warning"> {variance.uncostedHours} h uncosted — no rate on those days.</span> : null}
                </p>
                {variance.monthly.length > 0 ? (
                  <ul className="mt-2 flex flex-wrap gap-2 text-xs">
                    {variance.monthly.slice(-12).map((m) => (
                      <li key={m.month} className="rounded-md border border-line bg-surface px-2 py-1 tabular">
                        <span className="text-muted">{m.month}</span> {money(m.totalMinor, currency)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-1 text-[11px] text-faint">Months by calendar date of the expense or log, and UTC for an AI run.</p>
              </div>
            ) : null}
            {budget > 0 ? (
              <div className="px-4 pb-4 sm:px-5">
                <ProgressBar value={Math.min(100, (invoiced / budget) * 100)} label="Invoiced against budget" />
                <p className="mt-1 text-xs text-muted">{Math.round((invoiced / budget) * 100)}% of budget invoiced.</p>
              </div>
            ) : null}
          </Card>
        ) : null}
    </div>
  );
}
