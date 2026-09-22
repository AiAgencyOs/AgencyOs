import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listTaxInvoices } from '@/modules/finance/queries';
import { DataTable, EmptyState, IconInvoices, PageHeader, Stat, StatGrid, StatusBadge, type Column } from '@/ui';

export const metadata: Metadata = { title: 'GST & tax' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
}

type Row = Awaited<ReturnType<typeof listTaxInvoices>>[number];

const columnsFor = (clock: AgencyClock): Column<Row>[] => [
  { key: 'number', header: 'Number', primary: true, cellClassName: 'font-mono text-xs', cell: (i) => i.number },
  { key: 'status', header: 'Status', badge: true, cell: (i) => <StatusBadge status={i.status} /> },
  { key: 'subtotal', header: 'Subtotal', align: 'right', cellClassName: 'tabular', cell: (i) => money(i.subtotalMinor, i.currency) },
  { key: 'tax', header: 'Tax', align: 'right', cellClassName: 'tabular font-medium', cell: (i) => money(i.taxMinor, i.currency) },
  { key: 'total', header: 'Total', align: 'right', cellClassName: 'tabular', cell: (i) => money(i.totalMinor, i.currency) },
  { key: 'issued', header: 'Issued', align: 'right', cellClassName: 'text-muted', cell: (i) => (i.issuedAt ? clock.date(i.issuedAt) : '—') },
];

/**
 * GST & Tax — SCR-056's invoice register and tax summary. Reports what was
 * already recorded on each invoice (finance.invoices.tax_minor, set at
 * issue time from the project's confirmed billing mode) — this page
 * computes no tax itself, matching billing-panel.tsx's own "does not
 * compute tax" boundary. No GST filing/return generation: that needs a
 * real GST-portal integration this deployment does not have.
 */
export default async function TaxReportPage() {
  const context = await requireInternal('/finance/tax');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) redirect('/finance');

  const invoices = await listTaxInvoices();

  const byCurrency = new Map<string, { subtotal: number; tax: number; total: number; count: number }>();
  for (const i of invoices) {
    const row = byCurrency.get(i.currency) ?? { subtotal: 0, tax: 0, total: 0, count: 0 };
    row.subtotal += i.subtotalMinor;
    row.tax += i.taxMinor;
    row.total += i.totalMinor;
    row.count += 1;
    byCurrency.set(i.currency, row);
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="GST & tax"
        description={
          invoices.length === 0
            ? 'No issued invoices yet.'
            : `${invoices.length} issued invoice${invoices.length === 1 ? '' : 's'} — draft and void excluded.`
        }
      />

      {[...byCurrency.entries()].map(([currency, totals]) => (
        <StatGrid key={currency}>
          <Stat label={`Subtotal (${currency})`} value={money(totals.subtotal, currency)} />
          <Stat label={`Tax collected (${currency})`} value={money(totals.tax, currency)} />
          <Stat label={`Total (${currency})`} value={money(totals.total, currency)} />
        </StatGrid>
      ))}

      {invoices.length > 0 ? (
        <DataTable rows={invoices} columns={columnsFor(clock)} getKey={(i) => i.id} href={(i) => `/invoices/${i.id}`} />
      ) : (
        <EmptyState icon={<IconInvoices size={22} />} title="No issued invoices" description="Tax figures appear here once an invoice is issued." />
      )}
    </div>
  );
}
