import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getApproval } from '@/modules/approvals/queries';
import { prototypeSendBlockers } from '@/modules/projects/build-details-schema';
import { readDeliverableDetails, readPrototypeSendGate } from '@/modules/projects/build-details-queries';
import { readDesignReviewComments } from '@/modules/projects/design-review-comments-queries';
import { listPrototypeBuilds } from '@/modules/projects/prototype-queries';
import { getProject, listDeliverables } from '@/modules/projects/queries';
import { listTestRuns } from '@/modules/qa/queries';
import { Badge, Card, CardHeader, DetailPanel, humanize, PageHeader, PermissionDenied, statusTone } from '@/ui';

import { ApprovalDecisionForm } from '../../../../../approvals/approval-decision-form';
import { DesignCommentThread } from '../../../design/design-comment-thread';
import { ProjectSubNav } from '../../../project-subnav';
import { PlatformPicker, SubmitToQaButton } from '../../prototype-panels';
import { BuildDetailsForm, PrototypeAdminForm, PrototypeQaForm, SendPrototypeForm } from '../../build-panels';

export const metadata: Metadata = { title: 'Prototype build' };

/**
 * SCR-037 — one prototype build: what it is (version, link, changelog,
 * platform, commit, rollback), where it stands against the two gates that
 * decide whether it may go to the client (QA passed, Admin approved), what
 * QA and the client have said, and the doors to move it: details, Admin's
 * decision, the gated send, and the client's answer recorded through the
 * approval engine. Every state shown is read from the database — the gate
 * from `projects.prototype_send_gate`, not a copy of its rule.
 */
