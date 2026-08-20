import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProjects } from '@/modules/projects/queries';
import { DataTable, EmptyState, IconProjects, PageHeader, StatusBadge, type Column } from '@/ui';

export const metadata: Metadata = { title: 'Projects' };

function money(minor: number | null, currency: string): string {
  if (minor === null) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(minor / 100);
}

type Row = Awaited<ReturnType<typeof listProjects>>[number];

const columnsFor = (clock: AgencyClock): Column<Row>[] => [
  { key: 'name', header: 'Project', primary: true, cell: (p) => p.name },
  { key: 'status', header: 'Status', badge: true, cell: (p) => <StatusBadge status={p.status} /> },
  {
    key: 'budget',
    header: 'Budget',
    align: 'right',
    cellClassName: 'tabular',
    cell: (p) => money(p.budget_minor, p.currency),
  },
  {
    key: 'created',
    header: 'Created',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (p) => clock.date(p.created_at),
  },
];

/** Delivery pipeline. Same two-layer gate as the other internal pages. */
export default async function ProjectsPage() {
  const context = await requireInternal('/projects');
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const projects = await listProjects();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Projects"
        description={
          projects.length === 0
            ? 'No projects yet. Winning a deal on a lead creates one.'
            : `${projects.length} project${projects.length === 1 ? '' : 's'}.`
        }
      />

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
          title="No projects yet"
          description="Projects created from won deals will appear here."
        />
      )}
    </div>
  );
}
