import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listExpenses, listPayments, listPendingPaymentClaims } from '@/modules/finance/queries';
import { listBillableMilestones, listBillingClients, listInvoicesFiltered } from '@/modules/finance/overview-queries';
import { listInvoices } from '@/modules/finance/queries';
import { milestoneInvoiceability } from '@/modules/finance/schema';
import { CreateFromMilestoneForm } from '../invoices/create-from-milestone-form';
import { listProjects } from '@/modules/projects/queries';

import { RecordClaimForm } from '../projects/[projectId]/claims-panel';
import {
  Avatar,
  buttonClass,
  Card,
  CardHeader,
  DataTable,
  DonutChart,
  EmptyState,
  humanize,
  IconAlert,
  IconCheck,
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
  TrendChart,
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
const LIVE = new Set(['issued', 'partially_paid', 'paid', 'overdue']);

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
  searchParams: Promise<{ days?: string; client?: string; project?: string }>;
}) {
  const context = await requireInternal('/finance');
  const clock = await agencyClock();
  if (!can(context, 'invoice.read')) return <PermissionDenied />;

  // The three filters round-trip through the URL as a GET form, the way every
  // list screen here does, and the invoice reader applies them at the
  // database. Payments and expenses follow the invoice set (a payment belongs
  // to an invoice; an expense to a project) so every figure below is about
  // the same slice.
  const { days: daysParam, client: clientId, project: projectId } = await searchParams;
  const days = daysParam && /^\d+$/.test(daysParam) ? Number(daysParam) : undefined;
  const filtered = Boolean(days || clientId || projectId);
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

  const [invoices, allPayments, allExpenses, pendingClaims, projects, clients] = await Promise.all([
    listInvoicesFiltered({ days, clientId, projectId }),
    listPayments(500),
    listExpenses(500),
    canIssue ? listPendingPaymentClaims() : Promise.resolve([]),
    can(context, 'project.read') ? listProjects(200) : Promise.resolve([]),
    listBillingClients(),
  ]);
  const invoiceIds = new Set(invoices.map((i) => i.id));
  const payments = filtered ? allPayments.filter((p) => invoiceIds.has(p.invoiceId)) : allPayments;
  const since = days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : null;
  const expenses = allExpenses.filter(
    (e) => (!projectId || e.projectId === projectId) && (!since || e.incurredOn >= since) && (!clientId || !filtered || projectId),
  );
  const claimable = invoices.filter((i) => LIVE.has(i.status) && i.status !== 'paid');
  const exportQuery = new URLSearchParams();
  if (days) exportQuery.set('days', String(days));
  if (clientId) exportQuery.set('client', clientId);
  if (projectId) exportQuery.set('project', projectId);
  const exportHref = `/api/finance/invoices/export${exportQuery.size > 0 ? `?${exportQuery.toString()}` : ''}`;

  const live = invoices.filter((i) => LIVE.has(i.status));
  const invoicedByCurrency = new Map<string, number>();
  for (const i of live) invoicedByCurrency.set(i.currency, (invoicedByCurrency.get(i.currency) ?? 0) + i.total_minor);
  const currency = [...invoicedByCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? expenses[0]?.currency ?? 'INR';
  const otherCurrencies = [...invoicedByCurrency.keys()].filter((c) => c !== currency);

  const inCurrency = live.filter((i) => i.currency === currency);
  const paymentsInCurrency = payments.filter((p) => p.currency === currency && p.status !== 'refunded');
  const expensesInCurrency = expenses.filter((e) => e.currency === currency);

  const invoiced = inCurrency.reduce((n, i) => n + i.total_minor, 0);
  const received = inCurrency.reduce((n, i) => n + i.paid_minor, 0);
  const outstanding = invoiced - received;
  const spent = expensesInCurrency.reduce((n, e) => n + e.amountMinor, 0);
  const net = received - spent;
  const collection = invoiced > 0 ? Math.round((received / invoiced) * 100) : null;
  const pendingInvoices = inCurrency.filter((i) => i.paid_minor < i.total_minor);
  const overdue = inCurrency.filter((i) => i.status === 'overdue');

  // Six calendar months ending this month, in the agency's own zone.
  const monthKey = (iso: string) => clock.dayKey(new Date(iso)).slice(0, 7);
  const months: string[] = [];
  const now = new Date();
  for (let k = 5; k >= 0; k -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 15));
    months.push(d.toISOString().slice(0, 7));
  }
  const monthLabel = (ym: string) => new Date(`${ym}-15T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' });
  const series = months.map((ym) => ({
    month: monthLabel(ym),
    income: paymentsInCurrency.filter((p) => p.captured_at && monthKey(p.captured_at) === ym).reduce((n, p) => n + p.amount_minor, 0) / 100,
    expenses: expensesInCurrency.filter((e) => e.incurredOn.slice(0, 7) === ym).reduce((n, e) => n + e.amountMinor, 0) / 100,
  }));

  const paidAmount = inCurrency.filter((i) => i.status === 'paid').reduce((n, i) => n + i.total_minor, 0);
  const overdueAmount = overdue.reduce((n, i) => n + i.total_minor - i.paid_minor, 0);
  const pendingAmount = Math.max(0, invoiced - paidAmount - overdueAmount);
  const statusData = [
    { label: 'Paid', value: paidAmount / 100 },
    { label: 'Pending', value: pendingAmount / 100 },
    { label: 'Overdue', value: overdueAmount / 100 },
  ].filter((d) => d.value > 0);

  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const revenueByProject = new Map<string, number>();
  for (const i of inCurrency) {
    if (!i.project_id) continue;
    revenueByProject.set(i.project_id, (revenueByProject.get(i.project_id) ?? 0) + i.paid_minor);
  }
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

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Finance overview"
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

      <StatGrid cols={6}>
        <Stat label="Total invoiced" value={money(invoiced, currency)} caption={`${inCurrency.length} invoice${inCurrency.length === 1 ? '' : 's'}`} tone="brand" icon={<IconTrendUp size={16} />} href="/invoices" />
        <Stat label="Total received" value={money(received, currency)} caption={`${paymentsInCurrency.length} payment${paymentsInCurrency.length === 1 ? '' : 's'}`} tone="success" icon={<IconCheck size={16} />} href="/finance/payments" />
        <Stat label="Collection rate" value={collection === null ? '—' : `${collection}%`} caption={collection === null ? 'Nothing invoiced yet' : 'Received ÷ invoiced, live invoices only'} tone={collection !== null && collection >= 100 ? 'success' : collection !== null && collection < 50 ? 'warning' : 'neutral'} icon={<IconTrendUp size={16} />} />
        <Stat label="Outstanding" value={money(outstanding, currency)} caption={`${pendingInvoices.length} pending invoice${pendingInvoices.length === 1 ? '' : 's'}${overdue.length > 0 ? ` · ${overdue.length} overdue` : ''}`} tone={overdue.length > 0 ? 'danger' : outstanding > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} href="/invoices" />
        <Stat label="Total expenses" value={money(spent, currency)} caption={`${expensesInCurrency.length} recorded`} tone="danger" icon={<IconRupee size={16} />} href="/finance/expenses" />
        <Stat label="Net profit" value={money(net, currency)} caption={received > 0 ? `${Math.round((net / received) * 100)}% margin` : 'Received minus expenses'} tone={net >= 0 ? 'accent' : 'danger'} icon={<IconUsage size={16} />} />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Income vs expenses" description="Payments captured and expenses incurred, by month." />
          <div className="p-4 sm:p-5">
            {series.every((s) => s.income === 0 && s.expenses === 0) ? (
              <p className="py-6 text-center text-[13px] text-muted">No payments or expenses in the last six months.</p>
            ) : (
              <TrendChart data={series} xKey="month" series={[{ key: 'income', label: 'Income' }, { key: 'expenses', label: 'Expenses', color: 'var(--danger)' }]} currency={currency} height={220} />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Payment status" />
          <div className="p-4 sm:p-5">
            {statusData.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-muted">No live invoices.</p>
            ) : (
              <DonutChart data={statusData} colors={['var(--success)', 'var(--warning)', 'var(--danger)']} currency={currency} totalLabel="Total invoiced" height={150} />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Top project revenue" actions={<ViewAll href="/projects" />} />
          {topProjects.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-muted sm:px-5">No payments against a project yet.</p>
          ) : (
            <ul className="flex flex-col gap-3 p-4 sm:p-5">
              {topProjects.map(([id, minor]) => (
                <li key={id} className="flex items-center gap-3">
                  <Avatar name={projectName.get(id) ?? id} size="md" square tone="neutral" className="bg-sidebar-bg text-sidebar-fg ring-0" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <Link href={`/projects/${id}`} className="truncate text-[13px] font-medium text-foreground hover:text-brand">
                        {projectName.get(id) ?? 'Project'}
                      </Link>
                      <span className="tabular shrink-0 text-[13px] font-semibold">{money(minor, currency)}</span>
                    </span>
                    <ProgressBar value={topMax > 0 ? (minor / topMax) * 100 : 0} showValue={false} tone="brand" size="sm" label={`${projectName.get(id) ?? 'Project'} share of top revenue`} className="mt-1 w-full" />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Recent invoices" actions={<ViewAll href="/invoices" />} />
          {invoices.length === 0 ? (
            <EmptyState icon={<IconInvoices size={20} />} title="No invoices yet" action={<Link href="/invoices" className={buttonClass('secondary', 'sm')}>Open invoices</Link>} />
          ) : (
            <div className="px-4 pb-4 sm:px-5">
              <DataTable dense rows={invoices.slice(0, 6)} columns={invoiceColumns} getKey={(i) => i.id} href={(i) => `/invoices/${i.id}`} />
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="Recent payments" actions={<ViewAll href="/finance/payments" />} />
          {payments.length === 0 ? (
            <EmptyState icon={<IconCheck size={20} />} title="No payments recorded yet" action={<Link href="/invoices/verify" className={buttonClass('secondary', 'sm')}>Verify payments</Link>} />
          ) : (
            <div className="px-4 pb-4 sm:px-5">
              <DataTable dense rows={payments.slice(0, 6)} columns={paymentColumns} getKey={(p) => p.id} href={(p) => `/invoices/${p.invoiceId}`} />
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Expense breakdown" actions={<ViewAll href="/finance/expenses" />} />
          <div className="p-4 sm:p-5">
            {categoryData.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-muted">No expenses recorded.</p>
            ) : (
              <DonutChart data={categoryData} currency={currency} totalLabel="Total expenses" height={150} />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Upcoming payments" description="Unpaid invoices with a due date still ahead." actions={<ViewAll href="/invoices" />} />
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
                      <span className="tabular shrink-0 font-medium">{money(i.total_minor - i.paid_minor, i.currency)}</span>
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
              { label: 'Raise invoice', icon: <IconPlus size={13} />, href: '/projects' },
              { label: 'Verify payment', icon: <IconCheck size={13} />, href: '/invoices/verify' },
              { label: 'Add expense', icon: <IconRupee size={13} />, href: '/finance/expenses' },
              { label: 'GST & tax', icon: <IconUsage size={13} />, href: '/finance/tax' },
            ]}
          />
          <Card>
            <CardHeader
              title="Payment verification"
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