export default async function PrototypeBuildPage({ params }: { params: Promise<{ projectId: string; deliverableId: string }> }) {
  const { projectId, deliverableId } = await params;

  const context = await requireInternal(`/projects/${projectId}/prototype/builds/${deliverableId}`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const all = await listDeliverables(projectId);
  const build = all.find((d) => d.id === deliverableId && d.kind === 'prototype');
  if (!build) notFound();

  const [clock, details, gate, artifacts, runs, approval, comments] = await Promise.all([
    agencyClock(),
    readDeliverableDetails(projectId),
    readPrototypeSendGate(deliverableId),
    listPrototypeBuilds(projectId),
    listTestRuns(projectId),
    build.approval_request_id ? getApproval(build.approval_request_id) : Promise.resolve(null),
    readDesignReviewComments(projectId),
  ]);
  const d = details.get(deliverableId) ?? null;
  const artifact = artifacts.find((a) => a.deliverableId === deliverableId) ?? null;
  const myRuns = runs.filter((r) => r.deliverableId === deliverableId).sort((a, b) => b.executedAt.localeCompare(a.executedAt));
  const siblings = all.filter((x) => x.kind === 'prototype');
  const builds = all.filter((x) => x.kind === 'build');
  const mayWrite = can(context, 'project.write');
  const maySignOff = can(context, 'project.sign_off');
  const blockers = prototypeSendBlockers(gate);
  const platform = d?.platform ?? artifact?.platform ?? null;
  const settled = ['in_review', 'approved', 'superseded'].includes(build.status);
  const rollbackTarget = d?.rollbackTargetId ? builds.find((b) => b.id === d.rollbackTargetId) : null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`Prototype v${build.version} — ${build.title}`}
        description={`${project.name} · added ${clock.dateTime(build.created_at)}`}
        actions={<Badge tone={statusTone(build.status)}>{humanize(build.status)}</Badge>}
      />
      <ProjectSubNav projectId={projectId} />
      <Link href={`/projects/${projectId}/prototype`} className="text-[13px] text-muted underline hover:text-foreground">
        All prototype builds
      </Link>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Gate to the Client" description="A prototype goes to the client on the normal path only when QA passed it and Admin approved it." />
            <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
              <ul className="flex flex-col gap-1.5 text-[13px]">
                <li className="flex items-center justify-between gap-2">
                  <span>QA passed</span>
                  <Badge tone={gate.qaPassed ? 'success' : 'warning'}>{gate.qaPassed ? `Passed (${gate.qaSource})` : 'Not passed'}</Badge>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <span>Admin approved</span>
                  <Badge tone={gate.adminApproved ? 'success' : d?.adminStatus === 'changes_required' ? 'danger' : 'warning'}>
                    {gate.adminApproved ? 'Approved' : d?.adminStatus === 'changes_required' ? 'Changes requested' : 'Not decided'}
                  </Badge>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <span>With the client</span>
                  <Badge tone={build.status === 'in_review' ? 'info' : build.status === 'approved' ? 'success' : 'neutral'}>{build.status === 'draft' ? 'Not sent' : humanize(build.status)}</Badge>
                </li>
              </ul>
              {d?.adminNote ? <p className="rounded-md bg-surface-sunken px-3 py-2 text-[13px]">Admin note: {d.adminNote}</p> : null}
              {mayWrite && !settled ? <SendPrototypeForm projectId={projectId} deliverableId={deliverableId} blockers={blockers} mayOverride={can(context, 'project.sign_off') && context.roles.includes('owner')} /> : null}
              {settled ? <p className="text-[13px] text-muted">This build is {humanize(build.status).toLowerCase()}; it is not sent again.</p> : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="QA Evidence" />
            <div className="flex flex-col gap-2 px-4 pb-4 text-[13px] sm:px-5">
              {artifact ? (
                <p>
                  Prototype QA verdict:{' '}
                  {artifact.qaReviewedAt ? <Badge tone={artifact.qaFindings?.verdict === 'pass' ? 'success' : 'warning'}>{artifact.qaFindings?.verdict ?? 'recorded'}</Badge> : <span className="text-muted">none recorded</span>}
                  {artifact.qaSubmittedAt ? <span className="text-muted"> · submitted to QA {clock.dateTime(artifact.qaSubmittedAt)}</span> : <span className="text-muted"> · not submitted to QA</span>}
                </p>
              ) : (
                <p className="text-muted">No Prototype Agent build is recorded against this version, so QA is a check a person records below.</p>
              )}
              <p>
                QA check by a person:{' '}
                {d && d.qaStatus !== 'not_reviewed' ? (
                  <>
                    <Badge tone={d.qaStatus === 'passed' ? 'success' : 'warning'}>{d.qaStatus === 'passed' ? 'Passed' : 'Changes required'}</Badge>
                    {d.qaDecidedAt ? <span className="text-muted"> · {clock.dateTime(d.qaDecidedAt)}</span> : null}
                    {d.qaNote ? <span className="block text-muted">{d.qaNote}</span> : null}
                    {d.qaEvidenceUrl ? <a href={d.qaEvidenceUrl} target="_blank" rel="noreferrer noopener" className="block break-all underline">{d.qaEvidenceUrl}</a> : null}
                  </>
                ) : (
                  <span className="text-muted">none recorded</span>
                )}
              </p>
              {myRuns.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {myRuns.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-1.5">
                      <span>
                        {r.suite}: <span className={r.failed > 0 ? 'text-danger' : 'text-success'}>{r.passed}/{r.total} passed</span>
                      </span>
                      <span className="text-xs text-muted">{clock.dateTime(r.executedAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {mayWrite && !settled && d?.qaStatus !== 'passed' ? (
                <div className="flex flex-col gap-1 border-t border-line pt-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">Record a QA check</span>
                  <PrototypeQaForm projectId={projectId} deliverableId={deliverableId} />
                </div>
              ) : null}
              {mayWrite && artifact && !artifact.qaSubmittedAt ? <SubmitToQaButton projectId={projectId} artifactId={artifact.artifactId} /> : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Client Decision" description="The client's answer is recorded here with where they gave it — it is not inferred." />
            <div className="flex flex-col gap-3 px-4 pb-4 text-[13px] sm:px-5">
              {approval ? (
                <>
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={statusTone(approval.state)}>{humanize(approval.state)}</Badge>
                    <span className="text-muted">
                      {approval.summary ?? 'Approval request'} · requires {approval.required_role.replace(/_/g, ' ')} · due {clock.dateTime(approval.sla_due_at)}
                    </span>
                  </p>
                  {approval.state === 'pending' ? (
                    <div className="rounded-md border border-line bg-surface-sunken px-3 py-2">
                      <p className="font-medium">Record the client&apos;s answer: approve, or send back with what they want changed.</p>
                      <ApprovalDecisionForm requestId={approval.id} audience={approval.audience} subjectType={approval.subject_type} />
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-muted">The build has not been sent to the client, so there is no answer to record yet.</p>
              )}
              {artifact && artifact.clientFeedback.length > 0 ? (
                <ul className="flex flex-col gap-1.5">
                  {artifact.clientFeedback.map((f, i) => (
                    <li key={`${i}-${f.createdAt}`} className="rounded-md border border-line px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        <Badge tone={f.decision === 'final_confirmed' ? 'success' : 'warning'}>{humanize(f.decision)}</Badge>
                        <span className="text-xs text-muted">{clock.dateTime(f.createdAt)}</span>
                      </span>
                      <span>“{f.clientWords}”</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Review Comments" />
            <div className="px-4 pb-4 sm:px-5">
              <DesignCommentThread projectId={projectId} subjectType="deliverable" subjectId={deliverableId} comments={comments.get(deliverableId) ?? []} canComment={can(context, 'task.write')} formatDateTime={(iso) => clock.dateTime(iso)} />
            </div>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <DetailPanel
            title="Build"
            rows={[
              { label: 'Version', value: `v${build.version}` },
              { label: 'Platform', value: platform ? platform.replace('_', ' ') : <span className="text-muted">Not set</span> },
              { label: 'Commit or ref', value: d?.commitRef ? <span className="font-mono text-xs">{d.commitRef}</span> : <span className="text-muted">Not recorded</span> },
              { label: 'Build number', value: d?.buildNumber ?? <span className="text-muted">Not recorded</span> },
              { label: 'Roll back to', value: rollbackTarget ? `Build v${rollbackTarget.version} — ${rollbackTarget.title}` : <span className="text-muted">Not recorded</span> },
              { label: 'Artifact', value: build.artifact_url ? <a href={build.artifact_url} target="_blank" rel="noreferrer noopener" className="break-all underline">{build.artifact_url}</a> : <span className="text-muted">No link</span> },
              { label: 'UI version', value: artifact?.uiVersion ? `v${artifact.uiVersion}` : <span className="text-muted">None</span> },
              { label: 'Revisions', value: artifact ? `${artifact.revisionCount}` : <span className="text-muted">—</span> },
            ]}
          />
          {build.changelog ? (
            <Card>
              <CardHeader title="Changelog" />
              <p className="whitespace-pre-wrap px-4 pb-4 text-[13px] text-muted sm:px-5">{build.changelog}</p>
            </Card>
          ) : null}
          {mayWrite ? (
            <Card>
              <CardHeader title="Edit Details" description="Platform, where it was built from and how to roll it back." />
              <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
                <BuildDetailsForm
                  projectId={projectId}
                  deliverableId={deliverableId}
                  showPlatform
                  current={{ platform: d?.platform ?? null, commitRef: d?.commitRef ?? null, buildNumber: d?.buildNumber ?? null, rollbackTargetId: d?.rollbackTargetId ?? null, rollbackNote: d?.rollbackNote ?? null }}
                  rollbackChoices={builds.map((b) => ({ id: b.id, label: `Build v${b.version} — ${b.title}` }))}
                />
                {artifact ? (
                  <div className="flex flex-col gap-1 border-t border-line pt-2">
                    <span className="text-xs text-muted">Platform recorded on the Prototype Agent build</span>
                    <PlatformPicker projectId={projectId} artifactId={artifact.artifactId} current={artifact.platform} />
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}
          {maySignOff ? (
            <Card>
              <CardHeader title="Admin Decision" description="Confirm the prototype, or send it back with what must change." />
              <div className="px-4 pb-4 sm:px-5">
                <PrototypeAdminForm projectId={projectId} deliverableId={deliverableId} />
              </div>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Other Versions" />
            <ul className="flex flex-col divide-y divide-line px-4 pb-3 text-[13px] sm:px-5">
              {siblings.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 py-1.5">
                  <Link href={`/projects/${projectId}/prototype/builds/${s.id}`} className={s.id === deliverableId ? 'font-semibold' : 'text-brand hover:underline'}>
                    v{s.version} — {s.title}
                  </Link>
                  <Badge tone={statusTone(s.status)}>{humanize(s.status)}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
