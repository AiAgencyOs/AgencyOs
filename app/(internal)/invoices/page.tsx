import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listInvoices, listPendingPaymentClaims } from '@/modules/finance/queries';
import { Callout, DataTable, EmptyState, IconAlert, IconInvoices, PageHeader, StatusBadge, type Column } from '@/ui';

export const metadata: Metadata = { title: 'Invoices' };

/** Minor units → display string, in the currency the invoice was raised in. */
function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

type Row = Awaited<ReturnType<typeof listInvoices>>[number];

const columnsFor = (clock: AgencyClock): Column<Row>[] => [
  {
    key: 'number',
    header: 'Number',
    primary: true,
    cellClassName: 'font-mono text-xs',
    cell: (i) => i.number,
  },
  { key: 'status', header: 'Status', badge: true, cell: (i) => <StatusBadge status={i.status} /> },
  {
    key: 'total',
    header: 'Total',
    align: 'right',
    cellClassName: 'tabular font-medium',
    cell: (i) => money(i.total_minor, i.currency),
  },
  {
    key: 'paid',
    header: 'Paid',
    align: 'right',
    cellClassName: 'tabular text-muted',
    cell: (i) => money(i.paid_minor, i.currency),
  },
  {
    key: 'issued',
    header: 'Issued',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (i) => (i.issued_at ? clock.date(i.issued_at) : '—'),
  },
  {
    key: 'due',
    header: 'Due',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (i) => (i.due_at ? clock.date(i.due_at) : '—'),
  },
];

/**
 * Invoice list.
 *
 * Same two-layer gate as the leads page: the capability is re-checked because
 * hiding the nav entry is not access control, and RLS refuses the rows
 * independently of both.
 */
export default async function InvoicesPage() {
  const context = await requireInternal('/invoices');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) redirect('/dashboard');

  const [invoices, pendingClaims] = await Promise.all([
    listInvoices(),
    can(context.role, 'invoice.issue') ? listPendingPaymentClaims() : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Invoices"
        description={
          invoices.length === 0
            ? 'No invoices raised yet.'
            : `${invoices.length} invoice${invoices.length === 1 ? '' : 's'}.`
        }
      />

      {pendingClaims.length > 0 ? (
        <Callout tone="warning" icon={<IconAlert size={16} />}>
          <span className="flex flex-wrap items-center gap-2">
            {pendingClaims.length} payment claim{pendingClaims.length === 1 ? '' : 's'} awaiting a decision.
            <Link href="/invoices/verify" className="font-medium underline underline-offset-2">
              Open the verification queue
            </Link>
          </span>
        </Callout>
      ) : null}

      {invoices.length > 0 ? (
        <DataTable
          rows={invoices}
          columns={columnsFor(clock)}
          getKey={(i) => i.id}
          href={(i) => `/invoices/${i.id}`}
        />
      ) : (
        <EmptyState
          icon={<IconInvoices size={22} />}
          title="No invoices yet"
          description="Invoices raised against project milestones will appear here."
        />
      )}
    </div>
  );
}
