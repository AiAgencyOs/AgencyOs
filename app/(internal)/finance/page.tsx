import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPendingPaymentClaims } from '@/modules/finance/queries';
import { listBillingClients, listInvoicesFiltered } from '@/modules/finance/overview-queries';
import { listProjects } from '@/modules/projects/queries';
import {
  Card,
  CardHeader,
  FilterBar,
  IconChevronRight,
  PageHeader,
  Stat,
  StatGrid,
  StatusBadge,
  buttonClass,
  labelClass,
  selectClass,
} from '@/ui';

import { RecordClaimForm } from '../projects/[projectId]/claims-panel';

export const metadata: Metadata = { title: 'Finance' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
}

function when(clock: AgencyClock, value: string): string {
  return clock.date(value);
}

const DAY_OPTIONS = [
  { value: '', label: 'All time' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last 12 months' },
] as const;

/**
 * Finance Overview — SCR-050. Every figure is a rollup of the invoice list,
 * the same rows `/invoices` shows — nothing here can disagree with the
 * invoice list because nothing here reads anything the invoice list doesn't.
 *
 * Totals are grouped by currency rather than summed across them: a deployment
 * billing in more than one currency would otherwise show a number that is
 * not a real amount of anything.
 *
 * The three filters (period, client, project) round-trip through the URL as
 * a GET form, the way every list screen here does, and are applied by the
 * reader at the database rather than after the fact — a 500-row cap applied
 * before a client filter would silently drop that client's older invoices.
 */
export default async function FinanceOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; client?: string; project?: string }>;
}) {
  const context = await requireInternal('/finance');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) redirect('/dashboard');

  const { days: daysParam, client: clientId, project: projectId } = await searchParams;
  const days = daysParam && /^\d+$/.test(daysParam) ? Number(daysParam) : undefined;
  const filtered = Boolean(days || clientId || projectId);

  const canIssue = can(context.role, 'invoice.issue');
  const [invoices, pendingClaims, clients, projects] = await Promise.all([
    listInvoicesFiltered({ days, clientId, projectId }),
    canIssue ? listPendingPaymentClaims() : Promise.resolve([]),
    listBillingClients(),
    listProjects(500),
  ]);

  const byCurrency = new Map<string, { invoiced: number; paid: number; count: number }>();
  for (const inv of invoices) {
    if (inv.status === 'draft' || inv.status === 'void') continue;
    const row = byCurrency.get(inv.currency) ?? { invoiced: 0, paid: 0, count: 0 };
    row.invoiced += inv.total_minor;
    row.paid += inv.paid_minor;
    row.count += 1;
    byCurrency.set(inv.currency, row);
  }

  const overdue = invoices.filter((i) => i.status === 'overdue');
  const recent = invoices.slice(0, 8);
  const claimable = invoices.filter((i) => i.status !== 'draft' && i.status !== 'void' && i.status !== 'paid');

  const exportQuery = new URLSearchParams();
  if (days) exportQuery.set('days', String(days));
  if (clientId) exportQuery.set('client', clientId);
  if (projectId) exportQuery.set('project', projectId);
  const exportHref = `/api/finance/invoices/export${exportQuery.size > 0 ? `?${exportQuery.toString()}` : ''}`;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Finance"
        description={
          invoices.length === 0
            ? filtered
              ? 'No invoices match these filters.'
              : 'No invoices raised yet.'
            : `${invoices.length} invoice${invoices.length === 1 ? '' : 's'}${filtered ? ' matching the filters' : ' across this deployment'}.`
        }
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <Link href="/finance/tax" className={buttonClass('secondary', 'sm')}>
              Generate report (GST &amp; tax)
            </Link>
            <a href={exportHref} className={buttonClass('secondary', 'sm')}>
              Download CSV
            </a>
          </span>
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

      {[...byCurrency.entries()].map(([currency, totals]) => (
        <StatGrid key={currency}>
          <Stat label={`Invoiced (${currency})`} value={money(totals.invoiced, currency)} caption={`${totals.count} invoice${totals.count === 1 ? '' : 's'}`} />
          <Stat label={`Received (${currency})`} value={money(totals.paid, currency)} tone="success" />
          <Stat
            label={`Outstanding (${currency})`}
            value={money(totals.invoiced - totals.paid, currency)}
            tone={totals.invoiced - totals.paid > 0 ? 'warning' : 'neutral'}
          />
          <Stat
            label={`Collection rate (${currency})`}
            value={totals.invoiced > 0 ? `${Math.round((totals.paid / totals.invoiced) * 100)}%` : '—'}
            caption="received ÷ invoiced, drafts and voids excluded"
            tone={totals.invoiced > 0 && totals.paid >= totals.invoiced ? 'success' : 'neutral'}
          />
        </StatGrid>
      ))}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Payment verification"
            description={pendingClaims.length === 0 ? undefined : `${pendingClaims.length} awaiting a decision`}
          />
          <div className="px-4 pb-4 sm:px-5">
            <Link
              href="/invoices/verify"
              className="flex items-center gap-2 text-[13px] font-medium text-brand underline-offset-2 hover:underline"
            >
              Open the verification queue
              <IconChevronRight size={14} />
            </Link>
          </div>
        </Card>

        <Card>
          <CardHeader title="Payments" description="Every recorded payment, across every invoice" />
          <div className="px-4 pb-4 sm:px-5">
            <Link
              href="/finance/payments"
              className="flex items-center gap-2 text-[13px] font-medium text-brand underline-offset-2 hover:underline"
            >
              Open payments
              <IconChevronRight size={14} />
            </Link>
          </div>
        </Card>

        <Card>
          <CardHeader title="Expenses" description="Internal cost by project, category and vendor" />
          <div className="px-4 pb-4 sm:px-5">
            <Link
              href="/finance/expenses"
              className="flex items-center gap-2 text-[13px] font-medium text-brand underline-offset-2 hover:underline"
            >
              Open expenses
              <IconChevronRight size={14} />
            </Link>
          </div>
        </Card>

        <Card>
          <CardHeader title="GST & tax" description="Invoice register and tax collected" />
          <div className="px-4 pb-4 sm:px-5">
            <Link
              href="/finance/tax"
              className="flex items-center gap-2 text-[13px] font-medium text-brand underline-offset-2 hover:underline"
            >
              Open GST & tax
              <IconChevronRight size={14} />
            </Link>
          </div>
        </Card>

        <Card>
          <CardHeader title="Overdue" description={overdue.length === 0 ? 'Nothing overdue' : `${overdue.length} invoice${overdue.length === 1 ? '' : 's'} past due`} />
          {overdue.length > 0 ? (
            <ul className="divide-y divide-line">
              {overdue.slice(0, 6).map((i) => (
                <li key={i.id}>
                  <Link
                    href={`/invoices/${i.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-[13px] hover:bg-surface-hover sm:px-5"
                  >
                    <span className="font-mono">{i.number}</span>
                    <span className="tabular text-muted">{money(i.total_minor - i.paid_minor, i.currency)} due</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>

        {/*
          Recording what a client SAID they paid, from the overview — SCR-050.
          The same form the project page and the verification queue use: a
          claim moves no money (recordManualPayment writes the ledger), and
          the verification queue is where somebody checks it. Only invoices
          that can still take money are offered; a draft, a void or a paid
          invoice has nothing to claim against.
        */}
        {canIssue ? (
          <Card>
            <CardHeader
              title="Record a payment claim"
              description="What a client says they paid. Nothing moves until it is verified on the queue."
            />
            <div className="px-4 pb-4 sm:px-5">
              {claimable.length > 0 ? (
                <RecordClaimForm
                  projectId=""
                  invoices={claimable.map((i) => ({ id: i.id, number: i.number, status: i.status }))}
                />
              ) : (
                <p className="text-[13px] text-muted">No issued invoice is open for a claim right now.</p>
              )}
            </div>
          </Card>
        ) : null}
      </div>

      <Card>
        <CardHeader title="Recent invoices" />
        {recent.length > 0 ? (
          <ul className="divide-y divide-line">
            {recent.map((i) => (
              <li key={i.id}>
                <Link
                  href={`/invoices/${i.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-[13px] hover:bg-surface-hover sm:px-5"
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono">{i.number}</span>
                    <StatusBadge status={i.status} />
                  </span>
                  <span className="flex items-center gap-3 text-muted">
                    <span className="tabular">{money(i.total_minor, i.currency)}</span>
                    <span>{i.issued_at ? when(clock, i.issued_at) : '—'}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing to list.</p>
        )}
        <div className="px-4 pb-4 sm:px-5">
          <Link href="/invoices" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
            All invoices
          </Link>
        </div>
      </Card>
    </div>
  );
}
