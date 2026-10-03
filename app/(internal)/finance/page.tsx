import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { periodDelta, sumPeriods, trendOf, type PeriodCounts } from '@/lib/admin/period-delta';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listExpenses, listPayments, listPendingPaymentClaims } from '@/modules/finance/queries';
import { listBillableMilestones, listBillingClients, listInvoicesFiltered } from '@/modules/finance/overview-queries';
import { listInvoices } from '@/modules/finance/queries';
import { milestoneInvoiceability } from '@/modules/finance/schema';
import {
  basisDisagreements,
  financeBasis,
  isLiveInvoice,
  isVerifiedPayment,
  owedOn,
  principalCurrency,
  receivedByProject,
  verifiedByMonth,
} from '@/modules/finance/verified-basis';
import { CreateFromMilestoneForm } from '../invoices/create-from-milestone-form';
import { listProjects } from '@/modules/projects/queries';

import { RecordClaimForm } from '../projects/[projectId]/claims-panel';
import {
  Avatar,
  buttonClass,
  Callout,
  Card,
  CardHeader,
  DataTable,
  DonutChart,
  EmptyState,
  humanize,
  IconAlert,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconFile,
  IconClock,
  IconInvoices,
  IconPlus,
  IconRupee,
  IconTrendUp,
  IconUsage,
  FilterBar,
  labelClass,
  PageHeader,
  PermissionDenied,
  ProgressBar,
  QuickActions,
  selectClass,
  Stat,
  StatGrid,
  StatusBadge,
  GroupedBarChart,
  ViewAll,
  type Column,
} from '@/ui';

