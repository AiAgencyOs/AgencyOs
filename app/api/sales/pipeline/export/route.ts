import { NextResponse } from 'next/server';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listOpportunities } from '@/modules/sales/queries';

/**
 * Every deal as CSV — SCR-004's "export". `lead.read` is the funnel page's
 * own gate; values in major units.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET() {
  const context = await requireInternal('/sales-funnel');
  if (!can(context.role, 'lead.read')) {
    return NextResponse.json({ error: 'You do not have permission to read deals.' }, { status: 403 });
  }

  const rows = await listOpportunities(1000);
  const header = ['Deal', 'Stage', 'Currency', 'Value', 'Expected close', 'Created', 'Lead id', 'Client account id'];
  const lines = rows.map((o) =>
    [o.name, o.stage, o.currency, (o.value_minor / 100).toFixed(2), o.expected_close_on ?? '', o.created_at.slice(0, 10), o.lead_id ?? '', o.client_account_id ?? '']
      .map(cell)
      .join(','),
  );

  return new NextResponse([header.join(','), ...lines].join('\n') + '\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="pipeline.csv"',
      'cache-control': 'no-store',
    },
  });
}
