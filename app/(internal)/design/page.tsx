import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { LiveRefresh } from '@/lib/realtime';
import { readDesignPortfolio } from '@/modules/projects/queries';
import {
  Badge,
  DataTable,
  EmptyState,
  IconPalette,
  PageHeader,
  PermissionDenied,
  Stat,
  StatGrid,
  StatusBadge,
  type Column,
} from '@/ui';

export const metadata: Metadata = { title: 'Design & Prototype' };

type Row = Awaited<ReturnType<typeof readDesignPortfolio>>[number];

const columnsFor = (clock: AgencyClock): Column<Row>[] => [
  {
    key: 'name',
    header: 'Project',
    primary: true,
    cell: (p) => (
      <>
        <span className="block font-medium text-foreground">{p.name}</span>
        <span className="block text-xs text-muted">{p.code}</span>
      </>
    ),
  },
  {
    key: 'phase',
    header: 'Phase 3',
    badge: true,
    cell: (p) => (p.phaseThreeState ? <StatusBadge status={p.phaseThreeState} /> : <Badge tone="neutral">not started</Badge>),
  },
  {
    key: 'reviewer',
    header: 'Reviewer',
    desktopOnly: true,
    cellClassName: 'text-muted',
    cell: (p) => (p.phaseThreeState ? (p.reviewerAssigned ? 'assigned' : <span className="text-warning">unassigned</span>) : '—'),
  },
  {
    key: 'revisions',
    header: 'Client revisions',
    align: 'right',
    cellClassName: 'tabular text-muted',
    cell: (p) =>
      p.phaseThreeState ? `${p.clientRevisionsUsed}${p.clientRevisionLimit !== null ? ` / ${p.clientRevisionLimit}` : ''}` : '—',
  },
  {
    key: 'designs',
    header: 'Designs',
    align: 'right',
    cellClassName: 'tabular',
    cell: (p) => (
      <span title={`${p.designs.inReview} in review · ${p.designs.approved} approved`}>
        {p.designs.total}
        {p.designs.inReview > 0 ? <span className="ml-1 text-warning">({p.designs.inReview} in review)</span> : null}
      </span>
    ),
  },
  {
    key: 'prototypes',
    header: 'Prototypes',
    align: 'right',
    cellClassName: 'tabular',
    cell: (p) => (
      <span title={`${p.prototypes.inReview} in review · ${p.prototypes.approved} approved`}>
        {p.prototypes.total}
        {p.prototypes.inReview > 0 ? <span className="ml-1 text-warning">({p.prototypes.inReview} in review)</span> : null}
      </span>
    ),
  },
  {
    key: 'updated',
    header: 'Last design change',
    align: 'right',
    desktopOnly: true,
    cellClassName: 'text-muted',
    cell: (p) => (p.designUpdatedAt ? clock.dateTime(p.designUpdatedAt) : '—'),
  },
];

/**
 * Design & Prototype — the module's front door (screen architecture §2,
 * module 6). Every Phase 3/4 artifact already lives on its project's own
 * Design tab (`/projects/[id]/design/**`, SCR-032…038); what was missing was
 * the portfolio view — which projects are in design, which are waiting on a
 * reviewer, which have a client revision loop open — without opening each
 * project. Three reads, grouped in memory, no per-project fan-out.
 */
export default async function DesignPortfolioPage() {
  const context = await requireInternal('/design');
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const [rows, clock] = await Promise.all([readDesignPortfolio(), agencyClock()]);
  const inDesign = rows.filter((r) => r.phaseThreeState && r.phaseThreeState !== 'completed');
  const awaitingReviewer = inDesign.filter((r) => !r.reviewerAssigned).length;
  const inReview = rows.reduce((n, r) => n + r.designs.inReview + r.prototypes.inReview, 0);
  const revisionsOpen = inDesign.filter((r) => r.clientRevisionsUsed > 0).length;
  const columns = columnsFor(clock);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Design & Prototype"
        title="Design dashboard"
        description="Phase 3 theme finalisation and Phase 4 screen design and prototype, across every project. Open a project for its screens, versions, reviews and client decisions."
        actions={<LiveRefresh topics={['deliverables', 'projects']} />}
      />

      {rows.length > 0 ? (
        <StatGrid cols={4}>
          <Stat label="Projects in design" value={String(inDesign.length)} tone="brand" icon={<IconPalette size={16} />} href="/design" />
          <Stat label="Awaiting reviewer" value={String(awaitingReviewer)} tone={awaitingReviewer > 0 ? 'warning' : 'neutral'} caption="Phase 3 started, no internal reviewer assigned" />
          <Stat label="Artifacts in review" value={String(inReview)} tone={inReview > 0 ? 'info' : 'neutral'} caption="designs and prototypes awaiting a decision" />
          <Stat label="Client revision loops" value={String(revisionsOpen)} tone="neutral" caption="projects where the client asked for changes" />
        </StatGrid>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={<IconPalette size={22} />}
          title="No projects yet"
          description="Design work begins on a project once its deal is won and Phase 2 onboarding starts Phase 3. Won deals convert from the Lead 360 page."
          action={<Link href="/leads" className="text-brand hover:underline">Open leads</Link>}
        />
      ) : (
        <DataTable rows={rows} columns={columns} getKey={(r) => r.id} href={(r) => `/projects/${r.id}/design`} />
      )}

      <p className="text-xs text-muted">
        Phase states are read from each project&apos;s Phase 3 record (theme options, review, client selection, handoff);
        artifact counts from its design and prototype deliverables. Nothing here is estimated.
      </p>
    </div>
  );
}
