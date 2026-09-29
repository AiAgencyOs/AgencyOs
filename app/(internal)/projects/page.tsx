import type { Metadata } from 'next';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProjectsForTable } from '@/modules/projects/queries';
import { PROJECT_STATUSES } from '@/modules/projects/schema';
import { SavedViewsBar } from '../saved-views-bar';
import {
  Avatar,
  DataTable,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  FilterBar,
  FilterChips,
  humanize,
  IconProjects,
  paginate,
  Pagination,
  PageHeader,
  ProgressBar,
  Stat,
  StatGrid,
  StatusBadge,
  statusTone,
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

type Row = Awaited<ReturnType<typeof listProjectsForTable>>[number];

const columnsFor = (clock: AgencyClock): Column<Row>[] => [
  {
    key: 'name',
    header: 'Project name',
    primary: true,
    cell: (p) => (
      <span className="flex items-center gap-2.5">
        <Avatar name={p.name} size="md" square tone="neutral" className="bg-sidebar-bg text-sidebar-fg ring-0" />
        <span className="min-w-0">
          <span className="block truncate">{p.name}</span>
          <span className="block truncate font-mono text-[11px] font-normal text-muted">{p.code}</span>
        </span>
      </span>
    ),
  },
  { key: 'client', header: 'Client', desktopOnly: true, cellClassName: 'text-muted', cell: (p) => p.clientName ?? 'Internal' },
  { key: 'status', header: 'Stage', badge: true, cell: (p) => <StatusBadge status={p.status} dot={false} /> },
  {
    key: 'progress',
    header: 'Progress',
    width: '11rem',
    cell: (p) =>
      p.milestonesTotal > 0 ? (
        <ProgressBar value={(p.milestonesMet / p.milestonesTotal) * 100} label={`${p.name} milestones met`} />
      ) : (
        <span className="text-xs text-muted">No plan yet</span>
      ),
  },
  {
    key: 'due',
    header: 'Due date',
    align: 'right',
    cellClassName: 'text-muted whitespace-nowrap',
    cell: (p) => (p.endsOn ? clock.date(p.endsOn) : '—'),
    sortKey: 'due',
  },
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
    desktopOnly: true,
    cellClassName: 'text-muted whitespace-nowrap',
    cell: (p) => clock.date(p.created_at),
    sortKey: 'created',
  },
];

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
  budget: (a, b) => (a.budget_minor ?? 0) - (b.budget_minor ?? 0),
  created: (a, b) => a.created_at.localeCompare(b.created_at),
  due: (a, b) => (a.endsOn ?? '9999').localeCompare(b.endsOn ?? '9999'),
};

/** Delivery pipeline. Same two-layer gate as the other internal pages. */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string; status?: string }>;
}) {
  const context = await requireInternal('/projects');
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const { page: pageParam, sort: sortKey, dir, status } = await searchParams;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  const currentQuery = [status ? `status=${status}` : '', sortKey ? `sort=${sortKey}&dir=${direction}` : ''].filter(Boolean).join('&');
  const [allProjects, savedViews] = await Promise.all([listProjectsForTable(), listSavedViews('/projects')]);
  const countByStatus = new Map<string, number>();
  for (const p of allProjects) countByStatus.set(p.status, (countByStatus.get(p.status) ?? 0) + 1);
  const filtered = status ? allProjects.filter((p) => p.status === status) : allProjects;
  const projects = sortRows(filtered, sortKey, direction, COMPARATORS);
  const qs = (extra: string) => `/projects?${status ? `status=${status}&` : ''}${extra}`;
  const { page, pageCount, rows: pageRows } = paginate(projects, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="All projects"
        description={
          allProjects.length === 0
            ? 'No projects yet. Winning a deal on a lead creates one.'
            : `Every project, its stage and how far its plan has come · ${allProjects.length} project${allProjects.length === 1 ? '' : 's'}.`
        }
      />

      {allProjects.length > 0 ? (
        <StatGrid cols={6}>
          <Stat label="Total projects" value={String(allProjects.length)} tone="brand" icon={<IconProjects size={16} />} />
          {PROJECT_STATUSES.filter((s) => s !== 'cancelled').map((s) => (
            <Stat key={s} label={humanize(s)} value={String(countByStatus.get(s) ?? 0)} tone={statusTone(s)} href={`/projects?status=${s}`} />
          ))}
        </StatGrid>
      ) : null}

      {allProjects.length > 0 ? (
        <FilterBar>
          <FilterChips
            options={[
              { key: 'all', label: 'All', href: '/projects', active: !status },
              ...PROJECT_STATUSES.map((s) => ({
                key: s,
                label: `${humanize(s)} (${countByStatus.get(s) ?? 0})`,
                href: `/projects?status=${s}`,
                active: status === s,
              })),
            ]}
          />
        </FilterBar>
      ) : null}

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
              makeHref: (key, nextDirection) => qs(`sort=${key}&dir=${nextDirection}`),
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
          icon={<IconProjects size={22} />}
          title={status ? 'No matching projects' : 'No projects yet'}
          description={status ? `No project is currently "${humanize(status)}".` : 'Projects created from won deals will appear here.'}
        />
      )}
    </div>
  );
}
