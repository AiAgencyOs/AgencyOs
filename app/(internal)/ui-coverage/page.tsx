import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPhaseFourWorkspaces, type PhaseFourWorkspaceSummary } from '@/modules/projects/queries';
import { Badge, Card, DataTable, EmptyState, IconProjects, PageHeader, type Column, type Tone } from '@/ui';

export const metadata: Metadata = { title: 'UI Coverage' };

type Row = PhaseFourWorkspaceSummary;

function missingScreenCount(row: Row): number {
  return row.uiVersion?.qaFindings?.missingScreens?.length ?? 0;
}

function stateGapCount(row: Row): number {
  return row.uiVersion?.qaFindings?.stateGaps?.length ?? 0;
}

function coverageTone(row: Row): Tone {
  if (!row.uiVersion) return 'neutral';
  if (!row.uiVersion.qaReviewedAt) return 'neutral';
  return missingScreenCount(row) + stateGapCount(row) === 0 ? 'success' : 'warning';
}

const columnsFor = (): Column<Row>[] => [
  { key: 'project', header: 'Project', primary: true, cell: (r) => r.projectName },
  { key: 'version', header: 'UI version', cell: (r) => (r.uiVersion ? `v${r.uiVersion.version}` : '—') },
  {
    key: 'screens',
    header: 'Missing screens',
    cell: (r) => (r.uiVersion?.qaReviewedAt ? String(missingScreenCount(r)) : 'not reviewed'),
  },
  {
    key: 'states',
    header: 'State gaps',
    cell: (r) => (r.uiVersion?.qaReviewedAt ? String(stateGapCount(r)) : 'not reviewed'),
  },
  {
    key: 'coverage',
    header: 'Coverage',
    badge: true,
    cell: (r) => (
      <Badge tone={coverageTone(r)}>
        {!r.uiVersion ? 'no draft' : !r.uiVersion.qaReviewedAt ? 'unreviewed' : missingScreenCount(r) + stateGapCount(r) === 0 ? 'complete' : 'incomplete'}
      </Badge>
    ),
  },
];

/**
 * UI Coverage — UID §18, Impl §10 ("IS MANDATORY UI COVERAGE COMPLETE?").
 * The per-project Screen×State grid (`buildUiCoverageMatrix`,
 * `phase-four-panel.tsx`) already answers this for one project; this is the
 * org-wide roll-up Impl §10 names as its own dedicated screen — which
 * projects' locked baselines are fully drafted and reviewed, and which still
 * have a missing screen or an undeclared state, without opening each one.
 *
 * Deliberately does not recompute the matrix: `missingScreens`/`stateGaps`
 * are the SAME `qa_findings` Design QA already wrote
 * (`handleReviewUIVersion`, `src/modules/qa/handlers.ts`) — a second
 * computation here could disagree with the stored verdict, which is exactly
 * what `buildUiCoverageMatrix`'s own docblock already refuses to risk. The
 * full Screen×State grid for one project stays one click away, at
 * `/projects/[projectId]`.
 */
export default async function UiCoveragePage() {
  const context = await requireInternal('/ui-coverage');
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const workspaces = await listPhaseFourWorkspaces();
  const incomplete = workspaces.filter((w) => !w.uiVersion || !w.uiVersion.qaReviewedAt || missingScreenCount(w) + stateGapCount(w) > 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="UI Coverage"
        description={
          workspaces.length === 0
            ? 'No Task 2 workspace has started yet.'
            : `${incomplete.length} of ${workspaces.length} project${workspaces.length === 1 ? '' : 's'} ${incomplete.length === 1 ? 'has' : 'have'} incomplete coverage.`
        }
      />

      {workspaces.length > 0 ? (
        <Card className="p-0">
          <DataTable rows={workspaces} columns={columnsFor()} getKey={(r) => r.phaseFourId} href={(r) => `/projects/${r.projectId}`} />
        </Card>
      ) : (
        <EmptyState
          icon={<IconProjects size={22} />}
          title="Nothing to cover yet"
          description="A project's coverage appears here once its Task 2 workspace starts."
        />
      )}
    </div>
  );
}
