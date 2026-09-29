import { NextResponse } from 'next/server';

import { csvHeaders, toCsv } from '@/lib/admin/csv';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listInvoicesFiltered } from '@/modules/finance/overview-queries';

/**
 * The finance overview's report, as a file — SCR-050. The same reader and
 * the same three filters the page applies, so the CSV can never say
 * something the screen does not. Gated on `invoice.read` like the page;
 * RLS bounds the rows regardless. Amounts are written in major units
 * (minor ÷ 100) because that is what a spreadsheet reader expects to sum.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const context = await requireInternal('/finance');
  if (!can(context.role, 'invoice.read')) {
    return NextResponse.json({ error: 'You do not have permission to read invoices.' }, { status: 403 });
  }

  const url = new URL(request.url);
  const daysParam = url.searchParams.get('days');
  const days = daysParam && /^\d+$/.test(daysParam) ? Number(daysParam) : undefined;
  const clientId = url.searchParams.get('client') ?? undefined;
  const projectId = url.searchParams.get('project') ?? undefined;

  const invoices = await listInvoicesFiltered({ days, clientId, projectId });

  const body = toCsv(
    ['number', 'status', 'currency', 'total', 'paid', 'outstanding', 'issued_at', 'due_at', 'project_id', 'milestone_id', 'client_account_id'],
    invoices.map((i) => [
      i.number,
      i.status,
      i.currency,
      (i.total_minor / 100).toFixed(2),
      (i.paid_minor / 100).toFixed(2),
      ((i.total_minor - i.paid_minor) / 100).toFixed(2),
      i.issued_at,
      i.due_at,
      i.project_id,
      i.milestone_id,
      i.client_account_id,
    ]),
  );

  return new NextResponse(body, { status: 200, headers: csvHeaders('invoices.csv') });
}
