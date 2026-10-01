import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listClientProjectStatusCounts } from '@/lib/admin/client-projects';
import { CLIENT_LIFECYCLE_LABEL, clientLifecycle, type ClientLifecycle } from '@/lib/admin/client-lifecycle';
import { getClientsOverview, listClientProjectsBrief } from '@/lib/admin/clients-overview';
import { countPeriods, periodDelta, trendOf } from '@/lib/admin/period-delta';
import { listClients } from '@/lib/admin/clients';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { SavedViewsBar } from '../saved-views-bar';
import { CreateLeadButton } from '../leads/create-lead-button';
import { ClientEditButton } from './client-edit-form';
import { duplicateCounts } from '@/lib/admin/duplicate-clients';
import { ClientBulkBar, CLIENT_BULK_FORM } from './bulk-bar';
import { ClientPreviewButton } from './preview-drawer';
import { listInternalRoster } from '@/modules/projects/queries';
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  buttonClass,
  StatusBadge,
  ViewAll,
  cx,
  DataTable,
  DetailPanel,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  FilterBar,
  FilterChips,
  IconCheck,
  IconClock,
  IconDownload,
  IconImport,
  inputClass,
  IconRupee,
  IconUser,
  IconUsers,
  paginate,
  Pagination,
  PageHeader,
  Stat,
  StatGrid,
  type Column,
  PermissionDenied,
  sortRows,
  type SortDirection,
} from '@/ui';

export const metadata: Metadata = { title: 'Client Management' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

type Row = Awaited<ReturnType<typeof listClients>>[number];

const LIFECYCLE_TONE: Record<ClientLifecycle, 'success' | 'warning' | 'info' | 'danger'> = { active: 'success', pending: 'warning', completed: 'info', on_hold: 'danger' };

const columnsFor = (clock: AgencyClock, indexOf: (id: string) => number, phoneOf: (id: string) => string | undefined, selectable: boolean, dupOf: (id: string) => number, chipOf: (c: Row) => ReactNode): Column<Row>[] => [
  ...(selectable
    ? ([{ key: 'select', header: '', width: 'w-8', cell: (c: Row) => <input type="checkbox" name="id" value={c.id} form={CLIENT_BULK_FORM} aria-label={`Select ${c.name}`} /> }] as Column<Row>[])
    : []),
  { key: 'n', header: '#', desktopOnly: true, cellClassName: 'tabular text-muted', cell: (c) => indexOf(c.id) },
  {
    key: 'name',
    header: 'Client Name',
    primary: true,
    cell: (c) => (
      <span className="flex items-center gap-2.5">
        <Avatar name={c.name} size="md" />
        <span className="min-w-0">
          <span className="block max-w-[9rem] truncate">{c.name}</span>
          {dupOf(c.id) > 0 ? <Badge tone="warning" dot={false}>Possible duplicate ×{dupOf(c.id) + 1}</Badge> : null}
        </span>
      </span>
    ),
  },
  { key: 'email', header: 'Email / Phone', desktopOnly: true, cellClassName: 'text-xs text-muted', cell: (c) => (
      <span className="block max-w-[9rem]">
        <span className="block truncate">{c.billingEmail ?? '—'}</span>
        {phoneOf(c.id) ? <span className="block truncate font-mono text-[11px]">{phoneOf(c.id)}</span> : null}
      </span>
    ),
  },
  {
    key: 'projects',
    header: 'Projects',
    desktopOnly: true,
    cellClassName: 'text-muted whitespace-nowrap',
    cell: (c) => (c.projectsTotal === 0 ? 'None yet' : `${c.projectsActive} active · ${c.projectsTotal} total`),
  },
  // SCR-014 — revenue is what was PAID; invoiced is the claim beside it.
  { key: 'invoiced', header: 'Total Value', align: 'right', cellClassName: 'tabular font-medium', cell: (c) => money(c.invoicedMinor, c.currency), sortKey: 'invoiced' },
  {
    key: 'status',
    header: 'Status',
    badge: true,
    cell: (c) => chipOf(c),
  },
  { key: 'created', header: 'Joined Date', cellClassName: 'text-muted whitespace-nowrap', cell: (c) => clock.date(c.createdAt), sortKey: 'created' },
];

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
  paid: (a, b) => a.paidMinor - b.paidMinor,
  invoiced: (a, b) => a.invoicedMinor - b.invoicedMinor,
  outstanding: (a, b) => a.outstandingMinor - b.outstandingMinor,
  created: (a, b) => a.createdAt.localeCompare(b.createdAt),
};

