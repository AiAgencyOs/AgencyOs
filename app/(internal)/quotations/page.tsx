import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listClients } from '@/lib/admin/clients';
import { listProposals } from '@/modules/sales/queries';
import Link from 'next/link';

import { VersionHistoryButton, type VersionRow } from './version-drawer';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const columnsFor = (clock: AgencyClock, clientName: (id: string | null) => string | null, versionsOf: (opportunityId: string) => VersionRow[]): Column<Row>[] => [
  {
    key: 'title',
    header: 'Quotation',
    primary: true,
    cell: (p) => (
      <>
        <span className="block font-medium text-foreground">
          {p.title} <span className="text-muted">v{p.version}</span>
        </span>
        <span className="block text-xs text-muted">
          {p.leadTitle}
          {clientName(p.clientAccountId) ? ` · ${clientName(p.clientAccountId)}` : ''}
        </span>
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
    // SCR-011 — the deal's version chain. Desktop only for the same reason
    // the PDF link is: a button inside the phone card's own link.
    key: 'versions',
    header: 'History',
    align: 'right',
    desktopOnly: true,
    cell: (p) => <VersionHistoryButton dealName={p.opportunityName} leadId={p.leadId} versions={versionsOf(p.opportunity_id)} />,
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
  searchParams: Promise<{ status?: string; page?: string; sort?: string; dir?: string; q?: string; expiring?: string; client?: string }>;
}) {
  const context = await requireInternal('/quotations');
  const clock = await agencyClock();
  if (!can(context, 'lead.read')) return <PermissionDenied />;

  const { status, page: pageParam, sort: sortKey, dir, q, expiring, client: clientParam } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  // SCR-011's client filter reads the deal's account id.
  const client = UUID.test(clientParam ?? '') ? clientParam : undefined;
  const keep = [status ? `status=${status}` : '', q ? `q=${encodeURIComponent(q)}` : '', expiring ? 'expiring=1' : '', client ? `client=${client}` : ''].filter(Boolean);
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
      (!client || p.clientAccountId === client) &&
      (!needle || `${p.title} ${p.leadTitle} ${p.opportunityName}`.toLowerCase().includes(needle)) &&
      (!expiring || (p.valid_until !== null && p.valid_until >= todayKey && p.valid_until <= soonKey && (p.status === 'sent' || p.status === 'approved'))),
  );
  const quotations = sortRows(filteredRows, sortKey, direction, COMPARATORS);
  const countBy = (s: string) => all.filter((p) => p.status === s).length;
  const currency = all[0]?.currency ?? 'INR';
  const sumBy = (pred: (p: Row) => boolean) => all.filter((p) => p.currency === currency && pred(p)).reduce((n, p) => n + p.total_minor, 0);
  const expiringSoon = all.filter((p) => p.valid_until !== null && p.valid_until >= todayKey && p.valid_until <= soonKey && (p.status === 'sent' || p.status === 'approved')).length;
  const qs = (extra: string) => `/quotations?${[...keep, extra].filter(Boolean).join('&')}`;

  // Client names for the filter chips and the row's second line; read only
  // when the role may see clients, and only the accounts with a quotation.
  const clients = can(context, 'project.read') ? await listClients() : [];
  const clientName = (id: string | null) => (id ? (clients.find((c) => c.id === id)?.name ?? null) : null);
  const clientIds = [...new Set(all.map((p) => p.clientAccountId).filter((id): id is string => id !== null))];

  // SCR-011 — every version on a deal, from the unfiltered read, so the
  // drawer shows the whole chain even when the status filter hides some.
  const byDeal = new Map<string, VersionRow[]>();
  for (const p of all) {
    const list = byDeal.get(p.opportunity_id) ?? [];
    list.push({
      id: p.id,
      version: p.version,
      title: p.title,
      status: p.status,
      total: money(p.total_minor, p.currency),
      raised: clock.date(p.created_at),
      sentAt: p.sent_at ? clock.date(p.sent_at) : null,
      decidedAt: p.decided_at ? clock.date(p.decided_at) : null,
      planLabel: p.plan_label,
    });
    byDeal.set(p.opportunity_id, list);
  }
  for (const list of byDeal.values()) list.sort((a, b) => b.version - a.version);
  const versionsOf = (opportunityId: string) => byDeal.get(opportunityId) ?? [];
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
          can(context, 'proposal.draft') ? (
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
        {clientIds.length > 0 ? (
          <FilterChips
            options={[
              { key: 'any-client', label: 'Any client', href: `/quotations?${keep.filter((k) => !k.startsWith('client=')).join('&')}`, active: !client },
              ...clientIds.map((id) => ({
                key: id,
                label: clientName(id) ?? id.slice(0, 8),
                href: `/quotations?${[...keep.filter((k) => !k.startsWith('client=')), `client=${id}`].join('&')}`,
                active: client === id,
              })),
            ]}
          />
        ) : null}
        <form method="get" action="/quotations" className="flex flex-wrap items-center gap-2">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          {expiring ? <input type="hidden" name="expiring" value="1" /> : null}
          {client ? <input type="hidden" name="client" value={client} /> : null}
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
            columns={columnsFor(clock, clientName, versionsOf)}
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
          action={status ? <Link href="/quotations" className={buttonClass('secondary', 'sm')}>Clear filters</Link> : <Link href="/leads" className={buttonClass('secondary', 'sm')}>Open leads</Link>}
        />
      )}
    </div>
  );
}
