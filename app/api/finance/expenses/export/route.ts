import { NextResponse } from 'next/server';

import { csvHeaders, toCsv } from '@/lib/admin/csv';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { normaliseSearch } from '@/lib/db/search';
import { logReportExport } from '@/modules/finance/export-log';
import { filterExpenses } from '@/modules/finance/project-profitability';
import { listExpenses } from '@/modules/finance/queries';
import { routeError } from '@/lib/route-errors';

/**
 * The expense register as a file — SCR-055. The same reader the page uses,
 * so the file never says something the screen does not; RLS
 * (finance.expenses_select) bounds the rows to owner, ops_admin and the
 * finance role regardless of the app-layer gate. Amounts in major units.
 * The page's filters (`category`, `project`, `vendor`, `from`, `to`, `q`) apply
 * here too, and every download is logged to the export history.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const context = await requireInternal('/finance/expenses');
  if (!can(context, 'invoice.read')) {
    return routeError('FORBIDDEN', 'You do not have permission to read expenses.');
  }

  const url = new URL(request.url);
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const get = (k: string) => url.searchParams.get(k) ?? undefined;
  const filter = { category: get('category'), project: get('project'), vendor: get('vendor'), from: day.test(get('from') ?? '') ? get('from') : undefined, to: day.test(get('to') ?? '') ? get('to') : undefined };
  const q = normaliseSearch(get('q'));
  const expenses = filterExpenses(await listExpenses(5000, q || undefined), filter);

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

  const label = [filter.category, filter.project && 'one project', filter.vendor, filter.from && `from ${filter.from}`, filter.to && `to ${filter.to}`, q && `search ${q}`].filter(Boolean).join(', ') || 'All time';
  await logReportExport('expenses_csv', label, expenses.length);

  return new NextResponse(body, { status: 200, headers: csvHeaders('expenses.csv') });
}
