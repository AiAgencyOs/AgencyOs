import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProjectsFiltered, type FilteredProject } from '@/modules/projects/project-filters-queries';
import {
  DataTable,
  EmptyState,
  FilterBar,
  IconProjects,
  PageHeader,
  StatusBadge,
  buttonClass,
  labelClass,
  selectClass,
  type Column,
} from '@/ui';

export const metadata: Metadata = { title: 'Projects' };

function money(minor: number | null, currency: string): string {
  if (minor === null) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(minor / 100);
}

const columnsFor = (clock: AgencyClock): Column<FilteredProject>[] => [
  { key: 'name', header: 'Project', primary: true, cell: (p) => p.name },
  { key: 'status', header: 'Status', badge: true, cell: (p) => <StatusBadge status={p.status} /> },
  {
    key: 'client',
    header: 'Client',
    cell: (p) => (
      <Link href={`/clients/${p.clientAccountId}`} className="underline-offset-2 hover:underline">
        {p.clientName}
      </Link>
    ),
  },
  { key: 'owner', header: 'Owner', cellClassName: 'text-muted', cell: (p) => p.deliveryLeadName ?? '—' },
  {
    key: 'budget',
    header: 'Budget',
    align: 'right',
    cellClassName: 'tabular',
    cell: (p) => money(p.budgetMinor, p.currency),
  },
  {
    key: 'created',
    header: 'Created',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (p) => clock.date(p.createdAt),
  },
];

/**
 * Delivery pipeline. Same two-layer gate as the other internal pages.
 *
 * SCR-018: client and owner filters ride on `searchParams` through a GET
 * form, the same shape the leads and audit pages use, so a filtered list is a
 * URL somebody can send.
 */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; owner?: string }>;
}) {
  const context = await requireInternal('/projects');
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const { client, owner } = await searchParams;
  const { projects, clients, owners } = await listProjectsFiltered({
    ...(client ? { clientId: client } : {}),
    ...(owner ? { ownerId: owner } : {}),
  });
  const filtered = Boolean(client || owner);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Projects"
        description={
          projects.length === 0 && !filtered
            ? 'No projects yet. Winning a deal on a lead creates one.'
            : `${projects.length} project${projects.length === 1 ? '' : 's'}${filtered ? ' matching the filter' : ''}.`
        }
      />

      <FilterBar>
        <form action="/projects" method="GET" className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Client</span>
            <select name="client" defaultValue={client ?? ''} className={selectClass}>
              <option value="">Any client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Owner</span>
            <select name="owner" defaultValue={owner ?? ''} className={selectClass}>
              <option value="">Any owner</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonClass('secondary', 'sm')}>
            Filter
          </button>
          {filtered ? (
            <Link href="/projects" className={buttonClass('ghost', 'sm')}>
              Clear
            </Link>
          ) : null}
        </form>
      </FilterBar>

      {projects.length > 0 ? (
        <DataTable
          rows={projects}
          columns={columnsFor(clock)}
          getKey={(p) => p.id}
          href={(p) => `/projects/${p.id}`}
        />
      ) : (
        <EmptyState
          icon={<IconProjects size={22} />}
          title={filtered ? 'No projects match' : 'No projects yet'}
          description={filtered ? 'Try clearing the client or owner filter.' : 'Projects created from won deals will appear here.'}
        />
      )}
    </div>
  );
}
