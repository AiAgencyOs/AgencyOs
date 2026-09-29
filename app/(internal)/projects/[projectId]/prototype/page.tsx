import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getApproval } from '@/modules/approvals/queries';
import { getProject, listDeliverables } from '@/modules/projects/queries';
import { listTestRuns } from '@/modules/qa/queries';
import { Badge, Card, DataTable, EmptyState, humanize, IconProjects, PageHeader, statusTone, PermissionDenied, Stat, StatGrid, IconCheck, IconClock, IconAlert } from '@/ui';

import { AddPrototypeForm, SubmitDeliverableForm } from '../deliverables-panel';
import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Prototype' };

/**
 * SCR-037 — Prototype Builds & Review. Confirmed genuinely missing as a
 * *screen* by the traceability sweep, but not as backend: `projects.deliverables`
 * has carried `kind = 'prototype'` with a version sequence, an artifact link
 * and the same client-review flow every other deliverable kind gets since
 * 20260813, and the Overview page has listed it — mixed in with design and
 * build versions — the whole time. This filters that same reader to one kind
 * and adds nothing new underneath it, the same relationship Board (SCR-020)
 * has to the Development page's task list.
 */
export default async function PrototypePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/prototype`);
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const canWrite = can(context.role, 'project.write');
  const builds = (await listDeliverables(projectId)).filter((d) => d.kind === 'prototype');
  const [runs, approvals] = await Promise.all([
    listTestRuns(projectId),
    Promise.all(builds.map((b) => (b.approval_request_id ? getApproval(b.approval_request_id) : Promise.resolve(null)))),
  ]);
  const latestRun = (deliverableId: string) => runs.filter((r) => r.deliverableId === deliverableId).sort((a, b) => b.executedAt.localeCompare(a.executedAt))[0] ?? null;
  const approvalFor = new Map(builds.map((b, i) => [b.id, approvals[i] ?? null]));
  const inReview = builds.filter((b) => ['client_review', 'submitted', 'pending_approval'].includes(b.status)).length;
  const approved = builds.filter((b) => ['approved', 'client_approved', 'accepted'].includes(b.status)).length;
  const withRuns = builds.filter((b) => latestRun(b.id)).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Prototype`}
        description={builds.length === 0 ? 'No prototype builds yet.' : `${builds.length} version${builds.length === 1 ? '' : 's'}.`}
      />

      <ProjectSubNav projectId={projectId} />

      {builds.length > 0 ? (
        <StatGrid cols={4}>
          <Stat label="Builds" value={String(builds.length)} caption={`latest v${builds[0]?.version ?? 0}`} tone="brand" icon={<IconProjects size={16} />} />
          <Stat label="In review" value={String(inReview)} caption="Awaiting a decision" tone={inReview > 0 ? 'info' : 'neutral'} icon={<IconClock size={16} />} />
          <Stat label="Approved" value={String(approved)} caption="Client or admin sign-off" tone="success" icon={<IconCheck size={16} />} />
          <Stat label="With a QA run" value={String(withRuns)} caption={withRuns < builds.length ? `${builds.length - withRuns} untested` : 'Every build tested'} tone={withRuns < builds.length ? 'warning' : 'success'} icon={<IconAlert size={16} />} />
        </StatGrid>
      ) : null}

      {builds.length > 0 ? (
        <DataTable
          rows={builds}
          dense
          columns={[
            { key: 'version', header: 'Build', primary: true, cell: (b) => `v${b.version} — ${b.title}` },
            { key: 'status', header: 'Client decision', badge: true, cell: (b) => <Badge tone={statusTone(b.status)}>{humanize(b.status)}</Badge> },
            {
              key: 'qa',
              header: 'QA',
              cell: (b) => {
                const run = latestRun(b.id);
                if (!run) return <span className="text-xs text-muted">no run</span>;
                return (
                  <span className="text-xs">
                    <span className={run.failed > 0 ? 'text-danger' : 'text-success'}>{run.passed}/{run.total} passed</span>
                    <span className="text-muted"> · {run.suite}</span>
                  </span>
                );
              },
            },
            {
              key: 'approval',
              header: 'Approval',
              badge: true,
              cell: (b) => {
                const a = approvalFor.get(b.id);
                return a ? <Badge tone={statusTone(a.state)}>{humanize(a.state)}</Badge> : <span className="text-xs text-muted">none raised</span>;
              },
            },
            { key: 'added', header: 'Added', align: 'right', cellClassName: 'text-muted', cell: (b) => clock.date(b.created_at) },
          ]}
          getKey={(b) => b.id}
        />
      ) : null}

      {builds.length > 0 ? (
        <div className="flex flex-col gap-2">
          {builds.map((b) => (
            <Card key={b.id} className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-foreground">
                  v{b.version} — {b.title}
                </span>
                <Badge tone={statusTone(b.status)}>{humanize(b.status)}</Badge>
              </div>
              {b.changelog ? <p className="mt-1 text-sm text-muted">{b.changelog}</p> : null}
              {b.known_issues ? <p className="mt-1 text-xs text-warning">Known issues: {b.known_issues}</p> : null}
              {b.artifact_url ? (
                <a
                  href={b.artifact_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1 inline-block break-all text-xs underline underline-offset-2"
                >
                  {b.artifact_url}
                </a>
              ) : null}
              <p className="mt-1 text-xs text-faint">Added {clock.dateTime(b.created_at)}</p>
              {canWrite && b.status === 'draft' ? (
                <SubmitDeliverableForm deliverableId={b.id} projectId={projectId} />
              ) : null}
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<IconProjects size={22} />}
          title="No prototype builds yet"
          description="Add the first build below once it's ready to review."
        />
      )}

      {canWrite ? (
        <Card className="p-4">
          <AddPrototypeForm projectId={projectId} />
        </Card>
      ) : null}
    </div>
  );
}
