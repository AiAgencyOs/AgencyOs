import { NextResponse } from 'next/server';

import { readAuditLog } from '@/lib/audit/queries';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';

/** The audit log as CSV, under the same filters and the same gate as the page. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: Request) {
  const context = await requireInternal('/audit');
  if (!can(context.role, 'audit.read')) {
    return NextResponse.json({ error: 'You do not have permission to read the audit log.' }, { status: 403 });
  }

  const p = new URL(request.url).searchParams;
  const entries = await readAuditLog({
    actionPrefix: p.get('action') ?? undefined,
    subjectType: p.get('subject') ?? undefined,
    actorType: p.get('actor') ?? undefined,
    from: p.get('from') ? `${p.get('from')}T00:00:00Z` : undefined,
    to: p.get('to') ? `${p.get('to')}T23:59:59.999Z` : undefined,
    limit: 500,
  });

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
