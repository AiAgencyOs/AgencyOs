import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPrototypeBuilds, type PrototypeBuildRow } from '@/modules/projects/queries';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  humanize,
  IconProjects,
  PageHeader,
  Stat,
  StatGrid,
  statusTone,
  type Column,
} from '@/ui';

import { RevisionTimeline } from '../projects/[projectId]/phase-four-panel';

export const metadata: Metadata = { title: 'Prototypes' };

function findingsCount(row: PrototypeBuildRow): number {
  return (row.qaFindings?.missingScreens?.length ?? 0) + (row.qaFindings?.brokenRoutes?.length ?? 0);
}

// Deliverable status vocabulary (20260813120001) mapped through the shared
// `statusTone` word list, so the revision timeline's badges read the same
// tones as the table above rather than inventing a second palette.
const DELIVERABLE_STATUS_TONE = {
  draft: statusTone('draft'),
  in_review: statusTone('review'),
  approved: statusTone('approved'),
  changes_requested: statusTone('rejected'),
  superseded: statusTone('superseded'),
};

const buildColumns: Column<PrototypeBuildRow>[] = [
  { key: 'project', header: 'Project', primary: true, cell: (r) => r.projectName },
  { key: 'version', header: 'Version', cell: (r) => `v${r.version}` },
  { key: 'status', header: 'Status', badge: true, cell: (r) => <Badge tone={statusTone(r.status)}>{humanize(r.status)}</Badge> },
  {
    key: 'coverage',
    header: 'QA findings',
    cell: (r) =>
      r.qaReviewedAt ? (
        findingsCount(r) > 0 ? (
          <span className="text-danger">{findingsCount(r)} open</span>
        ) : (
          <span className="text-success">clear</span>
        )
      ) : (
        <span className="text-muted">not reviewed</span>
      ),
  },
];

/**
 * P4-PROTO-ADMINUI, remaining surfaces — Overview, Build History, Coverage,
 * Artifacts, Limitations, Blockers and Revision Timeline, all from the exact
 * same read (`listPrototypeBuilds`): `projects.deliverables` (kind=
 * 'prototype') joined to `projects.prototype_artifacts` for the QA verdict
 * each build already carries. The per-project prototype page
 * (`/projects/[projectId]/prototype`) already shows one project's builds in
 * full; this is the org-wide rollup that page never offered, the same
 * relationship `/qa` has to each project's own QA panel and `/projects/
 * escalations` has to each project's own Phase 4 panel.
 *
 * Read-only, gated on `project.read` like every other Phase 4 admin surface
 * — nothing here writes; a build moves through the real doors
 * (`SubmitDeliverableForm`, the QA handler, the client review forms) on the
 * per-project page, never from an org-wide list.
 */
export default async function PrototypesPage() {
  const context = await requireInternal('/prototypes');
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const builds = await listPrototypeBuilds();

  const inReview = builds.filter((b) => b.status === 'in_review').length;
  const approved = builds.filter((b) => b.status === 'approved').length;
  const blocked = builds.filter((b) => b.status === 'changes_requested');
  const withArtifact = builds.filter((b) => b.artifactUrl);
  const withLimitations = builds.filter((b) => b.knownIssues);

  const byProject = new Map<string, { projectId: string; projectName: string; rounds: PrototypeBuildRow[] }>();
  for (const b of builds) {
    const entry = byProject.get(b.projectId) ?? { projectId: b.projectId, projectName: b.projectName, rounds: [] };
    entry.rounds.push(b);
    byProject.set(b.projectId, entry);
  }
  const timelines = [...byProject.values()]
    .map((p) => ({ ...p, rounds: [...p.rounds].sort((a, c) => a.version - c.version) }))
    .filter((p) => p.rounds.length > 1);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Prototypes"
        description={
          builds.length === 0
            ? 'No prototype builds recorded across any project yet.'
            : `${builds.length} build${builds.length === 1 ? '' : 's'} across every project.`
        }
      />

      {builds.length === 0 ? (
        <EmptyState
          icon={<IconProjects size={22} />}
          title="No prototype builds yet"
          description="A build added on any project's Prototype page will show up here."
        />
      ) : (
        <>
          <StatGrid>
            <Stat label="Total builds" value={String(builds.length)} />
            <Stat label="In review" value={String(inReview)} tone={inReview > 0 ? 'warning' : 'neutral'} />
            <Stat label="Approved" value={String(approved)} tone="success" />
            <Stat label="Changes requested" value={String(blocked.length)} tone={blocked.length > 0 ? 'danger' : 'neutral'} />
          </StatGrid>

          <Card className="p-4 sm:p-5">
            <h2 className="text-sm font-semibold">Build history</h2>
            <div className="mt-3">
              <DataTable
                rows={builds}
                columns={buildColumns}
                getKey={(r) => r.id}
                href={(r) => `/projects/${r.projectId}/prototype`}
              />
            </div>
          </Card>

          <Card className="p-4 sm:p-5">
            <h2 className="text-sm font-semibold">Blockers — changes requested</h2>
            {blocked.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-2">
                {blocked.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                    <span>
                      {b.projectName} — v{b.version}
                    </span>
                    <span className="text-xs text-muted">{clock.dateTime(b.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[13px] text-muted">No prototype build is currently waiting on changes.</p>
            )}
          </Card>

          <Card className="p-4 sm:p-5">
            <h2 className="text-sm font-semibold">Artifacts</h2>
            {withArtifact.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-1.5 text-[13px]">
                {withArtifact.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {b.projectName} — v{b.version}
                    </span>
                    <a
                      href={b.artifactUrl!}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="break-all text-xs underline underline-offset-2"
                    >
                      {b.artifactUrl}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[13px] text-muted">No build has a linked artifact yet.</p>
            )}
          </Card>

          <Card className="p-4 sm:p-5">
            <h2 className="text-sm font-semibold">Limitations</h2>
            {withLimitations.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-2 text-[13px]">
                {withLimitations.map((b) => (
                  <li key={b.id}>
                    <span className="font-medium">
                      {b.projectName} — v{b.version}:
                    </span>{' '}
                    <span className="text-muted">{b.knownIssues}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[13px] text-muted">No build has recorded known issues.</p>
            )}
          </Card>

          {timelines.length > 0 ? (
            <Card className="p-4 sm:p-5">
              <h2 className="text-sm font-semibold">Revision timelines</h2>
              <ul className="mt-3 flex flex-col gap-2">
                {timelines.map((p) => (
                  <li key={p.projectId} className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="font-medium">{p.projectName}</span>
                    <RevisionTimeline rounds={p.rounds} tone={DELIVERABLE_STATUS_TONE} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
