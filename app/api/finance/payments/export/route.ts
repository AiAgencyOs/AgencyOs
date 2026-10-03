import { NextResponse } from 'next/server';

import { csvHeaders, toCsv } from '@/lib/admin/csv';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { normaliseSearch } from '@/lib/db/search';
import { logReportExport } from '@/modules/finance/export-log';
import { filterPayments, paymentCsvRows, paymentFilterLabel, parsePaymentFilter, PAYMENT_CSV_HEADER } from '@/modules/finance/payment-filters';
import { listPayments } from '@/modules/finance/queries';

/**
 * The payments register as a file — SCR-053 "export". The same reader and the
 * same filters the page applies (`status`, `method`, `from`, `to`, `client`,
 * `verification`, `q`), so the CSV is exactly the rows on screen. Gated on
 * `invoice.read` like the page; RLS bounds the rows regardless.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const context = await requireInternal('/finance/payments');
  if (!can(context, 'invoice.read')) {
    return NextResponse.json({ error: 'You do not have permission to read payments.' }, { status: 403 });
  }

  const url = new URL(request.url);
  const raw = Object.fromEntries(url.searchParams.entries());
  const filter = parsePaymentFilter(raw);
  const q = normaliseSearch(raw.q);

  const rows = filterPayments(await listPayments(2000, q || undefined), filter);
  await logReportExport('payments_csv', paymentFilterLabel(filter), rows.length);

  return new NextResponse(toCsv([...PAYMENT_CSV_HEADER], paymentCsvRows(rows)), { status: 200, headers: csvHeaders('payments.csv') });
}
