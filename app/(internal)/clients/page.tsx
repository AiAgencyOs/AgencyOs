import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listClients } from '@/lib/admin/clients';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { SavedViewsBar } from '../saved-views-bar';
import { CreateLeadButton } from '../leads/create-lead-button';
import {
  Avatar,
  Badge,
  buttonClass,
  DataTable,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  FilterBar,
  FilterChips,
  IconCheck,
  IconClock,
  IconImport,
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
  { key: 'created', header: 'Joined', align: 'right', cellClassName: 'text-muted whitespace-nowrap', cell: (c) => clock.date(c.createdAt), sortKey: 'created' },
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
  searchParams: Promise<{ page?: string; sort?: string; dir?: string; status?: string }>;
}) {
  const context = await requireInternal('/clients');
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const { page: pageParam, sort: sortKey, dir, status } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const currentQuery = [status ? `status=${status}` : '', sortKey ? `sort=${sortKey}&dir=${direction}` : ''].filter(Boolean).join('&');
  const [allClients, savedViews] = await Promise.all([listClients(), listSavedViews('/clients')]);

  const active = allClients.filter((c) => c.status === 'active');
  const archived = allClients.filter((c) => c.status !== 'active');
  const owing = allClients.filter((c) => c.outstandingMinor > 0);
  const withProjects = allClients.filter((c) => c.projectsActive > 0);
  const currency = allClients[0]?.currency ?? 'INR';
  const sameCurrency = allClients.every((c) => c.currency === currency);
  const totalInvoiced = allClients.filter((c) => c.currency === currency).reduce((n, c) => n + c.invoicedMinor, 0);

  const filtered =
    status === 'active' ? active : status === 'archived' ? archived : status === 'owing' ? owing : status === 'working' ? withProjects : allClients;
  const clients = sortRows(filtered, sortKey, direction, COMPARATORS);
  const { page, pageCount, rows: pageRows } = paginate(clients, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);
  const qs = (extra: string) => `/clients?${status ? `status=${status}&` : ''}${extra}`;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Client management"
        description="Manage your clients, track projects, communication and business growth."
        actions={
          <>
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
              { key: 'all', label: `All clients (${allClients.length})`, href: '/clients', active: !status },
              { key: 'active', label: `Active (${active.length})`, href: '/clients?status=active', active: status === 'active' },
              { key: 'working', label: `Working (${withProjects.length})`, href: '/clients?status=working', active: status === 'working' },
              { key: 'owing', label: `Owing (${owing.length})`, href: '/clients?status=owing', active: status === 'owing' },
              { key: 'archived', label: `Archived (${archived.length})`, href: '/clients?status=archived', active: status === 'archived' },
            ]}
          />
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
          title={status ? 'No matching clients' : 'No clients yet'}
          description={status ? 'No client is in this state.' : 'A client account is created automatically the first time a deal is won, or from + Add client.'}
        />
      )}
    </div>
  );
}
