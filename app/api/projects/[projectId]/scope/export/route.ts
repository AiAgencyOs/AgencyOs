import { NextResponse } from 'next/server';

import { getAuthContext } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listScopeItemsForVersion, listScopeVersionHistory, readChangeRequests } from '@/modules/projects/queries';
import { readScopeApprovals } from '@/modules/projects/scope-approval-queries';

/**
 * SCR-028 "Export scope summary" — one project's scope as CSV: every
 * version, every item with its inclusion and acceptance criteria, the
 * approval evidence recorded on it, and the change requests against it.
 * Behind `project.read`; RLS decides which rows exist. 401 as JSON for a
 * signed-out request, because a link expecting a file must not be handed
 * a login page.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const context = await getAuthContext();
  if (!context) return NextResponse.json({ error: 'Sign in to export the scope.' }, { status: 401 });
  if (!can(context, 'project.read')) return NextResponse.json({ error: 'You do not have permission to read this project.' }, { status: 403 });

  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const [versions, changeRequests, approvals] = await Promise.all([listScopeVersionHistory(projectId), readChangeRequests(projectId), readScopeApprovals(projectId)]);
  const items = await Promise.all(versions.map((v) => listScopeItemsForVersion(v.id)));

  const lines = [['project', 'version', 'version_status', 'frozen_at', 'approved_by', 'approved_at', 'approval_evidence_url', 'row_kind', 'title', 'inclusion', 'detail', 'acceptance_criteria', 'change_request_status', 'classification'].join(',')];
  versions.forEach((v, i) => {
    const a = approvals[v.id];
    const head = [project.name, `v${v.version}`, v.status, v.frozenAt, a?.approvedBy ?? null, a?.approvedAt ?? null, a?.evidenceUrl ?? null];
    for (const item of items[i] ?? []) {
      lines.push([...head, 'scope_item', item.title, item.inclusion, item.detail, item.acceptanceCriteria, null, null].map(cell).join(','));
    }
    for (const cr of changeRequests.filter((c) => c.scopeVersionId === v.id)) {
      lines.push([...head, 'change_request', cr.requested, null, cr.impactNotes, null, cr.status, cr.classification].map(cell).join(','));
    }
    if ((items[i] ?? []).length === 0) lines.push([...head, 'scope_version', '(no items)', null, null, null, null, null].map(cell).join(','));
  });

  const stem = (project.code ?? project.name).replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return new NextResponse(`${lines.join('\n')}\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${stem}-scope.csv"`, 'Cache-Control': 'no-store' },
  });
}
