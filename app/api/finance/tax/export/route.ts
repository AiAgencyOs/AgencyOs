import { NextResponse } from 'next/server';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { logReportExport } from '@/modules/finance/export-log';
import { listTaxReportInvoices } from '@/modules/finance/queries';
import { invoicesInPeriod, resolveTaxPeriod, taxRegisterCsv } from '@/modules/finance/tax-report';

/**
 * The GST & tax register as a CSV download — SCR-056's "export". Same
 * reader and the same period arithmetic as the page, so the file matches
 * what the person was looking at. `invoice.read` is the page's own gate.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const context = await requireInternal('/finance/tax');
  if (!can(context, 'invoice.read')) {
    return NextResponse.json({ error: 'You do not have permission to read invoices.' }, { status: 403 });
  }

  const url = new URL(request.url);
  const period = resolveTaxPeriod(url.searchParams.get('period') ?? undefined, new Date());
  const rows = invoicesInPeriod(await listTaxReportInvoices(), period);

  await logReportExport('tax_register_csv', period.label, rows.length);

  const slug = period.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return new NextResponse(taxRegisterCsv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="tax-register-${slug || 'all'}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
