import { NextResponse } from 'next/server';

import { getAuthContext } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readRequirementsOverview } from '@/modules/projects/queries';

/**
 * SCR-028 "Export scope summary" — the Requirements dashboard's table as
 * CSV: every project, the scope version it works to, and what is open
 * against it. The same reader as the dashboard (`readRequirementsOverview`),
 * so the file is the page. Behind `lead.read`, the dashboard's own gate.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET() {
  const context = await getAuthContext();
  if (!context) return NextResponse.json({ error: 'Sign in to export the scope summary.' }, { status: 401 });
  if (!can(context.role, 'lead.read')) return NextResponse.json({ error: 'You do not have permission to read requirements.' }, { status: 403 });

  const overview = await readRequirementsOverview();
  const lines = [['project_id', 'project', 'scope_version', 'scope_status', 'open_change_requests', 'open_clarifications', 'per_project_export'].join(',')];
  for (const p of overview.projects) {
    lines.push([p.projectId, p.projectName, p.scopeVersion === null ? null : `v${p.scopeVersion}`, p.scopeStatus, p.openChangeRequests, p.openClarifications, `/api/projects/${p.projectId}/scope/export`].map(cell).join(','));
  }
  lines.push(['', 'TOTAL', `${overview.frozenScopes} frozen`, null, overview.openChangeRequests, overview.openClarifications, null].map(cell).join(','));

  return new NextResponse(`${lines.join('\n')}\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="scope-summary.csv"', 'Cache-Control': 'no-store' },
  });
}
