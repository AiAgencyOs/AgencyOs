import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listInvoices, listPendingPaymentClaims } from '@/modules/finance/queries';
import { Card, CardHeader, IconChevronRight, PageHeader, Stat, StatGrid, StatusBadge } from '@/ui';

export const metadata: Metadata = { title: 'Finance' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
}

function when(clock: AgencyClock, value: string): string {
  return clock.date(value);
}

/**
 * Finance Overview — SCR-050. Every figure is a rollup of `listInvoices()`,
 * the same reader `/invoices` uses — nothing here can disagree with the
 * invoice list because nothing here reads anything the invoice list doesn't.
 *
 * Totals are grouped by currency rather than summed across them: a deployment
 * billing in more than one currency would otherwise show a number that is
 * not a real amount of anything. `finance.expenses`/profitability (SCR-055)
 * has no schema yet — that section is out of scope until the table exists;
 * inventing one here would be exactly the fabricated-number failure the
 * brief warns against.
 */
export default async function FinanceOverviewPage() {
  const context = await requireInternal('/finance');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) redirect('/dashboard');

  const [invoices, pendingClaims] = await Promise.all([
    listInvoices(500),
    can(context.role, 'invoice.issue') ? listPendingPaymentClaims() : Promise.resolve([]),
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

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Finance"
        description={
          invoices.length === 0
            ? 'No invoices raised yet.'
            : `${invoices.length} invoice${invoices.length === 1 ? '' : 's'} across this deployment.`
        }
      />

      {[...byCurrency.entries()].map(([currency, totals]) => (
        <StatGrid key={currency}>
          <Stat label={`Invoiced (${currency})`} value={money(totals.invoiced, currency)} />
          <Stat label={`Received (${currency})`} value={money(totals.paid, currency)} tone="success" />
          <Stat
            label={`Outstanding (${currency})`}
            value={money(totals.invoiced - totals.paid, currency)}
            tone={totals.invoiced - totals.paid > 0 ? 'warning' : 'neutral'}
          />
          <Stat
            label="Collection rate"
            value={totals.invoiced > 0 ? `${Math.round((totals.paid / totals.invoiced) * 100)}%` : '—'}
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
      </div>

      <Card>
        <CardHeader title="Recent invoices" />
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
        <div className="px-4 pb-4 sm:px-5">
          <Link href="/invoices" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
            All invoices
          </Link>
        </div>
      </Card>
    </div>
  );
}
