import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getApproval } from '@/modules/approvals/queries';
import { getProject, listDeliverables } from '@/modules/projects/queries';
import { Badge, Card, EmptyState, humanize, IconProjects, PageHeader, statusTone } from '@/ui';

import { ApprovalDecisionForm } from '../../../approvals/approval-decision-form';
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
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const canWrite = can(context.role, 'project.write');
  const builds = (await listDeliverables(projectId)).filter((d) => d.kind === 'prototype');
  // SCR-037 — a build's pending approval, decided here rather than on
  // /approvals. The request is read by id; the same `ApprovalDecisionForm`
  // the approvals page uses is drawn, and `approvals.decide_approval` holds
  // the role check under its lock exactly as it does there.
  const pendingApprovals = new Map(
    (
      await Promise.all(
        builds
          .filter((b) => b.approval_request_id !== null)
          .map(async (b) => [b.id, await getApproval(b.approval_request_id as string)] as const),
      )
    ).filter(([, request]) => request?.state === 'pending'),
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Prototype`}
        description={builds.length === 0 ? 'No prototype builds yet.' : `${builds.length} version${builds.length === 1 ? '' : 's'}.`}
      />

      <ProjectSubNav projectId={projectId} />

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
              {(() => {
                const request = pendingApprovals.get(b.id);
                if (!request) return null;
                return (
                  <div className="mt-2 rounded-md border border-line bg-surface-sunken px-3 py-2">
                    <p className="text-[13px]">
                      <span className="font-medium">Awaiting {request.audience} approval</span>
                      <span className="text-muted">
                        {' '}
                        — {request.summary ?? 'no summary'} · requires {request.required_role.replace(/_/g, ' ')} · due{' '}
                        {clock.dateTime(request.sla_due_at)}
                      </span>
                    </p>
                    <ApprovalDecisionForm requestId={request.id} audience={request.audience} subjectType={request.subject_type} />
                  </div>
                );
              })()}
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
