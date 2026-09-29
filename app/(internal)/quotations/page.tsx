import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listClients } from '@/lib/admin/clients';
import { quotationReferenceCode } from '@/lib/pdf/quotation';
import { readLeadServices } from '@/modules/crm/lead-service-queries';
import { readQuotationDeliveries, type QuotationDelivery } from '@/modules/sales/delivery-status-queries';
import { listProposals } from '@/modules/sales/queries';
import { readProjectsForOpportunities } from '@/modules/sales/quotation-project-queries';
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
  selectClass,
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

// SCR-011 — superseded joins the status chips; expired is a validity
// filter (sent/approved past valid_until), not a status the row holds.
const STATUS_FILTERS = ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected', 'superseded'];

const DELIVERY_LABEL: Record<QuotationDelivery, { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' | 'warning' }> = {
  not_sent: { label: 'Not sent', tone: 'neutral' },
  pending: { label: 'Pending', tone: 'warning' },
  sent: { label: 'Sent', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  read: { label: 'Read', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  unknown: { label: 'Sent · receipt unknown', tone: 'neutral' },
};

type Row = Awaited<ReturnType<typeof listProposals>>[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const columnsFor = (clock: AgencyClock, clientName: (id: string | null) => string | null, versionsOf: (opportunityId: string) => VersionRow[], deliveryOf: (id: string) => QuotationDelivery): Column<Row>[] => [
  {
    // SCR-012 — the quotation number: the reference the PDF prints, derived
    // from the row (G-170), so the list and the document agree.
    key: 'number',
    header: 'Number',
    desktopOnly: true,
    cellClassName: 'font-mono text-xs text-muted whitespace-nowrap',
    cell: (p) => quotationReferenceCode(p.id, p.created_at),
  },
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
    // SCR-011 — delivery, derived from the outbound message that carried
    // the quotation (delivery-status-queries.ts); never a column of its own.
    key: 'delivery',
    header: 'Delivery',
    badge: true,
    cell: (p) => {
      const d = DELIVERY_LABEL[deliveryOf(p.id)];
      return <Badge tone={d.tone}>{d.label}</Badge>;
    },
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
  searchParams: Promise<{ status?: string; page?: string; sort?: string; dir?: string; q?: string; expiring?: string; expired?: string; client?: string; project?: string; service?: string }>;
}) {
  const context = await requireInternal('/quotations');
  const clock = await agencyClock();
  if (!can(context.role, 'lead.read')) return <PermissionDenied />;

  const { status, page: pageParam, sort: sortKey, dir, q, expiring, expired, client: clientParam, project: projectParam, service: serviceParam } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  // SCR-011's client filter reads the deal's account id.
  const client = UUID.test(clientParam ?? '') ? clientParam : undefined;
  // SCR-011 — project (the deal's project) and service (the lead's) filters.
  const project = UUID.test(projectParam ?? '') ? projectParam : undefined;
  const service = (serviceParam ?? '').trim().slice(0, 80);
  const keep = [status ? `status=${status}` : '', q ? `q=${encodeURIComponent(q)}` : '', expiring ? 'expiring=1' : '', expired ? 'expired=1' : '', client ? `client=${client}` : '', project ? `project=${project}` : '', service ? `service=${encodeURIComponent(service)}` : ''].filter(Boolean);
  const currentQuery = [...keep, sortKey ? `sort=${sortKey}&dir=${direction}` : ''].filter(Boolean).join('&');
  const [all, rawQuotations, savedViews] = await Promise.all([
    listProposals({ limit: 200 }),
    listProposals({ status, limit: 200 }),
    listSavedViews('/quotations'),
  ]);
  const todayKey = clock.dayKey(new Date());
  const soonKey = clock.dayKey(new Date(Date.now() + 7 * 86_400_000));
  const needle = (q ?? '').trim().toLowerCase();
  const [projectsByDeal, services, deliveries] = await Promise.all([
    readProjectsForOpportunities([...new Set(all.map((p) => p.opportunity_id))]),
    readLeadServices([...new Set(all.map((p) => p.leadId))]),
    readQuotationDeliveries(all),
  ]);
  const deliveryOf = (id: string): QuotationDelivery => deliveries.get(id) ?? 'unknown';
  const isExpired = (p: Row) => p.valid_until !== null && p.valid_until < todayKey && (p.status === 'sent' || p.status === 'approved');
  const filteredRows = rawQuotations.filter(
    (p) =>
      (!client || p.clientAccountId === client) &&
      (!project || projectsByDeal.get(p.opportunity_id)?.projectId === project) &&
      (!service || (services.byLead.get(p.leadId) ?? '').toLowerCase() === service.toLowerCase()) &&
      (!needle || `${p.title} ${p.leadTitle} ${p.opportunityName} ${quotationReferenceCode(p.id, p.created_at)}`.toLowerCase().includes(needle)) &&
      (!expiring || (p.valid_until !== null && p.valid_until >= todayKey && p.valid_until <= soonKey && (p.status === 'sent' || p.status === 'approved'))) &&
      (!expired || isExpired(p)),
  );
  const expiredCount = all.filter(isExpired).length;
  // SCR-011 — the overall total: every quotation in the list's currency,
  // and beside it the live ones (sent or approved) as the figure in play.
  const totalValue = all.filter((p) => p.currency === currency).reduce((n, p) => n + p.total_minor, 0);
  const projectOptions = [...new Map([...projectsByDeal.values()].map((p) => [p.projectId, p.projectName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const quotations = sortRows(filteredRows, sortKey, direction, COMPARATORS);
  const countBy = (s: string) => all.filter((p) => p.status === s).length;
  const currency = all[0]?.currency ?? 'INR';
  const currencyMixed = all.some((p) => p.currency !== currency);
  const sumBy = (pred: (p: Row) => boolean) => all.filter((p) => p.currency === currency && pred(p)).reduce((n, p) => n + p.total_minor, 0);
  const expiringSoon = all.filter((p) => p.valid_until !== null && p.valid_until >= todayKey && p.valid_until <= soonKey && (p.status === 'sent' || p.status === 'approved')).length;
  const qs = (extra: string) => `/quotations?${[...keep, extra].filter(Boolean).join('&')}`;

  // Client names for the filter chips and the row's second line; read only
  // when the role may see clients, and only the accounts with a quotation.
  const clients = can(context.role, 'project.read') ? await listClients() : [];
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
          can(context.role, 'proposal.draft') ? (
            <Link href="/quotations/new" className={buttonClass('primary', 'sm')}>
              <IconPlus size={14} />
              Create quotation
            </Link>
          ) : null
        }
      />

      {all.length > 0 ? (
        <StatGrid cols={6}>
          <Stat label="Quotations" value={String(all.length)} caption={`${countBy('draft')} draft · ${countBy('superseded')} superseded`} tone="brand" icon={<IconInvoices size={16} />} href="/quotations" />
          <Stat label="Total value" value={money(totalValue, currency)} caption={`${money(sumBy((p) => p.status === 'sent' || p.status === 'approved'), currency)} live (sent or approved)${currencyMixed ? ` · ${currency} only` : ''}`} tone="accent" icon={<IconInvoices size={16} />} href="/quotations" />
          <Stat label="Awaiting approval" value={String(countBy('pending_approval'))} caption={money(sumBy((p) => p.status === 'pending_approval'), currency)} tone={countBy('pending_approval') > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} href="/quotations?status=pending_approval" />
          <Stat label="Sent to clients" value={String(countBy('sent'))} caption={money(sumBy((p) => p.status === 'sent'), currency)} tone="info" icon={<IconSend size={16} />} href="/quotations?status=sent" />
          <Stat label="Accepted" value={String(countBy('accepted'))} caption={money(sumBy((p) => p.status === 'accepted'), currency)} tone="success" icon={<IconCheck size={16} />} href="/quotations?status=accepted" />
          <Stat label="Expiring in 7 days" value={String(expiringSoon)} caption={`${expiredCount} already expired`} tone={expiringSoon > 0 ? 'danger' : 'neutral'} icon={<IconAlert size={16} />} href="/quotations?expiring=1" />
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
        <FilterChips
          options={[
            { key: 'validity-any', label: 'Any validity', href: `/quotations?${keep.filter((k) => k !== 'expiring=1' && k !== 'expired=1').join('&')}`, active: !expiring && !expired },
            { key: 'expiring', label: `Expiring in 7 days (${expiringSoon})`, href: `/quotations?${[...keep.filter((k) => k !== 'expiring=1' && k !== 'expired=1'), 'expiring=1'].join('&')}`, active: Boolean(expiring) },
            { key: 'expired', label: `Expired (${expiredCount})`, href: `/quotations?${[...keep.filter((k) => k !== 'expiring=1' && k !== 'expired=1'), 'expired=1'].join('&')}`, active: Boolean(expired) },
          ]}
        />
        <form method="get" action="/quotations" className="flex flex-wrap items-center gap-2 [&_select]:w-auto">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          {expiring ? <input type="hidden" name="expiring" value="1" /> : null}
          {expired ? <input type="hidden" name="expired" value="1" /> : null}
          {client ? <input type="hidden" name="client" value={client} /> : null}
          <input name="q" defaultValue={q ?? ''} placeholder="Search title, number, lead or deal…" aria-label="Search quotations" className={cx(inputClass, 'w-60')} />
          {projectOptions.length > 0 ? (
            <select name="project" defaultValue={project ?? ''} aria-label="Project" className={cx(selectClass, 'w-auto')}>
              <option value="">Any project</option>
              {projectOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          ) : null}
          <input name="service" list="quotation-service-values" defaultValue={service} maxLength={80} placeholder="Service" aria-label="Service" className={cx(inputClass, 'w-40')} />
          <datalist id="quotation-service-values">
            {services.distinct.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <button type="submit" className={buttonClass('secondary', 'sm')}>
            Search
          </button>
          {q || expiring || expired || project || service ? (
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
            columns={columnsFor(clock, clientName, versionsOf, deliveryOf)}
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
