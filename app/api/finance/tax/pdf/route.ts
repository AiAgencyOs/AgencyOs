import { NextResponse } from 'next/server';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { renderTaxReportPdf, taxReportPdfFilename } from '@/lib/pdf/tax-report';
import { logReportExport } from '@/modules/finance/export-log';
import { readGstIdentity } from '@/modules/finance/gstr-queries';
import { listExpenses, listPayments, listTaxReportInvoices } from '@/modules/finance/queries';
import { expensesInPeriod, invoicesInPeriod, profitAndLoss, resolveTaxPeriod, splitByMode, verifiedReceivedInPeriod } from '@/modules/finance/tax-report';

/**
 * The GST & tax report as a PDF — SCR-056 "Export PDF". Same readers, same
 * period arithmetic and the same pure split the page renders, handed to
 * `renderTaxReportPdf`, so the file is the screen. `invoice.read` is the
 * page's own gate.
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

  const supabase = await createClient();
  const [invoices, payments, expenses, identity, clock, orgRes] = await Promise.all([
    listTaxReportInvoices(),
    listPayments(2000),
    listExpenses(2000),
    readGstIdentity(),
    agencyClock(),
    supabase.schema('core').from('organizations').select('name').limit(1).maybeSingle(),
  ]);
  if (orgRes.error) {
    return NextResponse.json({ error: 'The organization could not be read.' }, { status: 500 });
  }

  const periodInvoices = invoicesInPeriod(invoices, period);
  // Received = verified payments, the same basis the screen and Finance Overview use.
  const periodReceived = verifiedReceivedInPeriod(payments, period);
  const periodExpenses = expensesInPeriod(expenses, period);

  try {
    const rendered = await renderTaxReportPdf({
      organizationName: orgRes.data?.name ?? 'AgencyOS',
      gstin: identity.gstin,
      periodLabel: period.label,
      generatedAt: clock.dateTime(new Date().toISOString()),
      splits: splitByMode(periodInvoices),
      pnl: profitAndLoss(periodInvoices, periodReceived, periodExpenses),
      register: periodInvoices.map((r) => ({
        number: r.number,
        status: r.status,
        issuedAt: r.issuedAt,
        billingMode: r.billingMode,
        gstin: r.gstin,
        currency: r.currency,
        subtotalMinor: r.subtotalMinor,
        taxMinor: r.taxMinor,
        totalMinor: r.totalMinor,
        paidMinor: r.paidMinor,
      })),
    });
    await logReportExport('tax_report_pdf', period.label, periodInvoices.length);
    return new NextResponse(Buffer.from(rendered.bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${taxReportPdfFilename(period.label)}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown render failure';
    console.error(JSON.stringify({ level: 'error', scope: 'taxReportPdf', detail }));
    return NextResponse.json({ error: 'The tax report could not be rendered.' }, { status: 500 });
  }
}
