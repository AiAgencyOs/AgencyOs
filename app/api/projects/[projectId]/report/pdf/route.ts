import { NextResponse } from 'next/server';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { isDayKey, shiftDay } from '@/lib/admin/month-grid';
import { getAuthContext } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { renderProjectReportPdf } from '@/lib/pdf/project-report';
import { readProjectMargin } from '@/modules/finance/margin-queries';
import { listExpenses, listPaymentClaims, listProjectInvoices } from '@/modules/finance/queries';
import { verifiedOn } from '@/modules/finance/verified-basis';
import { readBlockersAcrossProjects } from '@/modules/projects/blockers-queries';
import { projectHealth } from '@/modules/projects/project-health';
import { getProject, listDevelopmentBreakdown, listInternalRoster, listPaymentPlan, listPhaseFourEscalations, readProjectSpend } from '@/modules/projects/queries';
import { listDefects } from '@/modules/qa/queries';
import { blocksDelivery, type DefectSeverity, type DefectStatus } from '@/modules/qa/schema';
import { routeError } from '@/lib/route-errors';

/**
 * SCR-026 "Export PDF" — the project report as a document, behind
 * `project.read`, through the existing PDF library (`src/lib/pdf`). The
 * same readers as the Reports page and the same health rule
 * (`projectHealth`), so the file is the page. Money is drawn only when the
 * caller may read it. A signed-out request is answered 401 as JSON rather
 * than redirected, because this URL is fetched by a link that expects a
 * file.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const money = (minor: number, currency: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const context = await getAuthContext();
  if (!context) return routeError('UNAUTHORIZED', 'Sign in to export a report.');
  if (!can(context, 'project.read')) return routeError('FORBIDDEN', 'You do not have permission to read this project.');

  const project = await getProject(projectId);
  if (!project) return routeError('NOT_FOUND', 'Project not found.');

  const mayReadMoney = can(context, 'invoice.read');
  const clock = await agencyClock();
  const url = new URL(request.url);
  const rawFrom = url.searchParams.get('from') ?? undefined;
  const rawTo = url.searchParams.get('to') ?? undefined;
  const today = clock.dayKey(new Date());
  const to = isDayKey(rawTo) ? rawTo : today;
  const from = isDayKey(rawFrom) && rawFrom <= to ? rawFrom : shiftDay(to, -83);

  const supabase = await createClient();
  const [plan, breakdown, defects, invoices, expenses, spend, roster, clientName, margin, blockers, escalations, claims, org] = await Promise.all([
    listPaymentPlan(projectId),
    listDevelopmentBreakdown(projectId, { excludeCancelled: true }),
    listDefects(projectId),
    mayReadMoney ? listProjectInvoices(projectId) : Promise.resolve([]),
    mayReadMoney ? listExpenses(1000) : Promise.resolve([]),
    readProjectSpend(projectId),
    listInternalRoster(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
    mayReadMoney ? readProjectMargin(projectId) : Promise.resolve(null),
    readBlockersAcrossProjects(),
    listPhaseFourEscalations(),
    mayReadMoney ? listPaymentClaims(projectId) : Promise.resolve([]),
    supabase.schema('core').from('organizations').select('name').limit(1).maybeSingle(),
  ]);

  const { tasks } = breakdown;
  const tasksDone = tasks.filter((t) => t.status === 'done').length;
  const tasksOverdue = tasks.filter((t) => t.status !== 'done' && t.dueOn && t.dueOn < today).length;
  const milestonesMet = plan.filter((m) => m.met_at).length;
  const milestonesOverdue = plan.filter((m) => !m.met_at && m.due_on && m.due_on < today).length;
  const completion = plan.length > 0 ? Math.round((milestonesMet / plan.length) * 100) : tasks.length > 0 ? Math.round((tasksDone / tasks.length) * 100) : 0;
  const openDefects = defects.filter((d) => d.status === 'open');
  const blocking = openDefects.filter((d) => blocksDelivery({ status: d.status as DefectStatus, severity: d.severity as DefectSeverity })).length;
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
  });

  const byStatus = new Map<string, number>();
  for (const t of tasks) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
  const byAssignee = new Map<string, { total: number; done: number }>();
  for (const t of tasks) {
    const key = t.assigneeId ?? 'unassigned';
    const row = byAssignee.get(key) ?? { total: 0, done: 0 };
    row.total += 1;
    if (t.status === 'done') row.done += 1;
    byAssignee.set(key, row);
  }
  const nameOf = (id: string) => (id === 'unassigned' ? 'Unassigned' : (roster.find((m) => m.userId === id)?.fullName ?? 'Former member'));

  const currency = project.currency;
  const invoiced = invoices.reduce((n, i) => n + (i.status === 'void' ? 0 : i.total_minor), 0);
  // verified, not recorded: the same basis as the margin (verified-basis.ts)
  const paid = invoices.reduce((n, i) => n + (i.status === 'void' || i.status === 'draft' ? 0 : verifiedOn(i)), 0);
  const spent = expenses.filter((e) => e.projectId === projectId).reduce((n, e) => n + e.amountMinor, 0);
  const aiCost = spend.reduce((n, r) => n + r.costMinor, 0);
  const budget = project.budget_minor ?? 0;

  const generatedAt = new Date().toISOString();
  const rendered = await renderProjectReportPdf({
    organizationName: org.data?.name ?? 'AgencyOS',
    projectName: project.name,
    projectCode: project.code,
    clientName,
    status: project.status,
    windowLabel: `${clock.date(`${from}T00:00:00`)} – ${clock.date(`${to}T00:00:00`)}`,
    generatedAt,
    timeZone: clock.timeZone,
    figures: [
      { label: 'Completion', value: `${completion}%`, caption: plan.length > 0 ? `${milestonesMet} of ${plan.length} milestones met` : `${tasksDone} of ${tasks.length} tasks done` },
      { label: 'Tasks', value: `${tasksDone}/${tasks.length}`, caption: tasksOverdue > 0 ? `${tasksOverdue} overdue` : null },
      { label: 'Open defects', value: String(openDefects.length), caption: blocking > 0 ? `${blocking} block delivery` : 'none block delivery' },
      { label: 'Due date', value: project.ends_on ? clock.date(project.ends_on) : '—' },
      { label: 'AI cost', value: aiCost > 0 ? money(aiCost, 'INR') : '—', caption: `${spend.reduce((n, r) => n + r.runs, 0)} agent runs` },
    ],
    health: { label: health.label, reasons: health.reasons },
    milestones: plan.map((m) => ({ name: m.name, dueLabel: m.due_on ? clock.date(m.due_on) : null, state: m.met_at ? `met ${clock.date(m.met_at)}` : m.due_on && m.due_on < today ? 'late' : m.status.replace(/_/g, ' ') })),
    tasksByStatus: [...byStatus].map(([label, count]) => ({ label: label.replace(/_/g, ' '), count })),
    workByPerson: [...byAssignee].map(([id, v]) => ({ name: nameOf(id), done: v.done, total: v.total })),
    risks: openDefects.map((d) => ({ title: d.title, severity: d.severity, status: d.status })),
    money: mayReadMoney
      ? [
          { label: 'Budget', value: budget > 0 ? money(budget, currency) : '—' },
          { label: 'Invoiced', value: money(invoiced, currency) },
          { label: 'Paid', value: money(paid, currency) },
          { label: 'Expenses recorded', value: money(spent, currency) },
          { label: 'AI cost', value: aiCost > 0 ? money(aiCost, 'INR') : '—' },
          ...(margin ? [{ label: `Margin · ${margin.label}`, value: `${money(margin.marginMinor, currency)}${margin.marginPercent !== null ? ` (${margin.marginPercent}% of paid)` : ''}` }] : []),
        ]
      : null,
    marginNote: margin ? `${money(margin.paidMinor, currency)} paid − (${money(margin.expensesMinor, currency)} expenses + ${money(margin.aiCostMinor, 'INR')} AI cost + ${money(margin.timeCostMinor, 'INR')} time cost). Invoiced-but-unpaid amounts are not counted.` : null,
    reference: `/projects/${projectId}/reports`,
  });

  return new NextResponse(Buffer.from(rendered.bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${rendered.filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
