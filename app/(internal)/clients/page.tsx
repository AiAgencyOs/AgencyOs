import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listClients } from '@/lib/admin/clients';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { SavedViewsBar } from '../saved-views-bar';
import { CreateLeadButton } from '../leads/create-lead-button';
import { ClientPreviewButton } from './preview-drawer';
import {
  Avatar,
  Badge,
  buttonClass,
  cx,
  DataTable,
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

export const metadata: Metadata = { title: 'Clients' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

type Row = Awaited<ReturnType<typeof listClients>>[number];

const columnsFor = (clock: AgencyClock): Column<Row>[] => [
  {
    key: 'name',
    header: 'Client name',
    primary: true,
    cell: (c) => (
      <span className="flex items-center gap-2.5">
        <Avatar name={c.name} size="md" />
        <span className="min-w-0">
          <span className="block truncate">{c.name}</span>
          {c.billingEmail ? <span className="block truncate text-xs font-normal text-muted">{c.billingEmail}</span> : null}
        </span>
      </span>
    ),
  },
  {
    key: 'projects',
    header: 'Projects',
    desktopOnly: true,
    cellClassName: 'text-muted',
    cell: (c) => (c.projectsTotal === 0 ? 'None yet' : `${c.projectsActive} active · ${c.projectsTotal} total`),
  },
  { key: 'invoiced', header: 'Total value', align: 'right', cellClassName: 'tabular', cell: (c) => money(c.invoicedMinor, c.currency), sortKey: 'invoiced' },
  { key: 'outstanding', header: 'Outstanding', align: 'right', cellClassName: 'tabular font-medium', cell: (c) => money(c.outstandingMinor, c.currency), sortKey: 'outstanding' },
  {
    key: 'status',
    header: 'Status',
    badge: true,
    cell: (c) => (
      <Badge tone={c.status === 'active' ? 'success' : 'neutral'} dot>
        {c.status === 'active' ? 'Active' : 'Archived'}
      </Badge>
    ),
  },
  {
    // SCR-014 — the relationship owner, with the tags beneath.
    key: 'owner',
    header: 'Owner',
    desktopOnly: true,
    cell: (c) => (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={c.ownerName ? 'text-foreground' : 'text-muted'}>{c.ownerName ?? 'Nobody'}</span>
        {c.tags.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {c.tags.slice(0, 4).map((t) => (
              <Badge key={t} tone="neutral">{t}</Badge>
            ))}
            {c.tags.length > 4 ? <span className="text-[11px] text-faint">+{c.tags.length - 4}</span> : null}
          </span>
        ) : null}
      </span>
    ),
  },
  { key: 'created', header: 'Joined', align: 'right', cellClassName: 'text-muted whitespace-nowrap', cell: (c) => clock.date(c.createdAt), sortKey: 'created' },
  {
    // SCR-014: the preview drawer, fetched on open (preview-actions.ts).
    key: 'preview',
    header: '',
    align: 'right',
    desktopOnly: true,
    cell: (c) => <ClientPreviewButton clientId={c.id} name={c.name} />,
  },
];

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
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
  searchParams: Promise<{ page?: string; sort?: string; dir?: string; status?: string; q?: string; tag?: string; owner?: string }>;
}) {
  const context = await requireInternal('/clients');
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const { page: pageParam, sort: sortKey, dir, status, q: qRaw, tag: tagRaw, owner: ownerRaw } = await searchParams;
  const q = (qRaw ?? '').trim();
  const tag = (tagRaw ?? '').trim().toLowerCase();
  const owner = (ownerRaw ?? '').trim();
  const needle = q.toLowerCase();
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const facet = [tag ? `tag=${encodeURIComponent(tag)}` : '', owner ? `owner=${encodeURIComponent(owner)}` : ''].filter(Boolean);
  const currentQuery = [status ? `status=${status}` : '', q ? `q=${encodeURIComponent(q)}` : '', ...facet, sortKey ? `sort=${sortKey}&dir=${direction}` : ''].filter(Boolean).join('&');
  const [allClients, savedViews] = await Promise.all([listClients(), listSavedViews('/clients')]);

  const active = allClients.filter((c) => c.status === 'active');
  const archived = allClients.filter((c) => c.status !== 'active');
  const owing = allClients.filter((c) => c.outstandingMinor > 0);
  const withProjects = allClients.filter((c) => c.projectsActive > 0);
  const currency = allClients[0]?.currency ?? 'INR';
  const sameCurrency = allClients.every((c) => c.currency === currency);
  const totalInvoiced = allClients.filter((c) => c.currency === currency).reduce((n, c) => n + c.invoicedMinor, 0);

  const byStatus =
    status === 'active' ? active : status === 'archived' ? archived : status === 'owing' ? owing : status === 'working' ? withProjects : allClients;
  const bySearch = needle ? byStatus.filter((c) => c.name.toLowerCase().includes(needle) || (c.billingEmail ?? '').toLowerCase().includes(needle)) : byStatus;
  // SCR-014 — `?tag=` and `?owner=` (owner is a user id; `none` means unowned).
  const filtered = bySearch.filter((c) => (!tag || c.tags.includes(tag)) && (!owner || (owner === 'none' ? c.ownerId === null : c.ownerId === owner)));
  const clients = sortRows(filtered, sortKey, direction, COMPARATORS);
  const { page, pageCount, rows: pageRows } = paginate(clients, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);
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
        title="Client management"
        description="Manage your clients, track projects, communication and business growth."
        actions={
          <>
            <a href={`/api/clients/export${exportQuery ? `?${exportQuery}` : ''}`} className={buttonClass('secondary', 'sm')}>
              <IconDownload size={14} />
              Export CSV
            </a>
            {can(context.role, 'organization.settings') ? (
              <Link href="/import" className={buttonClass('secondary', 'sm')}>
                <IconImport size={14} />
                Import
              </Link>
            ) : null}
            {can(context.role, 'project.write') ? <CreateLeadButton mode="client" label="Add client" /> : null}
          </>
        }
      />

      {allClients.length > 0 ? (
        <StatGrid cols={5}>
          <Stat label="Total clients" value={String(allClients.length)} caption={`${archived.length} archived`} tone="brand" icon={<IconUsers size={16} />} href="/clients" />
          <Stat label="Active clients" value={String(active.length)} caption="On the books" tone="success" icon={<IconUser size={16} />} href="/clients?status=active" />
          <Stat label="Working now" value={String(withProjects.length)} caption="With an active project" tone="info" icon={<IconCheck size={16} />} href="/clients?status=working" />
          <Stat label="Owing" value={String(owing.length)} caption="With an outstanding balance" tone={owing.length > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} href="/clients?status=owing" />
          <Stat
            label="Total invoiced"
            value={money(totalInvoiced, currency)}
            caption={sameCurrency ? 'From all clients' : `${currency} clients only`}
            tone="accent"
            icon={<IconRupee size={16} />}
            href="/finance"
          />
        </StatGrid>
      ) : null}

      {allClients.length > 0 ? (
        <FilterBar>
          <FilterChips
            options={[
              { key: 'all', label: `All clients (${allClients.length})`, href: chip(null), active: !status },
              { key: 'active', label: `Active (${active.length})`, href: chip('active'), active: status === 'active' },
              { key: 'working', label: `Working (${withProjects.length})`, href: chip('working'), active: status === 'working' },
              { key: 'owing', label: `Owing (${owing.length})`, href: chip('owing'), active: status === 'owing' },
              { key: 'archived', label: `Archived (${archived.length})`, href: chip('archived'), active: status === 'archived' },
            ]}
          />
          <form method="get" action="/clients" className="flex flex-wrap items-center gap-2">
            {status ? <input type="hidden" name="status" value={status} /> : null}
            {tag ? <input type="hidden" name="tag" value={tag} /> : null}
            {owner ? <input type="hidden" name="owner" value={owner} /> : null}
            <input name="q" defaultValue={q} placeholder="Search name or email…" aria-label="Search clients" className={cx(inputClass, 'w-56')} />
            <button type="submit" className={buttonClass('secondary', 'sm')}>Search</button>
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
        <>
          <DataTable
            rows={pageRows}
            columns={columnsFor(clock)}
            getKey={(c) => c.id}
            href={(c) => `/clients/${c.id}`}
            sort={{ key: sortKey, direction, makeHref: (key, nextDirection) => qs(`sort=${key}&dir=${nextDirection}`) }}
          />
          <Pagination page={page} pageCount={pageCount} makeHref={(p) => qs(`${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`)} />
        </>
      ) : (
        <EmptyState
          icon={<IconUser size={22} />}
          title={status || q || tag || owner ? 'No matching clients' : 'No clients yet'}
          description={q ? `No client matches “${q}”.` : tag || owner ? 'No client carries that tag or owner.' : status ? 'No client is in this state.' : 'A client account is created automatically the first time a deal is won, or from + Add client.'}
          action={status || q || tag || owner ? <Link href="/clients" className={buttonClass('secondary', 'sm')}>Clear filters</Link> : <Link href="/leads" className={buttonClass('secondary', 'sm')}>Open leads</Link>}
        />
      )}
    </div>
  );
}
