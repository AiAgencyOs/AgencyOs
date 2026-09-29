import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listTaxInvoices } from '@/modules/finance/queries';
import { SavedViewsBar } from '../../saved-views-bar';
import {
  DataTable,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  IconInvoices,
  paginate,
  Pagination,
  PageHeader,
  Stat,
  StatGrid,
  StatusBadge,
  type Column,
  PermissionDenied,
  sortRows,
  type SortDirection,
} from '@/ui';

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
  { key: 'subtotal', header: 'Subtotal', align: 'right', cellClassName: 'tabular', cell: (i) => money(i.subtotalMinor, i.currency), sortKey: 'subtotal' },
  { key: 'tax', header: 'Tax', align: 'right', cellClassName: 'tabular font-medium', cell: (i) => money(i.taxMinor, i.currency), sortKey: 'tax' },
  { key: 'total', header: 'Total', align: 'right', cellClassName: 'tabular', cell: (i) => money(i.totalMinor, i.currency), sortKey: 'total' },
  { key: 'issued', header: 'Issued', align: 'right', cellClassName: 'text-muted', cell: (i) => (i.issuedAt ? clock.date(i.issuedAt) : '—'), sortKey: 'issued' },
];

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
  subtotal: (a, b) => a.subtotalMinor - b.subtotalMinor,
  tax: (a, b) => a.taxMinor - b.taxMinor,
  total: (a, b) => a.totalMinor - b.totalMinor,
  issued: (a, b) => (a.issuedAt ?? '').localeCompare(b.issuedAt ?? ''),
};

/**
 * GST & Tax — SCR-056's invoice register and tax summary. Reports what was
 * already recorded on each invoice (finance.invoices.tax_minor, set at
 * issue time from the project's confirmed billing mode) — this page
 * computes no tax itself, matching billing-panel.tsx's own "does not
 * compute tax" boundary. No GST filing/return generation: that needs a
 * real GST-portal integration this deployment does not have.
 */
export default async function TaxReportPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string }>;
}) {
  const context = await requireInternal('/finance/tax');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) return <PermissionDenied />;

  const { page: pageParam, sort: sortKey, dir } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const currentQuery = sortKey ? `sort=${sortKey}&dir=${direction}` : '';
  const [rawInvoices, savedViews] = await Promise.all([listTaxInvoices(), listSavedViews('/finance/tax')]);
  const invoices = sortRows(rawInvoices, sortKey, direction, COMPARATORS);
  const { page, pageCount, rows: pageRows } = paginate(invoices, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);

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

      <SavedViewsBar page="/finance/tax" currentQuery={currentQuery} views={savedViews} />

      {[...byCurrency.entries()].map(([currency, totals]) => (
        <StatGrid key={currency}>
          <Stat label={`Subtotal (${currency})`} value={money(totals.subtotal, currency)} icon={<IconInvoices size={16} />} />
          <Stat label={`Tax collected (${currency})`} value={money(totals.tax, currency)} icon={<IconInvoices size={16} />} />
          <Stat label={`Total (${currency})`} value={money(totals.total, currency)} icon={<IconInvoices size={16} />} />
        </StatGrid>
      ))}

      {invoices.length > 0 ? (
        <>
          <DataTable
            rows={pageRows}
            columns={columnsFor(clock)}
            getKey={(i) => i.id}
            href={(i) => `/invoices/${i.id}`}
            sort={{
              key: sortKey,
              direction,
              makeHref: (key, nextDirection) => `/finance/tax?sort=${key}&dir=${nextDirection}`,
            }}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            makeHref={(p) => `/finance/tax?${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`}
          />
        </>
      ) : (
        <EmptyState icon={<IconInvoices size={22} />} title="No issued invoices" description="Tax figures appear here once an invoice is issued." />
      )}
    </div>
  );
}
