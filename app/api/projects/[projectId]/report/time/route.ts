import { NextResponse } from 'next/server';

import { getAuthContext } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject } from '@/modules/projects/queries';
import { readProjectTime } from '@/modules/projects/time-log-queries';

/**
 * The project's time logs as CSV — decision 4 of 2026-09-29. Same reader
 * as the report page's Time section, so the file is the page: one row per
 * entry, then the per-person and per-task totals under their own headers.
 * Behind `project.read`; RLS decides which rows exist. Hours only — no
 * rate, no money, because none is recorded.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await getAuthContext();
  if (!context) return NextResponse.json({ error: 'Sign in to export time logs.' }, { status: 401 });
  if (!can(context.role, 'project.read')) {
    return NextResponse.json({ error: 'You do not have permission to read this project.' }, { status: 403 });
  }

  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const time = await readProjectTime(projectId);
  const taskTitle = new Map(time.tasks.map((t) => [t.taskId, t.taskTitle]));

  const lines: string[] = [];
  lines.push(['entry_id', 'task_id', 'task', 'person', 'hours', 'logged_on', 'note', 'created_at'].join(','));
  for (const e of time.entries) {
    lines.push([e.id, e.taskId, taskTitle.get(e.taskId) ?? '', e.personName, e.hours, e.loggedOn, e.note, e.createdAt].map(csvCell).join(','));
  }
  lines.push('');
  lines.push(['person', 'hours', 'entries', 'last_logged_on'].join(','));
  for (const p of time.people) lines.push([p.personName, p.hours, p.entries, p.lastLoggedOn].map(csvCell).join(','));
  lines.push('');
  lines.push(['task_id', 'task', 'hours', 'entries', 'last_logged_on'].join(','));
  for (const t of time.tasks) lines.push([t.taskId, t.taskTitle, t.hours, t.entries, t.lastLoggedOn].map(csvCell).join(','));
  lines.push('');
  lines.push(['total_hours', time.totalHours].map(csvCell).join(','));

  const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  return new NextResponse(`${lines.join('\n')}\n`, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slug}-time.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
