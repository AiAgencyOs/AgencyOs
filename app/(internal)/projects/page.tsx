import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProjects } from '@/modules/projects/queries';
import { DataTable, EmptyState, IconProjects, PageHeader, StatusBadge, type Column } from '@/ui';

export const metadata: Metadata = { title: 'Projects' };

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function money(minor: number | null, currency: string): string {
  if (minor === null) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(minor / 100);
}

type Row = Awaited<ReturnType<typeof listProjects>>[number];

const COLUMNS: Column<Row>[] = [
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
    cell: (p) => DATE.format(new Date(p.created_at)),
  },
];

/** Delivery pipeline. Same two-layer gate as the other internal pages. */
export default async function ProjectsPage() {
  const context = await requireInternal('/projects');
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
          columns={COLUMNS}
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
