import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listExpenses, listReceipts, listTaxReportInvoices } from '@/modules/finance/queries';
import {
  expensesInPeriod,
  invoicesInPeriod,
  profitAndLoss,
  receiptsInPeriod,
  resolveTaxPeriod,
  splitByMode,
  taxPeriodOptions,
  type TaxTotals,
} from '@/modules/finance/tax-report';
import { SavedViewsBar } from '../../saved-views-bar';
import {
  Badge,
  buttonClass,
  Callout,
  Card,
  CardHeader,
  DataTable,
  DEFAULT_PAGE_SIZE,
  DonutChart,
  EmptyState,
  humanize,
  IconDownload,
  IconInvoices,
  IconRupee,
  IconTrendUp,
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

import { PeriodSelect } from './period-select';

export const metadata: Metadata = { title: 'GST & tax' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

type Row = Awaited<ReturnType<typeof listTaxReportInvoices>>[number];

const columnsFor = (clock: AgencyClock): Column<Row>[] => [
  { key: 'number', header: 'Number', primary: true, cellClassName: 'font-mono text-xs', cell: (i) => i.number },
  { key: 'status', header: 'Status', badge: true, cell: (i) => <StatusBadge status={i.status} /> },
  {
    key: 'mode',
    header: 'Mode',
    badge: true,
    cell: (i) =>
      i.billingMode === 'gst' ? <Badge tone="brand" mono>GST</Badge> : i.billingMode === 'non_gst' ? <Badge mono>Non-GST</Badge> : <Badge tone="warning" mono>unconfirmed</Badge>,
  },
  { key: 'gstin', header: 'GSTIN', desktopOnly: true, cellClassName: 'font-mono text-xs text-muted', cell: (i) => i.gstin ?? '—' },
  { key: 'subtotal', header: 'Taxable', align: 'right', cellClassName: 'tabular', cell: (i) => money(i.subtotalMinor, i.currency), sortKey: 'subtotal' },
  { key: 'tax', header: 'Tax', align: 'right', cellClassName: 'tabular font-medium', cell: (i) => money(i.taxMinor, i.currency), sortKey: 'tax' },
  { key: 'total', header: 'Total', align: 'right', cellClassName: 'tabular', cell: (i) => money(i.totalMinor, i.currency), sortKey: 'total' },
  { key: 'paid', header: 'Paid', align: 'right', cellClassName: 'tabular text-success', cell: (i) => money(i.paidMinor, i.currency), sortKey: 'paid' },
  { key: 'issued', header: 'Issued', align: 'right', cellClassName: 'text-muted', cell: (i) => (i.issuedAt ? clock.date(i.issuedAt) : '—'), sortKey: 'issued' },
];

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
  subtotal: (a, b) => a.subtotalMinor - b.subtotalMinor,
  tax: (a, b) => a.taxMinor - b.taxMinor,
  total: (a, b) => a.totalMinor - b.totalMinor,
  paid: (a, b) => a.paidMinor - b.paidMinor,
  issued: (a, b) => (a.issuedAt ?? '').localeCompare(b.issuedAt ?? ''),
};

function TotalsCard({ title, totals, currency, tone }: { title: string; totals: TaxTotals; currency: string; tone?: 'brand' | 'neutral' | 'warning' }) {
  return (
    <Card>
      <CardHeader title={title} actions={<Badge tone={tone ?? 'neutral'} mono>{totals.count} invoice{totals.count === 1 ? '' : 's'}</Badge>} />
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-4 py-3 text-[13px] sm:px-5">
        <dt className="text-muted">Taxable value</dt>
        <dd className="text-right font-medium tabular">{money(totals.subtotal, currency)}</dd>
        <dt className="text-muted">Tax</dt>
        <dd className="text-right font-medium tabular">{money(totals.tax, currency)}</dd>
        <dt className="text-muted">Invoice total</dt>
        <dd className="text-right font-semibold tabular">{money(totals.total, currency)}</dd>
        <dt className="text-muted">Paid</dt>
        <dd className="text-right tabular text-success">{money(totals.paid, currency)}</dd>
      </dl>
    </Card>
  );
}

/**
 * GST & Tax — SCR-056. Reports what was recorded on each invoice
 * (finance.invoices.tax_minor, set at issue time from the project's
 * confirmed billing mode) split by that mode, over a chosen period, next to
 * the receipts the database generated on verified payments and the
 * expenses recorded against the same window. Computes no tax itself and
 * generates no return: both need a GST-portal integration this deployment
 * does not have. The CSV carries exactly the rows on screen.
 */
export default async function TaxReportPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string; period?: string; mode?: string }>;
}) {
  const context = await requireInternal('/finance/tax');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) return <PermissionDenied />;

  const { page: pageParam, sort: sortKey, dir, period: periodParam, mode } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const today = new Date();
  const period = resolveTaxPeriod(periodParam, today);
  const periodValue = periodParam && periodParam.trim() ? periodParam.trim() : 'all';
  const modeFilter = mode === 'gst' || mode === 'non_gst' || mode === 'unconfirmed' ? mode : null;

  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { period: periodValue === 'all' ? undefined : periodValue, mode: modeFilter ?? undefined, sort: sortKey, dir: sortKey ? direction : undefined, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const currentQuery = qs({}).slice(1);

  const [allInvoices, allReceipts, allExpenses, savedViews] = await Promise.all([
    listTaxReportInvoices(),
    listReceipts(),
    listExpenses(),
    listSavedViews('/finance/tax'),
  ]);

  const periodInvoices = invoicesInPeriod(allInvoices, period);
  const receipts = receiptsInPeriod(allReceipts, period);
  const expenses = expensesInPeriod(allExpenses, period);
  const splits = splitByMode(periodInvoices);
  const pnl = profitAndLoss(periodInvoices, receipts, expenses);

  const filtered = modeFilter
    ? periodInvoices.filter((i) => (modeFilter === 'unconfirmed' ? i.billingMode === null : i.billingMode === modeFilter))
    : periodInvoices;
  const invoices = sortRows(filtered, sortKey, direction, COMPARATORS);
  const { page, pageCount, rows: pageRows } = paginate(invoices, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);

  const unconfirmedCount = periodInvoices.filter((i) => i.billingMode === null).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="GST & tax"
        description={`${period.label} — ${periodInvoices.length} issued invoice${periodInvoices.length === 1 ? '' : 's'}, ${receipts.length} receipt${receipts.length === 1 ? '' : 's'}, ${expenses.length} expense${expenses.length === 1 ? '' : 's'}. Draft and void excluded.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PeriodSelect value={periodValue} options={taxPeriodOptions(today)} preserve={{ mode: modeFilter ?? undefined, sort: sortKey, dir: sortKey ? direction : undefined }} />
            <a href={`/api/finance/tax/export${qs({ page: undefined, sort: undefined, dir: undefined, mode: undefined })}`} className={buttonClass('secondary', 'sm')}>
              <IconDownload size={14} /> Export CSV
            </a>
          </div>
        }
      />

      <SavedViewsBar page="/finance/tax" currentQuery={currentQuery} views={savedViews} />

      {unconfirmedCount > 0 ? (
        <Callout tone="warning">
          {unconfirmedCount} invoice{unconfirmedCount === 1 ? '' : 's'} in this period belong to a project that never confirmed a billing mode. They are counted under
          “Unconfirmed”, not under GST or non-GST — confirm the mode on each project’s Billing section so the return can be filed from this screen.
        </Callout>
      ) : null}

      {splits.length === 0 ? (
        <EmptyState icon={<IconInvoices size={22} />} title="Nothing issued in this period" description="Pick a wider period, or issue an invoice. Tax figures appear once an invoice is issued." />
      ) : (
        splits.map((split) => (
          <section key={split.currency} className="flex flex-col gap-4">
            <StatGrid>
              <Stat label={`Taxable value (${split.currency})`} value={money(split.all.subtotal, split.currency)} caption={`${split.all.count} invoices`} icon={<IconInvoices size={16} />} />
              <Stat label="Tax collected" value={money(split.all.tax, split.currency)} caption={split.all.subtotal > 0 ? `${(split.all.tax / split.all.subtotal * 100).toFixed(1)}% effective` : 'no taxable value'} tone="brand" icon={<IconRupee size={16} />} />
              <Stat label="Invoiced total" value={money(split.all.total, split.currency)} caption={`${money(split.all.paid, split.currency)} paid`} icon={<IconTrendUp size={16} />} />
              <Stat label="Receipts issued" value={String(receipts.filter((r) => r.currency === split.currency).length)} caption={money(receipts.filter((r) => r.currency === split.currency).reduce((s, r) => s + r.amountMinor, 0), split.currency)} tone="success" icon={<IconRupee size={16} />} href="/finance/payments" />
            </StatGrid>

            <div className="grid gap-4 lg:grid-cols-3">
              <TotalsCard title="GST invoices" totals={split.gst} currency={split.currency} tone="brand" />
              <TotalsCard title="Non-GST invoices" totals={split.nonGst} currency={split.currency} />
              {split.unconfirmed.count > 0 ? (
                <TotalsCard title="Unconfirmed mode" totals={split.unconfirmed} currency={split.currency} tone="warning" />
              ) : (
                <Card>
                  <CardHeader title="Tax by mode" />
                  <div className="px-4 py-3 sm:px-5">
                    <DonutChart
                      data={[
                        { label: 'GST', value: split.gst.total / 100 },
                        { label: 'Non-GST', value: split.nonGst.total / 100 },
                      ]}
                      currency={split.currency}
                      totalLabel="invoiced"
                      height={180}
                    />
                  </div>
                </Card>
              )}
            </div>
          </section>
        ))
      )}

      {pnl.length > 0 ? (
        <section className="grid gap-4 lg:grid-cols-2">
          {pnl.map((row) => (
            <Card key={row.currency}>
              <CardHeader title={`Profit & loss (${row.currency}, cash basis)`} actions={<Link href="/finance/expenses" className="text-xs text-brand hover:underline">Expenses</Link>} />
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-4 py-3 text-[13px] sm:px-5">
                <dt className="text-muted">Invoiced</dt>
                <dd className="text-right tabular">{money(row.invoiced, row.currency)}</dd>
                <dt className="text-muted">Received (receipts)</dt>
                <dd className="text-right tabular text-success">{money(row.received, row.currency)}</dd>
                <dt className="text-muted">Expenses</dt>
                <dd className="text-right tabular text-danger">− {money(row.expenses, row.currency)}</dd>
                <dt className="font-semibold text-foreground">Net</dt>
                <dd className={`text-right font-semibold tabular ${row.net < 0 ? 'text-danger' : 'text-success'}`}>{money(row.net, row.currency)}</dd>
              </dl>
              {row.expensesByCategory.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5 border-t border-line px-4 py-3 sm:px-5">
                  {row.expensesByCategory.map((c) => (
                    <li key={c.category}>
                      <Badge mono>{humanize(c.category)} · {money(c.amount, row.currency)}</Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight">Invoice register</h2>
          <div className="ml-auto flex flex-wrap gap-1">
            {[
              { value: null, label: 'All' },
              { value: 'gst', label: 'GST' },
              { value: 'non_gst', label: 'Non-GST' },
              ...(unconfirmedCount > 0 ? [{ value: 'unconfirmed', label: 'Unconfirmed' }] : []),
            ].map((chip) => (
              <Link
                key={chip.label}
                href={`/finance/tax${qs({ mode: chip.value ?? undefined, page: undefined })}`}
                className={buttonClass(modeFilter === chip.value ? 'primary' : 'secondary', 'sm')}
                aria-current={modeFilter === chip.value ? 'page' : undefined}
              >
                {chip.label}
              </Link>
            ))}
          </div>
        </div>

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
                makeHref: (key, nextDirection) => `/finance/tax${qs({ sort: key, dir: nextDirection, page: undefined })}`,
              }}
            />
            <Pagination page={page} pageCount={pageCount} makeHref={(p) => `/finance/tax${qs({ page: String(p) })}`} />
          </>
        ) : (
          <EmptyState icon={<IconInvoices size={22} />} title="No invoices match" description="Nothing issued in this period under that mode." />
        )}
      </section>

      {receipts.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold tracking-tight">Receipts <span className="text-muted">({receipts.length})</span></h2>
          <DataTable
            rows={receipts.slice(0, 50)}
            dense
            columns={[
              { key: 'number', header: 'Receipt', primary: true, cellClassName: 'font-mono text-xs', cell: (r) => r.number },
              { key: 'amount', header: 'Amount', align: 'right', cellClassName: 'tabular font-medium', cell: (r) => money(r.amountMinor, r.currency) },
              { key: 'issued', header: 'Issued', align: 'right', cellClassName: 'text-muted', cell: (r) => clock.date(r.issuedAt) },
            ]}
            getKey={(r) => r.id}
            href={(r) => `/invoices/${r.invoiceId}`}
          />
        </section>
      ) : null}
    </div>
  );
}
