import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPhaseFourWorkspaces, type PhaseFourWorkspaceSummary } from '@/modules/projects/queries';
import { Badge, Card, DataTable, EmptyState, IconCheck, PageHeader, type Column, type Tone } from '@/ui';

export const metadata: Metadata = { title: 'Design QA' };

type Row = PhaseFourWorkspaceSummary;

function gapCount(row: Row): number {
  const findings = row.uiVersion?.qaFindings;
  if (!findings) return 0;
  return (findings.missingScreens?.length ?? 0) + (findings.stateGaps?.length ?? 0);
}

function verdictTone(row: Row): Tone {
  if (!row.uiVersion) return 'neutral';
  if (!row.uiVersion.qaReviewedAt) return 'warning';
  return gapCount(row) === 0 ? 'success' : 'danger';
}

function verdictLabel(row: Row): string {
  if (!row.uiVersion) return 'no UI version yet';
  if (!row.uiVersion.qaReviewedAt) return 'awaiting Design QA';
  return gapCount(row) === 0 ? 'full coverage' : `${gapCount(row)} gap${gapCount(row) === 1 ? '' : 's'}`;
}

const columnsFor = (clock: AgencyClock): Column<Row>[] => [
  { key: 'project', header: 'Project', primary: true, cell: (r) => r.projectName },
  {
    key: 'version',
    header: 'UI version',
    cell: (r) => (r.uiVersion ? `v${r.uiVersion.version} · ${r.uiVersion.status}` : '—'),
  },
  {
    key: 'verdict',
    header: 'Design QA',
    badge: true,
    cell: (r) => <Badge tone={verdictTone(r)}>{verdictLabel(r)}</Badge>,
  },
  {
    key: 'reviewedAt',
    header: 'Reviewed',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (r) => (r.uiVersion?.qaReviewedAt ? clock.dateTime(r.uiVersion.qaReviewedAt) : '—'),
  },
];

/**
 * Design QA Overview — UID §18/UID §19, QAP §7 (P4-UID-ADMINUI, P4-QAP-ADMINUI
 * / P4-IMPL-ADMINUI). `handleReviewUIVersion` (`src/modules/qa/handlers.ts`)
 * has produced a real, independent verdict — `qa_pass`/`qa_changes_required`,
 * with named `qa_findings` — since `20260923120000`; the per-project
 * `phase-four-panel.tsx` already shows it for the ONE project somebody
 * happens to already be looking at. This is the org-wide surface Impl §10
 * names and no page answered: which projects' UI versions QA has actually
 * reviewed, and which of those still have a named gap, across every project
 * at once.
 *
 * Reuses `listPhaseFourWorkspaces` — no new table, no re-derived verdict:
 * `qa_findings`/`qa_reviewed_at` are read exactly as QA wrote them. A project
 * row links to `/projects/[id]` where the full Coverage Matrix and revision
 * timeline already live.
 */
export default async function DesignQaPage() {
  const context = await requireInternal('/design-qa');
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const workspaces = await listPhaseFourWorkspaces();
  const withVersions = workspaces.filter((w) => w.uiVersion !== null);
  const needsAttention = withVersions.filter((w) => !w.uiVersion?.qaReviewedAt || gapCount(w) > 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Design QA"
        description={
          withVersions.length === 0
            ? 'No project has drafted a UI version yet.'
            : `${needsAttention.length} of ${withVersions.length} UI version${withVersions.length === 1 ? '' : 's'} still ${needsAttention.length === 1 ? 'needs' : 'need'} attention.`
        }
      />

      {withVersions.length > 0 ? (
        <Card className="p-0">
          <DataTable rows={withVersions} columns={columnsFor(clock)} getKey={(r) => r.phaseFourId} href={(r) => `/projects/${r.projectId}`} />
        </Card>
      ) : (
        <EmptyState
          icon={<IconCheck size={22} />}
          title="Nothing to review yet"
          description="Design QA reviews a UI version the moment the UI Designer drafts one."
        />
      )}
    </div>
  );
}
