import { NextResponse } from 'next/server';

import { auditExportFilters, logAuditExport } from '@/lib/audit/export-log';
import { readAuditPage } from '@/lib/audit/queries';
import { normaliseSearch } from '@/lib/db/search';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { routeError } from '@/lib/route-errors';

/**
 * The audit log as CSV, under the same filters as the page (owner decision 11,
 * round 2): the owner and the ops admin only (`audit.export`, re-checked in the
 * database by the logging door), and every export is itself an audit event,
 * written BEFORE the file is sent — when it cannot be written, no file is sent.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: Request) {
  const context = await requireInternal('/audit');
  if (!can(context, 'audit.export')) {
    return routeError('FORBIDDEN', 'Only the owner and the ops admin may export the audit log.');
  }

  const p = new URL(request.url).searchParams;
  // Every matching entry, page by page (bounded at 10,000 rows so one click cannot stall the server).
  const entries: Awaited<ReturnType<typeof readAuditPage>>['entries'] = [];
  let capped = false;
  for (let page = 1; page <= 50; page += 1) {
    const chunk = await readAuditPage({
      page,
      pageSize: 200,
      q: normaliseSearch(p.get('q') ?? undefined) || undefined,
      actionPrefix: p.get('action') ?? undefined,
      subjectType: p.get('subject') ?? undefined,
      actorType: p.get('actor') ?? undefined,
      from: p.get('from') ? `${p.get('from')}T00:00:00Z` : undefined,
      to: p.get('to') ? `${p.get('to')}T23:59:59.999Z` : undefined,
    });
    entries.push(...chunk.entries);
    if (page >= chunk.pageCount) break;
    if (page === 50) capped = true;
  }

  // Logged first. A failed log refuses the export: no file leaves unrecorded.
  if (!(await logAuditExport(auditExportFilters(p, capped), entries.length))) {
    return routeError('INTERNAL', 'The export could not be recorded in the audit log, so no file was produced. Try again.');
  }

  const header = ['Id', 'At', 'Action', 'Subject type', 'Subject id', 'Actor type', 'Actor id', 'Correlation', 'Before', 'After'];
  const lines = entries.map((e) =>
    [e.id, e.createdAt, e.action, e.subjectType, e.subjectId, e.actorType, e.actorId, e.correlationId, e.before ? JSON.stringify(e.before) : '', e.after ? JSON.stringify(e.after) : '']
      .map(cell)
      .join(','),
  );

  return new NextResponse([header.join(','), ...lines].join('\n') + '\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="audit-log.csv"',
      'cache-control': 'no-store',
    },
  });
}
