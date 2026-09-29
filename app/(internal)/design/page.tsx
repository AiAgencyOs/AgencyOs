import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readDesignReviewQueue, type DesignQueueRow } from '@/modules/projects/design-review-queries';
import { Badge, DataTable, EmptyState, FilterBar, FilterChips, IconPortfolio, PageHeader, Stat, StatGrid, type Column, type Tone } from '@/ui';

export const metadata: Metadata = { title: 'Design review' };

const WAITING_LABEL: Record<DesignQueueRow['waitingOn'], string> = {
  internal: 'internal reviewer',
  admin: 'Admin',
  client: 'the client',
};

const WAITING_TONE: Record<DesignQueueRow['waitingOn'], Tone> = {
  internal: 'info',
  admin: 'warning',
  client: 'neutral',
};

const FILTERS = ['all', 'internal', 'admin', 'client'] as const;
type Filter = (typeof FILTERS)[number];

function columns(clock: AgencyClock): Column<DesignQueueRow>[] {
  return [
    {
      key: 'name',
      header: 'Option',
      primary: true,
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-medium">
            {r.name} <span className="text-xs text-muted">#{r.optionIndex} · v{r.version}</span>
          </span>
          <span className="text-xs text-muted">{r.projectName}</span>
        </span>
      ),
    },
    {
      key: 'waiting',
      header: 'Waiting on',
      badge: true,
      cell: (r) => <Badge tone={WAITING_TONE[r.waitingOn]}>{WAITING_LABEL[r.waitingOn]}</Badge>,
    },
    {
      key: 'gates',
      header: 'Gates',
      desktopOnly: true,
      cell: (r) => (
        <span className="text-xs text-muted">
          internal {r.internalReviewStatus.replace(/_/g, ' ')} · admin {r.adminStatus.replace(/_/g, ' ')} · client{' '}
          {r.clientStatus.replace(/_/g, ' ')}
        </span>
      ),
    },
    {
      key: 'reviewer',
      header: 'Reviewer',
      desktopOnly: true,
      cell: (r) => (r.reviewerUserId ? 'assigned' : <span className="text-warning">nobody assigned</span>),
    },
    { key: 'since', header: 'Since', align: 'right', cellClassName: 'tabular', cell: (r) => clock.dateTime(r.updatedAt) },
  ];
}

/**
 * Design review — SCR-036's cross-project queue. Every project's Themes tab
 * shows its own options at its own gates; this is where a reviewer, an
 * Admin or an account owner finds the options waiting on *them* without
 * opening each project. The counts are the three gate columns on
 * `theme_options`, read as stored; the row opens the project's Themes tab,
 * where the doors are. Gated on `project.read`, like the tab.
 */
export default async function DesignReviewPage({ searchParams }: { searchParams: Promise<{ waiting?: string }> }) {
  const context = await requireInternal('/design');
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const { waiting } = await searchParams;
  const filter: Filter = (FILTERS as readonly string[]).includes(waiting ?? '') ? (waiting as Filter) : 'all';

  const [queue, clock] = await Promise.all([readDesignReviewQueue(), agencyClock()]);
  const rows = filter === 'all' ? queue.rows : queue.rows.filter((r) => r.waitingOn === filter);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Design review"
        description={
          queue.rows.length === 0
            ? 'No design option is waiting at any gate.'
            : `${queue.rows.length} option${queue.rows.length === 1 ? '' : 's'} waiting at a gate, longest first.`
        }
      />

      <StatGrid>
        <Stat
          label="Awaiting internal review"
          value={String(queue.awaitingInternal)}
          tone={queue.awaitingInternal > 0 ? 'info' : 'success'}
          href="/design?waiting=internal"
        />
        <Stat
          label="Awaiting Admin"
          value={String(queue.awaitingAdmin)}
          tone={queue.awaitingAdmin > 0 ? 'warning' : 'success'}
          href="/design?waiting=admin"
        />
        <Stat label="Awaiting the client" value={String(queue.awaitingClient)} href="/design?waiting=client" />
      </StatGrid>

      <FilterBar>
        <FilterChips
          options={FILTERS.map((f) => ({
            key: f,
            label: f === 'all' ? 'All' : `Waiting on ${WAITING_LABEL[f]}`,
            href: f === 'all' ? '/design' : `/design?waiting=${f}`,
            active: filter === f,
          }))}
        />
      </FilterBar>

      {rows.length === 0 ? (
        <EmptyState
          icon={<IconPortfolio size={22} />}
          title={filter === 'all' ? 'Nothing waiting' : `Nothing waiting on ${WAITING_LABEL[filter as DesignQueueRow['waitingOn']]}`}
          description="An option appears here from the moment the designer submits it until the client has answered."
        />
      ) : (
        <DataTable rows={rows} columns={columns(clock)} getKey={(r) => r.themeOptionId} href={(r) => `/projects/${r.projectId}/design/themes`} />
      )}
    </div>
  );
}
