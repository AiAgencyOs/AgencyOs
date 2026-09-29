import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProposals } from '@/modules/sales/queries';
import Link from 'next/link';

import { SavedViewsBar } from '../saved-views-bar';
import {
  Badge,
  buttonClass,
  DataTable,
  IconPlus,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  FilterBar,
  FilterChips,
  humanize,
  IconInvoices,
  paginate,
  Pagination,
  PageHeader,
  statusTone,
  type Column,
  PermissionDenied,
  sortRows,
  type SortDirection,
} from '@/ui';

export const metadata: Metadata = { title: 'Quotations' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
}

const STATUS_FILTERS = ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected'];

type Row = Awaited<ReturnType<typeof listProposals>>[number];

const columnsFor = (clock: AgencyClock): Column<Row>[] => [
  {
    key: 'title',
    header: 'Quotation',
    primary: true,
    cell: (p) => (
      <>
        <span className="block font-medium text-foreground">
          {p.title} <span className="text-muted">v{p.version}</span>
        </span>
        <span className="block text-xs text-muted">{p.leadTitle}</span>
      </>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    badge: true,
    cell: (p) => <Badge tone={statusTone(p.status)}>{humanize(p.status)}</Badge>,
  },
  {
    key: 'total',
    header: 'Total',
    align: 'right',
    cellClassName: 'tabular font-medium',
    cell: (p) => money(p.total_minor, p.currency),
    sortKey: 'total',
  },
  {
    key: 'valid_until',
    header: 'Valid until',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (p) => (p.valid_until ? clock.date(p.valid_until) : '—'),
    sortKey: 'valid_until',
  },
  {
    key: 'created',
    header: 'Raised',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (p) => clock.date(p.created_at),
    sortKey: 'created',
  },
];

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
  total: (a, b) => a.total_minor - b.total_minor,
  valid_until: (a, b) => (a.valid_until ?? '').localeCompare(b.valid_until ?? ''),
  created: (a, b) => a.created_at.localeCompare(b.created_at),
};

/**
 * Every quotation across every deal — SCR-011. The per-lead quotation panel
 * (`leads/[leadId]/quotation-panel.tsx`) has always been where a version is
 * drafted and sent; this is the first place to see them all at once, which
 * the traceability sweep confirmed did not exist anywhere in the admin panel.
 *
 * No standalone quotation page exists (SCR-012 stays a per-lead panel — a
 * quote is drafted in the context of one deal, not created from nothing), so
 * every row links back to its lead rather than to a page of its own.
 */
export default async function QuotationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string; sort?: string; dir?: string }>;
}) {
  const context = await requireInternal('/quotations');
  const clock = await agencyClock();
  if (!can(context.role, 'lead.read')) return <PermissionDenied />;

  const { status, page: pageParam, sort: sortKey, dir } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const currentQuery = [status ? `status=${status}` : '', sortKey ? `sort=${sortKey}&dir=${direction}` : '']
    .filter(Boolean)
    .join('&');
  const [rawQuotations, savedViews] = await Promise.all([
    listProposals({ status }),
    listSavedViews('/quotations'),
  ]);
  const quotations = sortRows(rawQuotations, sortKey, direction, COMPARATORS);
  const { page, pageCount, rows: pageRows } = paginate(quotations, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Quotations"
        description={
          quotations.length === 0
            ? 'No quotations match this filter.'
            : `${quotations.length} quotation${quotations.length === 1 ? '' : 's'}.`
        }
        actions={
          can(context.role, 'proposal.draft') ? (
            <Link href="/quotations/new" className={buttonClass('primary', 'sm')}>
              <IconPlus size={14} />
              Create quotation
            </Link>
          ) : null
        }
      />

      <FilterBar>
        <FilterChips
          options={[
            { key: 'all', label: 'All', href: '/quotations', active: !status },
            ...STATUS_FILTERS.map((s) => ({
              key: s,
              label: humanize(s),
              href: `/quotations?status=${s}`,
              active: status === s,
            })),
          ]}
        />
      </FilterBar>

      <SavedViewsBar page="/quotations" currentQuery={currentQuery} views={savedViews} />

      {quotations.length > 0 ? (
        <>
          <DataTable
            rows={pageRows}
            columns={columnsFor(clock)}
            getKey={(p) => p.id}
            href={(p) => `/leads/${p.leadId}`}
            sort={{
              key: sortKey,
              direction,
              makeHref: (key, nextDirection) =>
                `/quotations?${status ? `status=${status}&` : ''}sort=${key}&dir=${nextDirection}`,
            }}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            makeHref={(p) =>
              `/quotations?${status ? `status=${status}&` : ''}${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`
            }
          />
        </>
      ) : (
        <EmptyState
          icon={<IconInvoices size={22} />}
          title={status ? 'No matching quotations' : 'No quotations yet'}
          description={
            status
              ? `No quotations are currently “${humanize(status)}”.`
              : 'A quotation is drafted from a lead once its opportunity is open.'
          }
        />
      )}
    </div>
  );
}
