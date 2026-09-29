import type { Metadata } from 'next';

import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listInvoices, listPendingPaymentClaims } from '@/modules/finance/queries';
import { SavedViewsBar } from '../saved-views-bar';
import {
  Callout,
  DataTable,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  IconAlert,
  IconInvoices,
  paginate,
  Pagination,
  PageHeader,
  StatusBadge,
  type Column,
  PermissionDenied,
  sortRows,
  type SortDirection,
} from '@/ui';

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
    sortKey: 'total',
  },
  {
    key: 'paid',
    header: 'Paid',
    align: 'right',
    cellClassName: 'tabular text-muted',
    cell: (i) => money(i.paid_minor, i.currency),
    sortKey: 'paid',
  },
  {
    key: 'issued',
    header: 'Issued',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (i) => (i.issued_at ? clock.date(i.issued_at) : '—'),
    sortKey: 'issued',
  },
  {
    key: 'due',
    header: 'Due',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (i) => (i.due_at ? clock.date(i.due_at) : '—'),
    sortKey: 'due',
  },
];

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
  total: (a, b) => a.total_minor - b.total_minor,
  paid: (a, b) => a.paid_minor - b.paid_minor,
  issued: (a, b) => (a.issued_at ?? '').localeCompare(b.issued_at ?? ''),
  due: (a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''),
};

/**
 * Invoice list.
 *
 * Same two-layer gate as the leads page: the capability is re-checked because
 * hiding the nav entry is not access control, and RLS refuses the rows
 * independently of both.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string }>;
}) {
  const context = await requireInternal('/invoices');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) return <PermissionDenied />;

  const { page: pageParam, sort: sortKey, dir } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const currentQuery = sortKey ? `sort=${sortKey}&dir=${direction}` : '';
  const [rawInvoices, pendingClaims, savedViews] = await Promise.all([
    listInvoices(),
    can(context.role, 'invoice.issue') ? listPendingPaymentClaims() : Promise.resolve([]),
    listSavedViews('/invoices'),
  ]);
  const invoices = sortRows(rawInvoices, sortKey, direction, COMPARATORS);
  const { page, pageCount, rows: pageRows } = paginate(invoices, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);

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

      <SavedViewsBar page="/invoices" currentQuery={currentQuery} views={savedViews} />

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
        <>
          <DataTable
            rows={pageRows}
            columns={columnsFor(clock)}
            getKey={(i) => i.id}
            href={(i) => `/invoices/${i.id}`}
            sort={{
              key: sortKey,
              direction,
              makeHref: (key, nextDirection) => `/invoices?sort=${key}&dir=${nextDirection}`,
            }}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            makeHref={(p) => `/invoices?${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`}
          />
        </>
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
