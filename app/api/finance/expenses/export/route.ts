import { NextResponse } from 'next/server';

import { csvHeaders, toCsv } from '@/lib/admin/csv';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listExpenses } from '@/modules/finance/queries';

/**
 * The expense register as a file — SCR-055. The same reader the page uses,
 * so the file never says something the screen does not; RLS
 * (finance.expenses_select) bounds the rows to owner, ops_admin and the
 * finance role regardless of the app-layer gate. Amounts in major units.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const context = await requireInternal('/finance/expenses');
  if (!can(context.role, 'invoice.read')) {
    return NextResponse.json({ error: 'You do not have permission to read expenses.' }, { status: 403 });
  }

  const expenses = await listExpenses(5000);

  const body = toCsv(
    ['incurred_on', 'category', 'description', 'vendor', 'project_id', 'currency', 'amount', 'recorded_at'],
    expenses.map((e) => [
      e.incurredOn,
      e.category,
      e.description,
      e.vendor,
      e.projectId,
      e.currency,
      (e.amountMinor / 100).toFixed(2),
      e.createdAt,
    ]),
  );

  return new NextResponse(body, { status: 200, headers: csvHeaders('expenses.csv') });
}