const DAY_OPTIONS = [
  { value: '', label: 'All time' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last 12 months' },
] as const;

export const metadata: Metadata = { title: 'Finance' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

/** Invoices that are bills — everything but a draft, a pending approval, or a voided one. */
const LIVE = { has: isLiveInvoice };

/**
 * Finance Overview — SCR-050, laid out as the reference's finance screen:
 * five figures, income vs. expenses over six months, the payment-status
 * donut, top project revenue, recent invoices and payments, the expense
 * breakdown, upcoming payments and quick actions.
 *
 * Every figure is a rollup of the SAME readers `/invoices`, `/finance/payments`
 * and `/finance/expenses` use — nothing here reads anything those lists do
 * not, so it cannot disagree with them. Totals are computed for the
 * deployment's principal currency (the one with the most invoiced) and any
 * other currency is named beside the figures rather than summed into them: a
 * number added across currencies is not an amount of anything.
 */
export default async function FinanceOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; client?: string; project?: string; from?: string; to?: string }>;
}) {
  const context = await requireInternal('/finance');
  const clock = await agencyClock();
  if (!can(context, 'invoice.read')) return <PermissionDenied />;

  // The three filters round-trip through the URL as a GET form, the way every
  // list screen here does, and the invoice reader applies them at the
  // database. Payments and expenses follow the invoice set (a payment belongs
  // to an invoice; an expense to a project) so every figure below is about
  // the same slice.
  const { days: daysParam, client: clientId, project: projectId, from: fromParam, to: toParam } = await searchParams;
  const dayShape = /^\d{4}-\d{2}-\d{2}$/;
  const from = fromParam && dayShape.test(fromParam) ? fromParam : undefined;
  const to = toParam && dayShape.test(toParam) ? toParam : undefined;
  // A custom range wins over the preset: the two never apply together.
  const days = !(from || to) && daysParam && /^\d+$/.test(daysParam) ? Number(daysParam) : undefined;
  const filtered = Boolean(days || from || to || clientId || projectId);
  const canIssue = can(context, 'invoice.issue');

  // SCR-050: creating an invoice from here, through the same door the
  // Invoices page uses — a milestone the payment plan says may be billed and
  // nothing has invoiced yet.
  const canCreate = can(context, 'invoice.create');
  const [billableMilestones, everyInvoice] = await Promise.all([
    canCreate ? listBillableMilestones() : Promise.resolve([]),
    canCreate ? listInvoices(2000) : Promise.resolve([]),
  ]);
  const invoicedMilestones = new Set(everyInvoice.map((i) => i.milestone_id).filter((id): id is string => id !== null));
  const eligibleMilestones = billableMilestones
    .filter((m) => !invoicedMilestones.has(m.id))
    .filter((m) => milestoneInvoiceability({ status: m.status, amountMinor: m.amountMinor, paymentPercent: m.paymentPercent }).ok)
    .map((m) => ({ id: m.id, projectId: m.projectId, name: m.name, position: m.position, amountLabel: money(m.amountMinor, m.currency) }));

  const [invoices, allPayments, allExpenses, pendingClaims, projects, clients, recentInvoices] = await Promise.all([
    listInvoicesFiltered({ days, clientId, projectId, from, to }),
    listPayments(500),
    listExpenses(500),
    canIssue ? listPendingPaymentClaims() : Promise.resolve([]),
    can(context, 'project.read') ? listProjects(200) : Promise.resolve([]),
    listBillingClients(),
    // Two 30-day windows for the KPI chips: the client/project filter applies, the Period filter does not.
    listInvoicesFiltered({ days: 60, clientId, projectId }),
  ]);
  const invoiceIds = new Set(invoices.map((i) => i.id));
  const payments = filtered ? allPayments.filter((p) => invoiceIds.has(p.invoiceId)) : allPayments;
  const since = from ?? (days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : null);
  const expenses = allExpenses.filter(
    (e) => (!projectId || e.projectId === projectId) && (!since || e.incurredOn >= since) && (!to || e.incurredOn <= to) && (!clientId || !filtered || projectId),
  );
  const claimable = invoices.filter((i) => LIVE.has(i.status) && i.status !== 'paid');
  const exportQuery = new URLSearchParams();
  if (days) exportQuery.set('days', String(days));
  if (from) exportQuery.set('from', from);
  if (to) exportQuery.set('to', to);
  if (clientId) exportQuery.set('client', clientId);
  if (projectId) exportQuery.set('project', projectId);
  const exportHref = `/api/finance/invoices/export${exportQuery.size > 0 ? `?${exportQuery.toString()}` : ''}`;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const financialDocuments = [
    { title: 'GST & Tax Report (PDF)', note: 'The tax report for this month', href: `/api/finance/tax/pdf?period=${thisMonth}` },
    { title: 'GST & Tax Report (CSV)', note: 'The same rows, as a spreadsheet', href: `/api/finance/tax/export?period=${thisMonth}` },
    { title: 'Invoices (CSV)', note: 'Every invoice in the current filter', href: exportHref },
    { title: 'Expenses (CSV)', note: 'Every recorded expense', href: '/api/finance/expenses/export' },
  ];

  // ONE basis (verified-basis.ts): received is what a person verified, not
  // what was recorded. Every figure below — tiles, donut, top projects,
  // upcoming, the chart — is computed from it, so none can disagree.
  const currency = principalCurrency(invoices, expenses[0]?.currency ?? 'INR');
  const invoicedByCurrency = new Set(invoices.filter((i) => LIVE.has(i.status)).map((i) => i.currency));
  const otherCurrencies = [...invoicedByCurrency].filter((c) => c !== currency);

  const inCurrency = invoices.filter((i) => LIVE.has(i.status) && i.currency === currency);
  const paymentsInCurrency = payments.filter((p) => p.currency === currency && p.status !== 'refunded');
  const expensesInCurrency = expenses.filter((e) => e.currency === currency);
  const basis = financeBasis({ invoices, expenses, currency });
  const { invoicedMinor: invoiced, receivedMinor: received, outstandingMinor: outstanding, expensesMinor: spent, netMinor: net, collectionPercent: collection } = basis;
  const pendingInvoices = inCurrency.filter((i) => owedOn(i) > 0);
  const overdue = inCurrency.filter((i) => i.status === 'overdue');
  const unbacked = basisDisagreements(invoices, payments);

  // KPI chips: this 30 days against the 30 before, from issue / capture /
  // incurred dates. Outstanding is a balance, not a flow, so it has no chip.
  const chipNow = new Date();
  const recentIds = new Set(recentInvoices.map((i) => i.id));
  const invoicedFlow = sumPeriods(
    recentInvoices.filter((i) => LIVE.has(i.status) && i.currency === currency).map((i) => ({ at: i.issued_at, amount: i.total_minor })),
    chipNow,
  );
  const receivedFlow = sumPeriods(
    allPayments
      .filter((p) => p.currency === currency && isVerifiedPayment(p) && (!(clientId || projectId) || recentIds.has(p.invoiceId)))
      .map((p) => ({ at: p.verified_at, amount: p.amount_minor })),
    chipNow,
  );
  const spentFlow = sumPeriods(
    allExpenses.filter((e) => e.currency === currency && (!projectId || e.projectId === projectId)).map((e) => ({ at: `${e.incurredOn}T12:00:00Z`, amount: e.amountMinor })),
    chipNow,
  );
  const netFlow: PeriodCounts = { current: receivedFlow.current - spentFlow.current, previous: receivedFlow.previous - spentFlow.previous };

  // Six calendar months ending this month, in the agency's own zone.
  const monthKey = (iso: string) => clock.dayKey(new Date(iso)).slice(0, 7);
  const months: string[] = [];
  const now = new Date();
  for (let k = 5; k >= 0; k -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 15));
    months.push(d.toISOString().slice(0, 7));
  }
  const monthLabel = (ym: string) => new Date(`${ym}-15T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' });
  const incomeByMonth = verifiedByMonth(payments, currency, monthKey);
  const series = months.map((ym) => ({
    month: monthLabel(ym),
    income: (incomeByMonth.get(ym) ?? 0) / 100,
    expenses: expensesInCurrency.filter((e) => e.incurredOn.slice(0, 7) === ym).reduce((n, e) => n + e.amountMinor, 0) / 100,
  }));

  const paidAmount = basis.paidInvoiceMinor;
  const overdueAmount = basis.overdueMinor;
  const pendingAmount = Math.max(0, outstanding - overdueAmount);
  const statusData = [
    { label: 'Paid', value: paidAmount / 100 },
    { label: 'Pending', value: pendingAmount / 100 },
    { label: 'Overdue', value: overdueAmount / 100 },
  ].filter((d) => d.value > 0);

  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  // Top project revenue — verified money by project. Invoices with no project
  // pool under one honest "No project" row instead of vanishing, which is why
  // the old list showed ₹0 against a real Total Received.
  const revenueByProject = receivedByProject(invoices, currency);
  const topProjects = [...revenueByProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topMax = topProjects[0]?.[1] ?? 0;

  const byCategory = new Map<string, number>();
  for (const e of expensesInCurrency) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amountMinor);
  const categoryData = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label: humanize(label), value: value / 100 }));

  const todayKey = clock.dayKey(now);
  const upcoming = pendingInvoices
    .filter((i) => i.due_at && clock.dayKey(new Date(i.due_at)) >= todayKey)
    .sort((a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''))
    .slice(0, 5);

  type Inv = (typeof invoices)[number];
  const invoiceColumns: Column<Inv>[] = [
    {
      key: 'number',
      header: 'Invoice',
      primary: true,
      cell: (i) => (
        <>
          <span className="block font-mono text-xs">{i.number}</span>
          {i.project_id ? <span className="block truncate text-xs text-muted">{projectName.get(i.project_id) ?? 'Project'}</span> : null}
        </>
      ),
    },
    { key: 'amount', header: 'Amount', align: 'right', cellClassName: 'tabular', cell: (i) => money(i.total_minor, i.currency) },
    { key: 'issued', header: 'Issued', desktopOnly: true, cellClassName: 'text-muted whitespace-nowrap', cell: (i) => (i.issued_at ? clock.date(i.issued_at) : '—') },
    { key: 'due', header: 'Due', desktopOnly: true, cellClassName: 'text-muted whitespace-nowrap', cell: (i) => (i.due_at ? clock.date(i.due_at) : '—') },
    { key: 'status', header: 'Status', badge: true, cell: (i) => <StatusBadge status={i.status} dot={false} /> },
  ];

  type Pay = (typeof payments)[number];
  const paymentColumns: Column<Pay>[] = [
    {
      key: 'client',
      header: 'Client',
      primary: true,
      cell: (p) => (
        <span className="flex items-center gap-2">
          <Avatar name={p.clientName} size="sm" />
          <span className="truncate">{p.clientName}</span>
        </span>
      ),
    },
    { key: 'amount', header: 'Amount', align: 'right', cellClassName: 'tabular', cell: (p) => money(p.amount_minor, p.currency) },
    { key: 'date', header: 'Date', desktopOnly: true, cellClassName: 'text-muted whitespace-nowrap', cell: (p) => (p.captured_at ? clock.date(p.captured_at) : '—') },
    { key: 'method', header: 'Method', desktopOnly: true, cellClassName: 'text-muted', cell: (p) => humanize(p.provider) },
    { key: 'status', header: 'Status', badge: true, cell: (p) => <StatusBadge status={p.verified_at ? 'verified' : p.status} dot={false} /> },
  ];

  const rangeLabel = from || to ? `${from ?? 'Start'} - ${to ?? 'Today'}` : days ? `${clock.date(new Date(now.getTime() - days * 86_400_000))} - ${clock.date(now)}` : 'All time';

  return (
    <div className="flex flex-col gap-5">
      {/* The reference's date-range pill: the Period filter, shown as the range it resolves to. Each option is a link, so it needs no script. */}
      <div className="flex justify-end">
        <details className="group relative">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] font-medium text-foreground shadow-sm [&::-webkit-details-marker]:hidden">
            <IconCalendar size={15} />
            <span className="tabular">{rangeLabel}</span>
            <IconChevronDown size={14} />
          </summary>
          <ul className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-line bg-surface p-1 shadow-lg">
            {DAY_OPTIONS.map((o) => {
              const q = new URLSearchParams();
              if (o.value) q.set('days', o.value);
              if (clientId) q.set('client', clientId);
              if (projectId) q.set('project', projectId);
              return (
                <li key={o.value}>
                  <Link href={`/finance${q.size > 0 ? `?${q.toString()}` : ''}`} className={`block rounded-md px-3 py-1.5 text-[13px] hover:bg-surface-hover ${String(days ?? '') === o.value ? 'font-semibold text-brand' : 'text-foreground'}`}>
                    {o.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </details>
      </div>

      <PageHeader
        title="Finance Overview"
        description={
          invoices.length === 0
            ? 'No invoices raised yet. Income, expenses, payments and profitability across every project will appear here.'
            : `Income, expenses, payments and profitability across every project · figures in ${currency}${otherCurrencies.length > 0 ? ` (also invoiced in ${otherCurrencies.join(', ')}, shown on the invoice list)` : ''}.`
        }
        actions={
          <>
            <Link href="/finance/tax" className={buttonClass('secondary', 'sm')}>
              Generate report (GST &amp; tax)
            </Link>
            <a href={exportHref} className={buttonClass('secondary', 'sm')}>
              Download CSV
            </a>
            <Link href="/invoices" className={buttonClass('primary', 'sm')}>
              <IconInvoices size={14} />
              All invoices
            </Link>
          </>
        }
      />

      <form action="/finance" method="GET">
        <FilterBar>
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="finance-days">
              Period
            </label>
            <select id="finance-days" name="days" defaultValue={days ? String(days) : ''} className={`${selectClass} sm:w-44`}>
              {DAY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="finance-client">
              Client
            </label>
            <select id="finance-client" name="client" defaultValue={clientId ?? ''} className={`${selectClass} sm:w-52`}>
              <option value="">Every client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="finance-project">
              Project
            </label>
            <select id="finance-project" name="project" defaultValue={projectId ?? ''} className={`${selectClass} sm:w-52`}>
              <option value="">Every project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="finance-from">
              From
            </label>
            <input id="finance-from" type="date" name="from" defaultValue={from ?? ''} className={`${selectClass} sm:w-40`} />
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="finance-to">
              To
            </label>
            <input id="finance-to" type="date" name="to" defaultValue={to ?? ''} className={`${selectClass} sm:w-40`} />
          </div>
          <div className="flex items-end gap-2">
            <button type="submit" className={buttonClass('primary', 'sm')}>
              Apply
            </button>
            {filtered ? (
              <Link href="/finance" className={buttonClass('ghost', 'sm')}>
                Clear
              </Link>
            ) : null}
          </div>
        </FilterBar>
      </form>

      {unbacked.length > 0 ? (
        <Callout tone="warning" icon={<IconAlert size={16} />}>
          {unbacked.length} invoice{unbacked.length === 1 ? '' : 's'} carry{unbacked.length === 1 ? 's' : ''} a paid amount that no verified payment backs, so {unbacked.length === 1 ? 'it is' : 'they are'} not counted as received:{' '}
          {unbacked.slice(0, 4).map((d, k) => (
            <span key={d.invoiceId}>
              {k > 0 ? ', ' : ''}
              <Link href={`/invoices/${d.invoiceId}`} className="font-medium underline underline-offset-2">{invoices.find((i) => i.id === d.invoiceId)?.number ?? 'invoice'}</Link>
            </span>
          ))}
          {unbacked.length > 4 ? ` and ${unbacked.length - 4} more` : ''}.
        </Callout>
      ) : null}

      <StatGrid cols={5}>
        <Stat label="Total Invoiced" value={money(invoiced, currency)} caption={`${inCurrency.length} invoice${inCurrency.length === 1 ? '' : 's'}`} trend={trendOf(periodDelta(invoicedFlow))} tone="success" icon={<IconTrendUp size={16} />} href="/invoices" />
        <Stat label="Total Received" value={money(received, currency)} caption={`${collection === null ? `${paymentsInCurrency.length} payment${paymentsInCurrency.length === 1 ? '' : 's'}` : `${collection}% Collection Rate`}${basis.awaitingVerificationMinor > 0 ? ` · ${money(basis.awaitingVerificationMinor, currency)} awaiting verification` : ''}`} trend={trendOf(periodDelta(receivedFlow))} tone="info" icon={<IconCheck size={16} />} href="/finance/payments" />
        <Stat label="Outstanding" value={money(outstanding, currency)} caption={`${pendingInvoices.length} pending invoice${pendingInvoices.length === 1 ? '' : 's'}${overdue.length > 0 ? ` · ${overdue.length} overdue` : ''}`} tone={overdue.length > 0 ? 'danger' : 'warning'} icon={<IconClock size={16} />} href="/invoices" />
        <Stat label="Total Expenses" value={money(spent, currency)} caption={`${expensesInCurrency.length} recorded`} trend={trendOf(periodDelta(spentFlow), true)} tone="danger" icon={<IconRupee size={16} />} href="/finance/expenses" />
        <Stat label="Net Profit" value={money(net, currency)} caption={basis.marginPercent !== null ? `${basis.marginPercent}% margin · verified received minus expenses` : 'Verified received minus expenses'} trend={trendOf(periodDelta(netFlow))} tone={net >= 0 ? 'accent' : 'danger'} icon={<IconUsage size={16} />} />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Income vs Expenses" />
          <div className="p-4 sm:p-5">
            {series.every((s) => s.income === 0 && s.expenses === 0) ? (
              <p className="py-6 text-center text-[13px] text-muted">No payments or expenses in the last six months.</p>
            ) : (
              <GroupedBarChart data={series} xKey="month" series={[{ key: 'income', label: 'Income', color: 'var(--brand)' }, { key: 'expenses', label: 'Expenses', color: 'var(--accent)' }]} currency={currency} height={220} />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Payment Status" />
          <div className="p-4 sm:p-5">
            {statusData.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-muted">No live invoices.</p>
            ) : (
              <DonutChart data={statusData} colors={['var(--success)', 'var(--warning)', 'var(--danger)']} currency={currency} totalLabel="Total invoiced" height={150} />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Top Project Revenue" actions={<ViewAll href="/projects" />} />
          {topProjects.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-muted sm:px-5">No verified payment yet.</p>
          ) : (
            <ul className="flex flex-col gap-3 p-4 sm:p-5">
              {topProjects.map(([id, minor]) => (
                <li key={id ?? 'none'} className="flex items-center gap-3">
                  <Avatar name={id ? (projectName.get(id) ?? id) : 'No project'} size="md" square tone="sidebar" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      {id ? (
                        <Link href={`/projects/${id}`} className="truncate text-[13px] font-medium text-foreground hover:text-brand">
                          {projectName.get(id) ?? 'Project'}
                        </Link>
                      ) : (
                        <span className="truncate text-[13px] font-medium text-foreground">No project</span>
                      )}
                      <span className="tabular shrink-0 text-[13px] font-semibold">{money(minor, currency)}</span>
                    </span>
                    <ProgressBar value={topMax > 0 ? (minor / topMax) * 100 : 0} showValue={false} tone="brand" size="sm" label={`${id ? (projectName.get(id) ?? 'Project') : 'No project'} share of top revenue`} className="mt-1 w-full" />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Recent Invoices" actions={<ViewAll href="/invoices" />} />
          {invoices.length === 0 ? (
            <EmptyState icon={<IconInvoices size={20} />} title="No invoices yet" action={<Link href="/invoices" className={buttonClass('secondary', 'sm')}>Open invoices</Link>} />
          ) : (
            <div className="px-4 pb-4 sm:px-5">
              <DataTable dense rows={invoices.slice(0, 6)} columns={invoiceColumns} getKey={(i) => i.id} href={(i) => `/invoices/${i.id}`} />
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="Recent Payments" actions={<ViewAll href="/finance/payments" />} />
          {payments.length === 0 ? (
            <EmptyState icon={<IconCheck size={20} />} title="No payments recorded yet" action={<Link href="/invoices/verify" className={buttonClass('secondary', 'sm')}>Verify payments</Link>} />
          ) : (
            <div className="px-4 pb-4 sm:px-5">
              <DataTable dense rows={payments.slice(0, 6)} columns={paymentColumns} getKey={(p) => p.id} href={(p) => `/invoices/${p.invoiceId}`} />
            </div>
          )}
        </Card>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)] [&>*]:min-w-0">
        <Card>
          <CardHeader title="Expense Breakdown" actions={<ViewAll href="/finance/expenses" />} />
          <div className="p-4 sm:p-5">
            {categoryData.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-muted">No expenses recorded.</p>
            ) : (
              <DonutChart data={categoryData} currency={currency} totalLabel="Total expenses" height={150} />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Upcoming Payments" actions={<ViewAll href="/invoices" />} />
          {upcoming.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-muted sm:px-5">Nothing is due ahead.</p>
          ) : (
            <ul className="divide-y divide-line">
              {upcoming.map((i) => {
                const days = i.due_at ? Math.ceil((new Date(i.due_at).getTime() - now.getTime()) / 86_400_000) : null;
                return (
                  <li key={i.id}>
                    <Link href={`/invoices/${i.id}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-foreground">{i.project_id ? (projectName.get(i.project_id) ?? i.number) : i.number}</span>
                        <span className="block font-mono text-[11px] text-muted">{i.number}</span>
                      </span>
                      <span className="tabular shrink-0 font-medium">{money(owedOn(i), i.currency)}</span>
                      <span className="shrink-0 text-xs text-muted">{i.due_at ? clock.date(i.due_at) : ''}</span>
                      {days !== null ? <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${days <= 3 ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning'}`}>{days} day{days === 1 ? '' : 's'}</span> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <QuickActions
            actions={[
              { label: 'Create Invoice', icon: <IconPlus size={13} />, href: '/projects' },
              { label: 'Record Payment', icon: <IconCheck size={13} />, href: '/invoices/verify' },
              { label: 'Add Expense', icon: <IconRupee size={13} />, href: '/finance/expenses' },
              { label: 'Generate Report', icon: <IconUsage size={13} />, href: '/finance/tax' },
            ]}
          />
          <Card>
            <CardHeader title="Financial Documents" description="Generated when you download them, for the current month." />
            <ul className="divide-y divide-line px-4 pb-2 sm:px-5">
              {financialDocuments.map((d) => (
                <li key={d.title} className="flex items-center gap-3 py-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-danger-soft text-danger">
                    <IconFile size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-foreground">{d.title}</span>
                    <span className="block truncate text-xs text-muted">{d.note}</span>
                  </span>
                  <a href={d.href} className={buttonClass('secondary', 'sm')} aria-label={`Download ${d.title}`}>
                    <IconDownload size={13} /> Download
                  </a>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader
              title="Payment Verification"
              description={pendingClaims.length === 0 ? 'No claims are waiting.' : `${pendingClaims.length} claim${pendingClaims.length === 1 ? '' : 's'} awaiting a decision.`}
              actions={<ViewAll href="/invoices/verify" label="Open queue" />}
            />
            {overdue.length > 0 ? (
              <p className="flex items-center gap-2 px-4 pb-4 text-[13px] text-danger sm:px-5">
                <IconAlert size={14} />
                {overdue.length} invoice{overdue.length === 1 ? '' : 's'} past due · {money(overdueAmount, currency)}
              </p>
            ) : null}
          </Card>
          {/*
            Recording what a client SAID they paid, from here — SCR-050. The
            same form the project page and the verification queue use: a claim
            moves no money (recordManualPayment writes the ledger) and the queue
            is where somebody checks it. Only invoices that can still take
            money are offered.
          */}
          {canCreate ? (
            <Card>
              <CardHeader title="Create invoice" description="A draft from a milestone the payment plan says may be billed. Issuing it is a separate step on the invoice." />
              <div className="px-4 pb-4 sm:px-5">
                <CreateFromMilestoneForm projects={projects.map((p) => ({ id: p.id, name: p.name }))} milestones={eligibleMilestones} />
              </div>
            </Card>
          ) : null}
          {canIssue ? (
            <Card>
              <CardHeader title="Record a payment claim" description="What a client says they paid. Nothing moves until it is verified." />
              <div className="px-4 pb-4 sm:px-5">
                {claimable.length > 0 ? (
                  <RecordClaimForm projectId="" invoices={claimable.map((i) => ({ id: i.id, number: i.number, status: i.status }))} />
                ) : (
                  <p className="text-[13px] text-muted">No issued invoice is open for a claim right now.</p>
                )}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