/**
 * Client management — the master list (SCR-014), laid out as the reference:
 * five figures, status chips, and the table with avatars, contact, projects,
 * value and status. Totals come from the owning modules' tables (see
 * lib/admin/clients.ts), never restated.
 *
 * Same two-layer gate as the other internal pages: the capability is
 * re-checked here because hiding the nav entry is not access control, and RLS
 * refuses the rows independently of both. Gated on project.read rather than a
 * new capability — every role that may see a project may see who it is for.
 */
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string; status?: string; q?: string; tag?: string; owner?: string; client?: string }>;
}) {
  const context = await requireInternal('/clients');
  const clock = await agencyClock();
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const { page: pageParam, sort: sortKey, dir, status, q: qRaw, tag: tagRaw, owner: ownerRaw, client: clientParam } = await searchParams;
  const q = (qRaw ?? '').trim();
  const tag = (tagRaw ?? '').trim().toLowerCase();
  const owner = (ownerRaw ?? '').trim();
  const needle = q.toLowerCase();
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const facet = [tag ? `tag=${encodeURIComponent(tag)}` : '', owner ? `owner=${encodeURIComponent(owner)}` : ''].filter(Boolean);
  const currentQuery = [status ? `status=${status}` : '', q ? `q=${encodeURIComponent(q)}` : '', ...facet, sortKey ? `sort=${sortKey}&dir=${direction}` : ''].filter(Boolean).join('&');
  const [allClients, savedViews] = await Promise.all([listClients(), listSavedViews('/clients')]);
  // SCR-014 — completed and pending, counted from the projects table.
  const projectCounts = await listClientProjectStatusCounts(allClients.map((c) => c.id));
  const mayEditClients = can(context, 'project.write');

  // Q-CHIPS: one lifecycle chip per client, derived from its projects.
  const lifecycleOf = (c: Row) => clientLifecycle(projectCounts.get(c.id)?.byStatus);
  const chipOf = (c: Row): ReactNode => {
    if (c.status !== 'active') return <Badge tone="neutral" dot>Archived</Badge>;
    const life = lifecycleOf(c);
    return life ? <Badge tone={LIFECYCLE_TONE[life]} dot>{CLIENT_LIFECYCLE_LABEL[life]}</Badge> : <Badge tone="neutral" dot={false}>{(projectCounts.get(c.id)?.total ?? 0) === 0 ? 'No projects' : 'Mixed'}</Badge>;
  };
  const active = allClients.filter((c) => lifecycleOf(c) === 'active');
  const archived = allClients.filter((c) => c.status !== 'active');
  const owing = allClients.filter((c) => c.outstandingMinor > 0);
  const currency = allClients[0]?.currency ?? 'INR';
  const sameCurrency = allClients.every((c) => c.currency === currency);
  const totalInvoiced = allClients.filter((c) => c.currency === currency).reduce((n, c) => n + c.invoicedMinor, 0);
  const totalPaid = allClients.filter((c) => c.currency === currency).reduce((n, c) => n + c.paidMinor, 0);
  const completed = allClients.filter((c) => lifecycleOf(c) === 'completed');
  const pendingClients = allClients.filter((c) => lifecycleOf(c) === 'pending');
  const onHoldClients = allClients.filter((c) => lifecycleOf(c) === 'on_hold');

  const byStatus =
    status === 'active' ? active : status === 'archived' ? archived : status === 'owing' ? owing : status === 'working' ? active : status === 'completed' ? completed : status === 'pending' ? pendingClients : status === 'on_hold' ? onHoldClients : allClients;
  const bySearch = needle ? byStatus.filter((c) => c.name.toLowerCase().includes(needle) || (c.billingEmail ?? '').toLowerCase().includes(needle)) : byStatus;
  // SCR-014 — `?tag=` and `?owner=` (owner is a user id; `none` means unowned).
  const filtered = bySearch.filter((c) => (!tag || c.tags.includes(tag)) && (!owner || (owner === 'none' ? c.ownerId === null : c.ownerId === owner)));
  const clients = sortRows(filtered, sortKey, direction, COMPARATORS);
  const { page, pageCount, rows: pageRows } = paginate(clients, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);
  const selected = pageRows.find((c) => c.id === clientParam) ?? pageRows[0] ?? null;
  // The three panels under the table describe the client in the Details rail,
  // not the whole portfolio.
  const overview = await getClientsOverview({ leads: can(context, 'lead.read'), invoices: can(context, 'invoice.read'), scopeClientId: selected?.id ?? null });
  const selectedProjects = selected ? await listClientProjectsBrief(selected.id) : [];
  const clientName = new Map(allClients.map((c) => [c.id, c.name]));
  const dupCount = duplicateCounts(allClients);
  const bulkRoster = mayEditClients ? (await listInternalRoster()).map((m) => ({ userId: m.userId, fullName: m.fullName || m.email })) : [];
  const chipNow = new Date();
  const joined = countPeriods(allClients.map((c) => c.createdAt), chipNow);
  const activeJoined = countPeriods(active.map((c) => c.createdAt), chipNow);
  const completedJoined = countPeriods(completed.map((c) => c.createdAt), chipNow);
  const pendingJoined = countPeriods(pendingClients.map((c) => c.createdAt), chipNow);
  const keep = [status ? `status=${status}` : '', q ? `q=${encodeURIComponent(q)}` : '', ...facet].filter(Boolean);
  const qs = (extra: string) => `/clients?${keep.length ? `${keep.join('&')}&` : ''}${extra}`;
  const chip = (s: string | null) => `/clients?${[s ? `status=${s}` : '', q ? `q=${encodeURIComponent(q)}` : '', ...facet].filter(Boolean).join('&')}`;
  const facetHref = (over: { tag?: string; owner?: string }) => {
    const next = { tag, owner, ...over };
    return `/clients?${[status ? `status=${status}` : '', q ? `q=${encodeURIComponent(q)}` : '', next.tag ? `tag=${encodeURIComponent(next.tag)}` : '', next.owner ? `owner=${encodeURIComponent(next.owner)}` : ''].filter(Boolean).join('&')}`;
  };
  const allTags = [...new Set(allClients.flatMap((c) => c.tags))].sort();
  const owners = [...new Map(allClients.filter((c) => c.ownerId).map((c) => [c.ownerId!, c.ownerName ?? 'Unnamed'])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const exportQuery = [q ? `q=${encodeURIComponent(q)}` : '', ...facet].filter(Boolean).join('&');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Client Management"
        description="Manage your clients, track projects, communication and business growth."
        actions={
          <>
            <a href={`/api/clients/export${exportQuery ? `?${exportQuery}` : ''}`} className={buttonClass('secondary', 'sm')}>
              <IconDownload size={14} />
              Export
            </a>
            {can(context, 'organization.settings') ? (
              <Link href="/import" className={buttonClass('secondary', 'sm')}>
                <IconImport size={14} />
                Import Clients
              </Link>
            ) : null}
            {can(context, 'project.write') ? <CreateLeadButton mode="client" label="Add Client" /> : null}
          </>
        }
      />

      {allClients.length > 0 ? (
        <StatGrid cols={5}>
          <Stat label="Total Clients" value={String(allClients.length)} caption={`${archived.length} archived · ${owing.length} owing`} trend={trendOf(periodDelta(joined))} tone="brand" icon={<IconUsers size={16} />} href="/clients" />
          <Stat label="Active Clients" value={String(active.length)} caption="At least one running project" trend={trendOf(periodDelta(activeJoined))} tone="success" icon={<IconUser size={16} />} href="/clients?status=active" />
          {/* SCR-014 — completed and pending are counts of PROJECTS by client, from the projects table. */}
          <Stat label="Completed Clients" value={String(completed.length)} caption="Every project complete" trend={trendOf(periodDelta(completedJoined))} tone="info" icon={<IconCheck size={16} />} href="/clients?status=completed" />
          <Stat label="Pending Clients" value={String(pendingClients.length)} caption="Only unstarted or signed projects" trend={trendOf(periodDelta(pendingJoined))} tone={pendingClients.length > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} href="/clients?status=pending" />
          <Stat
            label="Total Revenue"
            value={money(totalPaid, currency)}
            caption={`Paid · ${money(totalInvoiced, currency)} invoiced${sameCurrency ? '' : ` · ${currency} only`}`}
            tone="accent"
            icon={<IconRupee size={16} />}
            href="/finance"
          />
        </StatGrid>
      ) : null}

      {allClients.length > 0 ? (
        <FilterBar clearHref="/clients" filtered={Boolean(status || q || tag || owner)}>
          <FilterChips
            options={[
              { key: 'all', label: `All Clients (${allClients.length})`, href: chip(null), active: !status },
              { key: 'active', label: `Active (${active.length})`, href: chip('active'), active: status === 'active' },
              { key: 'pending', label: `Pending (${pendingClients.length})`, href: chip('pending'), active: status === 'pending' },
              { key: 'on_hold', label: `On hold (${onHoldClients.length})`, href: chip('on_hold'), active: status === 'on_hold' },
              { key: 'completed', label: `Completed (${completed.length})`, href: chip('completed'), active: status === 'completed' },
              { key: 'owing', label: `Owing (${owing.length})`, href: chip('owing'), active: status === 'owing' },
              { key: 'archived', label: `Archived (${archived.length})`, href: chip('archived'), active: status === 'archived' },
            ]}
          />
          <form method="get" action="/clients" className="ml-auto flex flex-wrap items-center gap-2">
            {status ? <input type="hidden" name="status" value={status} /> : null}
            {tag ? <input type="hidden" name="tag" value={tag} /> : null}
            {owner ? <input type="hidden" name="owner" value={owner} /> : null}
            <input name="q" defaultValue={q} placeholder="Search clients…" aria-label="Search clients" className={cx(inputClass, 'w-56')} />
            <button type="submit" className={buttonClass('secondary', 'sm')}>Filter</button>
            {q ? <Link href={chip(status ?? null)} className="text-xs text-muted hover:underline">Clear</Link> : null}
          </form>
          {allTags.length > 0 ? (
            <FilterChips
              options={[
                { key: 'any-tag', label: 'Any tag', href: facetHref({ tag: '' }), active: !tag },
                ...allTags.map((t) => ({ key: `tag-${t}`, label: t, href: facetHref({ tag: t }), active: tag === t })),
              ]}
            />
          ) : null}
          {owners.length > 0 ? (
            <FilterChips
              options={[
                { key: 'any-owner', label: 'Any owner', href: facetHref({ owner: '' }), active: !owner },
                ...owners.map(([id, name]) => ({ key: `owner-${id}`, label: name, href: facetHref({ owner: id }), active: owner === id })),
                { key: 'owner-none', label: 'Unowned', href: facetHref({ owner: 'none' }), active: owner === 'none' },
              ]}
            />
          ) : null}
        </FilterBar>
      ) : null}

      <SavedViewsBar page="/clients" currentQuery={currentQuery} views={savedViews} />

      {clients.length > 0 ? (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-3">
          {mayEditClients ? <ClientBulkBar roster={bulkRoster} /> : null}
          <Card className="px-1 pb-1">
          <DataTable
            dense
            rows={pageRows}
            columns={columnsFor(clock, (id) => clients.findIndex((x) => x.id === id) + 1, (id) => overview.phoneByClient.get(id), mayEditClients, (id) => dupCount.get(id) ?? 0, chipOf)}
            getKey={(c) => c.id}
            rowActions={(c) => [
              { key: 'open', label: 'Open client', href: `/clients/${c.id}` },
              { key: 'select', label: 'Show details', href: qs(`client=${c.id}`) },
              { key: 'preview', label: 'Preview', node: <ClientPreviewButton clientId={c.id} name={c.name} /> },
              ...(mayEditClients ? [{ key: 'edit', label: 'Edit', node: <ClientEditButton client={{ id: c.id, name: c.name, legalName: c.legalName, gstin: c.gstin, pan: c.pan, billingAddress: c.billingAddress }} /> }] : []),
            ]}
            sort={{ key: sortKey, direction, makeHref: (key, nextDirection) => qs(`sort=${key}&dir=${nextDirection}`) }}
          />
          </Card>
          <Pagination page={page} pageCount={pageCount} makeHref={(p) => qs(`${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`)} />
          </div>
          {selected ? (
            <DetailPanel
              title="Client Details"
              actions={<Link href={`/clients/${selected.id}`} className="text-xs font-medium text-brand hover:underline">Open</Link>}
              rows={[
                { label: 'Client', value: selected.name },
                { label: 'Status', value: chipOf(selected) },
                { label: 'Client since', value: clock.date(selected.createdAt) },
                { label: 'Email', value: selected.billingEmail },
                { label: 'Phone', value: overview.phoneByClient.get(selected.id) ?? null },
                { label: 'Owner', value: selected.ownerName ?? 'Nobody' },
                { label: 'Total projects', value: String(selected.projectsTotal) },
                { label: 'Total value', value: money(selected.invoicedMinor, selected.currency) },
                { label: 'Paid', value: money(selected.paidMinor, selected.currency) },
                { label: 'Pending', value: money(selected.outstandingMinor, selected.currency) },
              ]}
            >
              <div className="border-t border-line px-4 py-3 sm:px-5">
                <p className="mb-2 text-sm font-bold text-foreground">Projects</p>
                {selectedProjects.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {selectedProjects.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2 text-[13px]">
                        <Link href={`/projects/${p.id}`} className="min-w-0 truncate font-medium text-foreground hover:text-brand">{p.name}</Link>
                        <StatusBadge status={p.status} dot={false} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[13px] text-muted">No projects yet.</p>
                )}
              </div>
              <div className="border-t border-line px-4 py-3 sm:px-5">
                <p className="mb-2 text-sm font-bold text-foreground">Client Tags</p>
                {selected.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {selected.tags.map((t) => (
                      <Badge key={t} tone="info">{t}</Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-[13px] text-muted">No tags yet.</p>
                )}
              </div>
            </DetailPanel>
          ) : null}
        </div>
      ) : (
        <EmptyState
          icon={<IconUser size={22} />}
          title={status || q || tag || owner ? 'No matching clients' : 'No clients yet'}
          description={q ? `No client matches “${q}”.` : tag || owner ? 'No client carries that tag or owner.' : status ? 'No client is in this state.' : 'A client account is created automatically the first time a deal is won, or from + Add client.'}
          action={status || q || tag || owner ? <Link href="/clients" className={buttonClass('secondary', 'sm')}>Clear filters</Link> : <Link href="/leads" className={buttonClass('secondary', 'sm')}>Open leads</Link>}
        />
      )}
      {allClients.length > 0 ? (
        <div className="grid items-start gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader title="Recent Communication" description={selected ? `For ${selected.name}` : undefined} actions={<ViewAll href="/communication" />} />
            {overview.recentMessages.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No client messages yet.</p>
            ) : (
              <ul className="divide-y divide-line px-4 pb-2 sm:px-5">
                {overview.recentMessages.map((m) => (
                  <li key={m.id} className="py-2.5 text-[13px]">
                    <span className="flex items-baseline justify-between gap-2">
                      <Link href={`/clients/${m.clientId}`} className="truncate font-medium text-foreground hover:text-brand">{clientName.get(m.clientId) ?? 'Client'}</Link>
                      <span className="shrink-0 text-xs text-muted">{clock.dateTime(m.at)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-muted">{m.direction === 'inbound' ? 'Received: ' : m.direction === 'outbound' ? 'Sent: ' : ''}{m.body}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Upcoming Follow-ups" description={selected ? `For ${selected.name}` : undefined} actions={<ViewAll href="/leads" />} />
            {overview.followUps.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No follow-up is scheduled for a client&apos;s lead.</p>
            ) : (
              <ul className="divide-y divide-line px-4 pb-2 sm:px-5">
                {overview.followUps.map((f) => (
                  <li key={f.leadId} className="py-2.5 text-[13px]">
                    <span className="flex items-baseline justify-between gap-2">
                      <Link href={`/leads/${f.leadId}`} className="truncate font-medium text-foreground hover:text-brand">{f.leadTitle}</Link>
                      <span className="shrink-0 text-xs text-muted">{clock.dateTime(f.at)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-muted">{clientName.get(f.clientId) ?? 'Client'}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Pending Invoices" description={selected ? `For ${selected.name}` : undefined} actions={<ViewAll href="/invoices" />} />
            {overview.pendingInvoices.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No invoice is waiting for payment.</p>
            ) : (
              <ul className="divide-y divide-line px-4 pb-2 sm:px-5">
                {overview.pendingInvoices.map((i) => (
                  <li key={i.id} className="py-2.5 text-[13px]">
                    <span className="flex items-baseline justify-between gap-2">
                      <Link href={`/invoices/${i.id}`} className="truncate font-mono text-xs font-medium text-foreground hover:text-brand">{i.number}</Link>
                      <span className="tabular shrink-0 font-medium">{money(i.owedMinor, i.currency)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2 text-muted">
                      <span className="truncate">{clientName.get(i.clientId) ?? 'Client'}</span>
                      <span className="shrink-0 text-xs">{i.dueAt ? `Due ${clock.date(i.dueAt)}` : 'No due date'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );
}
