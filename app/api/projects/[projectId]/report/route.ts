import { NextResponse } from 'next/server';

import { agencyClock } from '@/lib/admin/agency-clock';
import { isDayKey, shiftDay } from '@/lib/admin/month-grid';
import { getAuthContext } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readProjectMargin } from '@/modules/finance/margin-queries';
import { getProject, listDevelopmentBreakdown, listInternalRoster } from '@/modules/projects/queries';
import { listReportTasks } from '@/modules/projects/report-queries';

/**
 * SCR-026 — the project report as CSV, behind `project.read`.
 *
 * Same reader as the Reports page, same `?from=&to=` window, so the file
 * is the page. RLS still decides which rows exist. A signed-out request is
 * answered 401 as JSON rather than redirected: this URL is fetched by a
 * link on a page, and a redirect to /login would hand a download a page of
 * HTML.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await getAuthContext();
  if (!context) return NextResponse.json({ error: 'Sign in to export a report.' }, { status: 401 });
  if (!can(context, 'project.read')) {
    return NextResponse.json({ error: 'You do not have permission to read this project.' }, { status: 403 });
  }

  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const clock = await agencyClock();
  const url = new URL(request.url);
  const rawFrom = url.searchParams.get('from') ?? undefined;
  const rawTo = url.searchParams.get('to') ?? undefined;
  const today = clock.dayKey(new Date());
  const to = isDayKey(rawTo) ? rawTo : today;
  const from = isDayKey(rawFrom) && rawFrom <= to ? rawFrom : shiftDay(to, -83);

  const [tasks, { modules }, roster] = await Promise.all([
    listReportTasks(projectId, { from, to }),
    listDevelopmentBreakdown(projectId, { excludeCancelled: true }),
    listInternalRoster(),
  ]);
  const moduleName = new Map(modules.map((m) => [m.id, m.name]));
  const memberName = new Map(roster.map((r) => [r.userId, r.fullName]));

  const header = ['task_id', 'title', 'status', 'priority', 'module', 'assignee', 'due_on', 'created_at', 'completed_at'];
  const lines = [header.join(',')];
  for (const t of tasks) {
    lines.push(
      [
        t.id,
        t.title,
        t.status,
        t.priority,
        t.moduleId ? (moduleName.get(t.moduleId) ?? '') : '',
        t.assigneeId ? (memberName.get(t.assigneeId) ?? '') : '',
        t.dueOn,
        t.createdAt,
        t.completedAt,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  // Margin — decision: reversed by the owner on 2026-09-29. Appended as its
  // own block, only for a reader who may read money, in minor units as the
  // rows are stored. Cash basis: paid − (expenses + AI cost + time cost);
  // time costed at each person's day-of-log rate (decision E2 of
  // 2026-09-30), with uncosted hours carried as their own row rather than
  // silently priced at zero.
  if (can(context, 'invoice.read')) {
    const margin = await readProjectMargin(projectId);
    lines.push('');
    lines.push(['metric', 'value_minor', 'basis'].join(','));
    lines.push(['paid', margin.paidMinor, 'cash-basis estimate'].map(csvCell).join(','));
    lines.push(['expenses', margin.expensesMinor, 'recorded'].map(csvCell).join(','));
    lines.push(['ai_cost', margin.aiCostMinor, 'recorded, INR'].map(csvCell).join(','));
    lines.push(['time_cost', margin.timeCostMinor, 'logged hours at the rate in force on the day of each log, INR'].map(csvCell).join(','));
    lines.push(['uncosted_hours', margin.uncostedHours, 'hours with no rate on their day — not in time_cost'].map(csvCell).join(','));
    lines.push(['margin', margin.marginMinor, `${margin.label}; paid − (expenses + ai_cost + time_cost)`].map(csvCell).join(','));
  }

  const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  return new NextResponse(`${lines.join('\n')}\n`, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slug}-report-${from}-to-${to}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
