import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProjects } from '@/modules/projects/queries';
import { SavedViewsBar } from '../saved-views-bar';
import {
  DataTable,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  IconProjects,
  paginate,
  Pagination,
  PageHeader,
  StatusBadge,
  type Column,
  PermissionDenied,
  sortRows,
  type SortDirection,
} from '@/ui';

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
    sortKey: 'budget',
  },
  {
    key: 'created',
    header: 'Created',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (p) => clock.date(p.created_at),
    sortKey: 'created',
  },
];

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
  budget: (a, b) => (a.budget_minor ?? 0) - (b.budget_minor ?? 0),
  created: (a, b) => a.created_at.localeCompare(b.created_at),
};

/** Delivery pipeline. Same two-layer gate as the other internal pages. */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string }>;
}) {
  const context = await requireInternal('/projects');
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const { page: pageParam, sort: sortKey, dir } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const currentQuery = sortKey ? `sort=${sortKey}&dir=${direction}` : '';
  const [rawProjects, savedViews] = await Promise.all([listProjects(), listSavedViews('/projects')]);
  const projects = sortRows(rawProjects, sortKey, direction, COMPARATORS);
  const { page, pageCount, rows: pageRows } = paginate(projects, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);

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

      <SavedViewsBar page="/projects" currentQuery={currentQuery} views={savedViews} />

      {projects.length > 0 ? (
        <>
          <DataTable
            rows={pageRows}
            columns={columnsFor(clock)}
            getKey={(p) => p.id}
            href={(p) => `/projects/${p.id}`}
            sort={{
              key: sortKey,
              direction,
              makeHref: (key, nextDirection) => `/projects?sort=${key}&dir=${nextDirection}`,
            }}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            makeHref={(p) => `/projects?${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`}
          />
        </>
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
