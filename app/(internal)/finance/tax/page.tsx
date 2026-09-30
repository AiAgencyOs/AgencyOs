import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { readSettingHistory } from '@/lib/admin/settings-history';
import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
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
import { listTaxPeriodLocks, lockStateFor } from '@/modules/finance/tax-lock-queries';
import { describeStateCode, gstIdentityIssues, returnPeriodFor, selectForReturn } from '@/modules/finance/gstr';
import { listGstrInvoices, readGstIdentity } from '@/modules/finance/gstr-queries';
import { listGstExports } from '@/modules/finance/gst-export-queries';
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
  IconFile,
  IconInvoices,
  IconLock,
  IconRupee,
  IconSettings,
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

import { GstConfigurationCard } from './gst-configuration-card';
import { PeriodSelect } from './period-select';
import { LockPeriodForm, UnlockPeriodForm } from './period-lock';

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
  if (!can(context, 'invoice.read')) return <PermissionDenied />;

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

  const [allInvoices, allReceipts, allExpenses, savedViews, locks, gstIdentity, gstrRows, gstExports, settingHistory] = await Promise.all([
    listTaxReportInvoices(),
    listReceipts(),
    listExpenses(),
    listSavedViews('/finance/tax'),
    listTaxPeriodLocks(),
    readGstIdentity(),
    listGstrInvoices(),
    // SCR-056: the export history table.
    listGstExports(),
    // SCR-056: when the tax profile was last set — `organization.gst_identity_set` in the audit trail.
    readSettingHistory(),
  ]);
  const gstIdentitySetAt = settingHistory.get('gst_identity')?.[0]?.at ?? null;
  // The door's own rule (core.set_gst_identity checks is_owner): owner only.
  const mayConfigureTax = hasRole(context, 'owner');
  // E5: the GSTR files are drawn from this same window. What the file would
  // OMIT is worked out here so the screen can say it before the download.
  const returnPeriod = returnPeriodFor(period);
  const identityIssues = gstIdentityIssues(gstIdentity);
  const gstrSelection = selectForReturn(gstrRows, period);
  const gstrReady = returnPeriod !== null && identityIssues.length === 0;
  // SCR-056: the lock state of THIS window. The resolver's half-open ISO
  // instants become calendar days, the shape finance.tax_period_locks holds.
  const lockWindow = period.from && period.to ? { start: period.from.slice(0, 10), end: period.to.slice(0, 10) } : null;
  const lockState = lockWindow ? lockStateFor(locks, lockWindow.start, lockWindow.end) : null;
  const mayLock = can(context, 'invoice.issue');

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
            {/* SCR-056: "Configure tax profile" — the GST configuration section below, with the owner's form on it. */}
            <a href="#gst-configuration" className={buttonClass(mayConfigureTax ? 'primary' : 'secondary', 'sm')}>
              <IconSettings size={14} /> Configure tax profile
            </a>
            <a href={`/api/finance/tax/export${qs({ page: undefined, sort: undefined, dir: undefined, mode: undefined })}`} className={buttonClass('secondary', 'sm')}>
              <IconDownload size={14} /> Export CSV
            </a>
            {/* SCR-056: the same figures as a PDF, rendered from the same split. */}
            <a href={`/api/finance/tax/pdf${qs({ page: undefined, sort: undefined, dir: undefined, mode: undefined })}`} className={buttonClass('secondary', 'sm')}>
              <IconFile size={14} /> Export PDF
            </a>
            {gstrReady ? (
              <>
                <a href={`/api/finance/gst/gstr1${qs({ page: undefined, sort: undefined, dir: undefined, mode: undefined })}`} className={buttonClass('secondary', 'sm')}>
                  <IconFile size={14} /> GSTR-1 (JSON)
                </a>
                <a href={`/api/finance/gst/gstr3b${qs({ page: undefined, sort: undefined, dir: undefined, mode: undefined })}`} className={buttonClass('secondary', 'sm')}>
                  <IconFile size={14} /> GSTR-3B (JSON)
                </a>
              </>
            ) : null}
          </div>
        }
      />

      <SavedViewsBar page="/finance/tax" currentQuery={currentQuery} views={savedViews} />

      {/* SCR-056: GST configuration — the tax profile, on the tax page, through the Settings form and door. */}
      <GstConfigurationCard identity={gstIdentity} issues={identityIssues} mayConfigure={mayConfigureTax} effectiveSince={gstIdentitySetAt ? clock.dateTime(gstIdentitySetAt) : null} />

      {/*
        Period lock — SCR-056. A filed return is a number reported; the lock
        is the record that it was, and the finance service refuses to issue
        or void an invoice dated inside an active lock.
      */}
      <Card>
        <CardHeader
          icon={<IconLock size={16} />}
          title={lockWindow ? `Reporting period: ${period.label}` : 'Reporting period lock'}
          description={
            lockWindow
              ? `${lockWindow.start} to ${lockWindow.end} (exclusive). Lock it once the return for this window is filed.`
              : 'Pick a month, quarter or financial year above to lock it. "All time" is not a reporting period.'
          }
          actions={
            lockState?.exact ? (
              <Badge tone="danger" dot>locked</Badge>
            ) : lockState && lockState.overlapping.length > 0 ? (
              <Badge tone="warning" dot>covered by a wider lock</Badge>
            ) : lockWindow ? (
              <Badge tone="success" dot>open</Badge>
            ) : null
          }
        />
        {lockWindow && lockState ? (
          <div className="flex flex-col gap-3 px-4 py-3 sm:px-5">
            {lockState.exact ? (
              <p className="text-[13px] text-muted">
                Locked {clock.dateTime(lockState.exact.lockedAt)} by {lockState.exact.lockedByName ?? 'somebody'}
                {lockState.exact.note ? <> — “{lockState.exact.note}”</> : null}. Invoices dated in this window cannot be issued or voided.
              </p>
            ) : null}
            {lockState.overlapping.map((l) => (
              <p key={l.id} className="text-[13px] text-muted">
                Inside the lock on {l.periodStart} to {l.periodEnd}, locked {clock.dateTime(l.lockedAt)} by {l.lockedByName ?? 'somebody'}
                {l.note ? <> — “{l.note}”</> : null}.
              </p>
            ))}
            {mayLock ? (
              lockState.exact ? (
                <UnlockPeriodForm lockId={lockState.exact.id} label={period.label} />
              ) : (
                <LockPeriodForm periodStart={lockWindow.start} periodEnd={lockWindow.end} label={period.label} />
              )
            ) : (
              <p className="text-[13px] text-muted">Only an owner or ops admin can lock or unlock a period.</p>
            )}
          </div>
        ) : null}
        {locks.length > 0 ? (
          <div className="border-t border-line">
            <DataTable
              rows={locks.slice(0, 20)}
              dense
              columns={[
                { key: 'period', header: 'Period', primary: true, cellClassName: 'font-mono text-xs', cell: (l) => `${l.periodStart} → ${l.periodEnd}` },
                { key: 'state', header: 'State', badge: true, cell: (l) => (l.unlockedAt ? <Badge>unlocked</Badge> : <Badge tone="danger">locked</Badge>) },
                { key: 'locked', header: 'Locked', cellClassName: 'text-muted', cell: (l) => `${clock.date(l.lockedAt)} · ${l.lockedByName ?? '—'}` },
                { key: 'note', header: 'Note', desktopOnly: true, cellClassName: 'text-muted', cell: (l) => l.note ?? '—' },
                {
                  key: 'unlocked',
                  header: 'Unlocked',
                  desktopOnly: true,
                  cellClassName: 'text-muted',
                  cell: (l) => (l.unlockedAt ? `${clock.date(l.unlockedAt)} · ${l.unlockedByName ?? '—'}: ${l.unlockReason ?? ''}` : '—'),
                },
              ]}
              getKey={(l) => l.id}
            />
          </div>
        ) : null}
      </Card>

      {unconfirmedCount > 0 ? (
        <Callout tone="warning">
          {unconfirmedCount} invoice{unconfirmedCount === 1 ? '' : 's'} in this period belong to a project that never confirmed a billing mode. They are counted under
          “Unconfirmed”, not under GST or non-GST — confirm the mode on each project’s Billing section so the return can be filed from this screen.
        </Callout>
      ) : null}

      {/*
        GSTR-1 / GSTR-3B — bucket E5 (owner decision 2026-09-30). The two
        files are drawn from the GST register of THIS window in the shape the
        GST portal's offline tool reads. Nothing is guessed: an invoice the
        file cannot state (no place-of-supply code, a GSTIN that fails its
        checksum, a non-INR currency, no lines) is listed here and omitted
        from the file, and the agency's own identity comes from Settings.
      */}
      <Card>
        <CardHeader
          icon={<IconFile size={16} />}
          title="GST returns (offline-tool JSON)"
          description={
            returnPeriod
              ? `Return period ${returnPeriod.slice(0, 2)}/${returnPeriod.slice(2)} — ${gstrSelection.ready.length} GST invoice${gstrSelection.ready.length === 1 ? '' : 's'} in the file${gstrSelection.voided.length > 0 ? `, ${gstrSelection.voided.length} void counted as cancelled documents` : ''}${gstrSelection.excluded.nonGst > 0 ? `, ${gstrSelection.excluded.nonGst} non-GST left out` : ''}${gstrSelection.excluded.unconfirmed > 0 ? `, ${gstrSelection.excluded.unconfirmed} unconfirmed left out` : ''}. GSTR-3B states ITC and inward supplies as nil: no purchase register exists here.`
              : 'A return is for one month or one quarter. Pick either above to export GSTR-1 and GSTR-3B; a financial year, a custom range and "All time" are not return periods.'
          }
          actions={
            identityIssues.length > 0 ? (
              <Badge tone="warning" dot>identity incomplete</Badge>
            ) : gstrSelection.unresolved.length > 0 ? (
              <Badge tone="warning" dot>{gstrSelection.unresolved.length} unresolved</Badge>
            ) : returnPeriod ? (
              <Badge tone="success" dot>ready</Badge>
            ) : null
          }
        />
        {identityIssues.length > 0 ? (
          <div className="px-4 py-3 sm:px-5">
            <Callout tone="warning">
              The exports refuse until the agency’s own GST identity is complete: {identityIssues.map((i) => i.reason).join(' ')}{' '}
              <a href="#gst-configuration" className="font-medium text-brand hover:underline">Configure the tax profile above</a> (owner only).
            </Callout>
          </div>
        ) : null}
        {gstrSelection.unresolved.length > 0 ? (
          <div className="flex flex-col gap-3 px-4 py-3 sm:px-5">
            <Callout tone="warning">
              Unresolved — {gstrSelection.unresolved.length} GST invoice{gstrSelection.unresolved.length === 1 ? ' is' : 's are'} left OUT of both files because the file cannot state
              {gstrSelection.unresolved.length === 1 ? ' it' : ' them'} without guessing. Fix each where it says and export again; the agency files from{' '}
              {gstIdentity.stateCode ? describeStateCode(gstIdentity.stateCode) : 'an unset state'}.
            </Callout>
            <DataTable
              rows={gstrSelection.unresolved}
              dense
              columns={[
                { key: 'number', header: 'Invoice', primary: true, cellClassName: 'font-mono text-xs', cell: (u) => u.number },
                { key: 'reason', header: 'What is missing', cell: (u) => u.reason },
                { key: 'fix', header: 'Fix at', cellClassName: 'text-muted', cell: (u) => <Link href={u.fixHref} className="text-brand hover:underline">{u.fixLabel}</Link> },
              ]}
              getKey={(u) => u.invoiceId}
            />
          </div>
        ) : null}
      </Card>

      {/* SCR-056: export history — every GSTR file the panel produced, from finance.gst_exports. */}
      <Card>
        <CardHeader
          icon={<IconDownload size={16} />}
          title="Export history"
          description={gstExports.length === 0 ? 'No GSTR file has been exported yet.' : `${gstExports.length} export${gstExports.length === 1 ? '' : 's'}, newest first — which return period, what the file held, what it left out.`}
        />
        {gstExports.length > 0 ? (
          <DataTable
            rows={gstExports}
            dense
            columns={[
              { key: 'when', header: 'Exported', primary: true, cell: (e) => clock.dateTime(e.createdAt) },
              { key: 'kind', header: 'File', badge: true, cell: (e) => <Badge tone="brand" mono>{e.kind === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'}</Badge> },
              { key: 'period', header: 'Period', cellClassName: 'text-muted', cell: (e) => `${e.periodLabel} · ${e.returnPeriod.slice(0, 2)}/${e.returnPeriod.slice(2)}` },
              { key: 'counts', header: 'In the file', desktopOnly: true, cellClassName: 'text-muted', cell: (e) => Object.entries(e.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(' · ') || '—' },
              { key: 'omitted', header: 'Omitted', align: 'right', cell: (e) => (e.omitted.length > 0 ? <span className="text-warning" title={e.omitted.join(', ')}>{e.omitted.length}</span> : <span className="text-muted">0</span>) },
              { key: 'by', header: 'By', desktopOnly: true, cellClassName: 'text-muted', cell: (e) => e.exportedByName ?? '—' },
            ]}
            getKey={(e) => e.id}
          />
        ) : null}
      </Card>

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
