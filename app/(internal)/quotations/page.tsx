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
  cx,
  DataTable,
  IconAlert,
  IconCheck,
  IconClock,
  IconPlus,
  IconSend,
  inputClass,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  FilterBar,
  FilterChips,
  humanize,
  IconInvoices,
  paginate,
  Pagination,
  PageHeader,
  Stat,
  StatGrid,
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
    key: 'approval',
    header: 'Approval',
    desktopOnly: true,
    cell: (p) =>
      p.approval_request_id ? (
        <Link href={`/approvals/${p.approval_request_id}`} className="text-xs font-medium text-brand hover:underline">
          {p.status === 'pending_approval' ? 'Waiting on owner' : p.decided_at ? `Decided ${clock.date(p.decided_at)}` : 'Requested'}
        </Link>
      ) : (
        <span className="text-xs text-muted">Not requested</span>
      ),
  },
  {
    key: 'sent',
    header: 'Sent',
    desktopOnly: true,
    cellClassName: 'text-muted whitespace-nowrap',
    cell: (p) => (p.sent_at ? clock.date(p.sent_at) : '—'),
  },
  {
    key: 'created',
    header: 'Raised',
    align: 'right',
    cellClassName: 'text-muted whitespace-nowrap',
    cell: (p) => clock.date(p.created_at),
    sortKey: 'created',
  },
  {
    key: 'pdf',
    header: 'PDF',
    align: 'right',
    // A link inside a row that is itself a link on the phone card — desktop only.
    desktopOnly: true,
    cell: (p) => (
      <a href={`/api/quotations/${p.id}/pdf`} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand hover:underline">
        PDF
      </a>
    ),
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
  searchParams: Promise<{ status?: string; page?: string; sort?: string; dir?: string; q?: string; expiring?: string }>;
}) {
  const context = await requireInternal('/quotations');
  const clock = await agencyClock();
  if (!can(context.role, 'lead.read')) return <PermissionDenied />;

  const { status, page: pageParam, sort: sortKey, dir, q, expiring } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const keep = [status ? `status=${status}` : '', q ? `q=${encodeURIComponent(q)}` : '', expiring ? 'expiring=1' : ''].filter(Boolean);
  const currentQuery = [...keep, sortKey ? `sort=${sortKey}&dir=${direction}` : ''].filter(Boolean).join('&');
  const [all, rawQuotations, savedViews] = await Promise.all([
    listProposals({ limit: 200 }),
    listProposals({ status, limit: 200 }),
    listSavedViews('/quotations'),
  ]);
  const todayKey = clock.dayKey(new Date());
  const soonKey = clock.dayKey(new Date(Date.now() + 7 * 86_400_000));
  const needle = (q ?? '').trim().toLowerCase();
  const filteredRows = rawQuotations.filter(
    (p) =>
      (!needle || `${p.title} ${p.leadTitle} ${p.opportunityName}`.toLowerCase().includes(needle)) &&
      (!expiring || (p.valid_until !== null && p.valid_until >= todayKey && p.valid_until <= soonKey && (p.status === 'sent' || p.status === 'approved'))),
  );
  const quotations = sortRows(filteredRows, sortKey, direction, COMPARATORS);
  const countBy = (s: string) => all.filter((p) => p.status === s).length;
  const currency = all[0]?.currency ?? 'INR';
  const sumBy = (pred: (p: Row) => boolean) => all.filter((p) => p.currency === currency && pred(p)).reduce((n, p) => n + p.total_minor, 0);
  const expiringSoon = all.filter((p) => p.valid_until !== null && p.valid_until >= todayKey && p.valid_until <= soonKey && (p.status === 'sent' || p.status === 'approved')).length;
  const qs = (extra: string) => `/quotations?${[...keep, extra].filter(Boolean).join('&')}`;
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

      {all.length > 0 ? (
        <StatGrid cols={5}>
          <Stat label="Quotations" value={String(all.length)} caption={`${countBy('draft')} draft`} tone="brand" icon={<IconInvoices size={16} />} href="/quotations" />
          <Stat label="Awaiting approval" value={String(countBy('pending_approval'))} caption={money(sumBy((p) => p.status === 'pending_approval'), currency)} tone={countBy('pending_approval') > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} href="/quotations?status=pending_approval" />
          <Stat label="Sent to clients" value={String(countBy('sent'))} caption={money(sumBy((p) => p.status === 'sent'), currency)} tone="info" icon={<IconSend size={16} />} href="/quotations?status=sent" />
          <Stat label="Accepted" value={String(countBy('accepted'))} caption={money(sumBy((p) => p.status === 'accepted'), currency)} tone="success" icon={<IconCheck size={16} />} href="/quotations?status=accepted" />
          <Stat label="Expiring in 7 days" value={String(expiringSoon)} caption="Sent or approved, validity ending" tone={expiringSoon > 0 ? 'danger' : 'neutral'} icon={<IconAlert size={16} />} href="/quotations?expiring=1" />
        </StatGrid>
      ) : null}

      <FilterBar>
        <FilterChips
          options={[
            { key: 'all', label: 'All', href: `/quotations?${keep.filter((k) => !k.startsWith('status=')).join('&')}`, active: !status },
            ...STATUS_FILTERS.map((s) => ({
              key: s,
              label: `${humanize(s)} (${countBy(s)})`,
              href: `/quotations?${[...keep.filter((k) => !k.startsWith('status=')), `status=${s}`].join('&')}`,
              active: status === s,
            })),
          ]}
        />
        <form method="get" action="/quotations" className="flex flex-wrap items-center gap-2">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          {expiring ? <input type="hidden" name="expiring" value="1" /> : null}
          <input name="q" defaultValue={q ?? ''} placeholder="Search title, lead or deal…" aria-label="Search quotations" className={cx(inputClass, 'w-60')} />
          <button type="submit" className={buttonClass('secondary', 'sm')}>
            Search
          </button>
          {q || expiring ? (
            <Link href={status ? `/quotations?status=${status}` : '/quotations'} className="text-xs font-medium text-brand hover:underline">
              Reset
            </Link>
          ) : null}
        </form>
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
            makeHref={(p) => qs(`${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`)}
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
