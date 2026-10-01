import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getApproval } from '@/modules/approvals/queries';
import { readDeliverableDetails, readPrototypeSendGate } from '@/modules/projects/build-details-queries';
import { prototypeSendBlockers } from '@/modules/projects/build-details-schema';
import { listPrototypeBuilds } from '@/modules/projects/prototype-queries';
import { PROTOTYPE_PLATFORMS } from '@/modules/projects/prototype-schema';
import { getProject, listDeliverables } from '@/modules/projects/queries';
import { listTestRuns } from '@/modules/qa/queries';
import Link from 'next/link';

import { Badge, buttonClass, Card, CardHeader, DataTable, EmptyState, humanize, IconProjects, labelClass, PageHeader, selectClass, inputClass, statusTone, PermissionDenied, Stat, StatGrid, IconCheck, IconClock, IconAlert } from '@/ui';

import { ApprovalDecisionForm } from '../../../approvals/approval-decision-form';
import { PreviewButton, PreviewDrawerProvider } from '../../../preview-drawer';
import { AddPrototypeForm } from '../deliverables-panel';
import { ProjectSubNav } from '../project-subnav';
import { PlatformPicker, SubmitToQaButton } from './prototype-panels';
import { SendPrototypeForm } from './build-panels';

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
 *
 * Bucket F (migration 20261001130000): the Prototype Agent's builds
 * (`prototype_artifacts`) are listed here with their platform (set by a
 * person), their revision count, their QA evidence (the coverage verdict,
 * and when a person submitted the build to QA) and what the client said
 * about the UI version each was built from — all read, none inferred.
 */
export default async function PrototypePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ q?: string; status?: string; platform?: string; qa?: string }> }) {
  const { projectId } = await params;
  const { q: qRaw, status: statusRaw, platform: platformRaw, qa: qaRaw } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/prototype`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const clock = await agencyClock();
  const canWrite = can(context, 'project.write');
  const allBuilds = (await listDeliverables(projectId)).filter((d) => d.kind === 'prototype');
  const [runs, approvals, artifacts, details, gates] = await Promise.all([
    listTestRuns(projectId),
    Promise.all(allBuilds.map((b) => (b.approval_request_id ? getApproval(b.approval_request_id) : Promise.resolve(null)))),
    listPrototypeBuilds(projectId),
    readDeliverableDetails(projectId),
    Promise.all(allBuilds.map((b) => readPrototypeSendGate(b.id))),
  ]);
  const gateOf = new Map(allBuilds.map((b, i) => [b.id, gates[i]!]));
  const platformOf = (id: string) => details.get(id)?.platform ?? artifacts.find((a) => a.deliverableId === id)?.platform ?? null;
  const revisionsOf = (id: string) => artifacts.find((a) => a.deliverableId === id)?.revisionCount ?? null;
  const q = (qRaw ?? '').trim().slice(0, 120).toLowerCase();
  const statusFilter = ['draft', 'in_review', 'approved', 'changes_requested'].includes(statusRaw ?? '') ? (statusRaw as string) : '';
  const platformFilter = (PROTOTYPE_PLATFORMS as readonly string[]).includes(platformRaw ?? '') ? (platformRaw as string) : '';
  const qaFilter = qaRaw === 'passed' || qaRaw === 'not_passed' ? qaRaw : '';
  const builds = allBuilds.filter(
    (b) =>
      (!q || `${b.title} v${b.version}`.toLowerCase().includes(q))
      && (!statusFilter || b.status === statusFilter)
      && (!platformFilter || platformOf(b.id) === platformFilter)
      && (!qaFilter || (qaFilter === 'passed') === Boolean(gateOf.get(b.id)?.qaPassed)),
  );
  const withPlatform = artifacts.filter((a) => a.platform).length;
  const submittedToQa = artifacts.filter((a) => a.qaSubmittedAt).length;
  const latestRun = (deliverableId: string) => runs.filter((r) => r.deliverableId === deliverableId).sort((a, b) => b.executedAt.localeCompare(a.executedAt))[0] ?? null;
  const approvalFor = new Map(builds.map((b, i) => [b.id, approvals[i] ?? null]));
  const inReview = allBuilds.filter((b) => b.status === 'in_review').length;
  const approved = allBuilds.filter((b) => b.status === 'approved').length;
  const withRuns = allBuilds.filter((b) => latestRun(b.id)).length;
  const qaPassed = allBuilds.filter((b) => gateOf.get(b.id)?.qaPassed).length;
  const adminApproved = allBuilds.filter((b) => gateOf.get(b.id)?.adminApproved).length;
  const mayOverride = can(context, 'project.sign_off') && context.roles.includes('owner');

  return (
    <PreviewDrawerProvider>
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Prototype`}
        description={allBuilds.length === 0 ? 'No prototype builds yet.' : `${allBuilds.length} version${allBuilds.length === 1 ? '' : 's'}.`}
      />

      <ProjectSubNav projectId={projectId} />

      {allBuilds.length > 0 ? (
        <StatGrid cols={4}>
          <Stat label="Builds" value={String(allBuilds.length)} caption={`latest v${allBuilds[0]?.version ?? 0}`} tone="brand" icon={<IconProjects size={16} />} />
          <Stat label="With the Client" value={String(inReview)} caption="Awaiting the client's decision" tone={inReview > 0 ? 'info' : 'neutral'} icon={<IconClock size={16} />} />
          <Stat label="Approved" value={String(approved)} caption="Client sign-off" tone="success" icon={<IconCheck size={16} />} />
          <Stat label="QA Passed" value={String(qaPassed)} caption={`${adminApproved} Admin approved · ${withRuns} with a run`} tone={qaPassed < allBuilds.length ? 'warning' : 'success'} icon={<IconAlert size={16} />} />
        </StatGrid>
      ) : null}

      {allBuilds.length > 0 ? (
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Search builds</span>
            <input name="q" defaultValue={qRaw ?? ''} maxLength={120} placeholder="Title or version" className={`${inputClass} w-52`} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Status</span>
            <select name="status" defaultValue={statusFilter} className={selectClass}>
              <option value="">Any status</option>
              {['draft', 'in_review', 'approved', 'changes_requested'].map((st) => (
                <option key={st} value={st}>{humanize(st)}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Platform</span>
            <select name="platform" defaultValue={platformFilter} className={selectClass}>
              <option value="">Any platform</option>
              {PROTOTYPE_PLATFORMS.map((pl) => (
                <option key={pl} value={pl}>{pl.replace('_', ' ')}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>QA</span>
            <select name="qa" defaultValue={qaFilter} className={selectClass}>
              <option value="">Any QA state</option>
              <option value="passed">QA passed</option>
              <option value="not_passed">QA not passed</option>
            </select>
          </label>
          <button type="submit" className={buttonClass('secondary', 'sm')}>Apply</button>
          {q || statusFilter || platformFilter || qaFilter ? <Link href={`/projects/${projectId}/prototype`} className="pb-2 text-xs underline hover:text-foreground">Clear</Link> : null}
        </form>
      ) : null}

      {allBuilds.length > 0 && builds.length === 0 ? <EmptyState icon={<IconProjects size={22} />} title="No build matches" description="Nothing in the list fits that search or filter." action={<Link href={`/projects/${projectId}/prototype`} className={buttonClass('secondary', 'sm')}>Clear filters</Link>} /> : null}

      {builds.length > 0 ? (
        <DataTable
          rows={builds}
          dense
          columns={[
            { key: 'version', header: 'Build', primary: true, cell: (b) => <Link href={`/projects/${projectId}/prototype/builds/${b.id}`} className="font-medium text-brand hover:underline">{`v${b.version} — ${b.title}`}</Link> },
            { key: 'platform', header: 'Platform', desktopOnly: true, cell: (b) => (platformOf(b.id) ? <Badge tone="info" dot={false}>{platformOf(b.id)?.replace('_', ' ')}</Badge> : <span className="text-xs text-muted">not set</span>) },
            { key: 'status', header: 'Client decision', badge: true, cell: (b) => <Badge tone={statusTone(b.status)}>{humanize(b.status)}</Badge> },
            { key: 'admin', header: 'Admin', badge: true, cell: (b) => { const st = details.get(b.id)?.adminStatus ?? 'pending'; return <Badge tone={st === 'approved' ? 'success' : st === 'changes_required' ? 'danger' : 'neutral'}>{st === 'pending' ? 'Not decided' : humanize(st)}</Badge>; } },
            { key: 'revisions', header: 'Revisions', align: 'right', desktopOnly: true, cellClassName: 'tabular', cell: (b) => revisionsOf(b.id) ?? '—' },
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
            { key: 'quick', header: '', align: 'right', cell: (b) => <PreviewButton group="Build" id={b.id} /> },
          ]}
          getKey={(b) => b.id}
        />
      ) : null}

      {/* SCR-037 — the Prototype Agent's builds: platform, revisions, QA evidence, client feedback, submit to QA. */}
      <Card>
        <CardHeader
          title={`Prototype builds (${artifacts.length})`}
          description={artifacts.length === 0 ? 'The structured builds the Prototype Agent records against a locked UI version. None yet.' : `${withPlatform} with a platform · ${submittedToQa} submitted to QA · revisions counted per UI version.`}
        />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          {artifacts.length === 0 ? (
            <p className="text-[13px] text-muted">A build appears here once a UI version is locked and the Prototype Agent records it.</p>
          ) : (
            artifacts.map((a) => {
              const run = latestRun(a.deliverableId);
              const flags = Array.isArray(a.qaFindings?.flags) ? a.qaFindings.flags.length : 0;
              return (
                <div key={a.artifactId} className="flex flex-col gap-2 rounded-md border border-line p-3 text-[13px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        v{a.version} — {a.title}
                      </span>
                      <Badge tone={statusTone(a.status)}>{humanize(a.status)}</Badge>
                      {a.uiVersion !== null ? <Badge tone="neutral">UI version {a.uiVersion}</Badge> : null}
                      <Badge tone="neutral">{a.revisionCount} revision{a.revisionCount === 1 ? '' : 's'}</Badge>
                      <Badge tone={a.platform ? 'info' : 'warning'}>{a.platform ? a.platform.replace('_', ' ') : 'platform not set'}</Badge>
                    </span>
                    <span className="text-xs text-muted">
                      {a.screensCount} screen{a.screensCount === 1 ? '' : 's'} · recorded {clock.dateTime(a.createdAt)}
                    </span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex flex-col gap-1 rounded-md border border-line bg-surface p-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">QA evidence</span>
                      <span>
                        {a.qaReviewedAt ? (
                          <>
                            Coverage check {a.qaFindings?.verdict ? <Badge tone={a.qaFindings.verdict === 'pass' ? 'success' : 'warning'}>{a.qaFindings.verdict}</Badge> : null} · {flags} flag{flags === 1 ? '' : 's'} · {clock.dateTime(a.qaReviewedAt)}
                          </>
                        ) : (
                          <span className="text-muted">No coverage check recorded.</span>
                        )}
                      </span>
                      <span>
                        {run ? (
                          <>
                            Latest run <span className={run.failed > 0 ? 'text-danger' : 'text-success'}>{run.passed}/{run.total} passed</span> · {run.suite}
                          </>
                        ) : (
                          <span className="text-muted">No test run recorded against this build.</span>
                        )}
                      </span>
                      <span className="text-xs text-muted">{a.qaSubmittedAt ? `Submitted to QA ${clock.dateTime(a.qaSubmittedAt)}` : 'Not submitted to QA.'}</span>
                    </div>
                    <div className="flex flex-col gap-1 rounded-md border border-line bg-surface p-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Client feedback</span>
                      {a.clientFeedback.length === 0 ? (
                        <span className="text-muted">The client has not replied on this UI version.</span>
                      ) : (
                        <ul className="flex flex-col gap-1">
                          {a.clientFeedback.map((f, i) => (
                            <li key={`${a.artifactId}-${i}`} className="flex flex-col">
                              <span className="flex items-center gap-2">
                                <Badge tone={f.decision === 'final_confirmed' ? 'success' : 'warning'}>{humanize(f.decision)}</Badge>
                                <span className="text-xs text-muted">{clock.dateTime(f.createdAt)}</span>
                              </span>
                              <span>“{f.clientWords}”</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                  {canWrite ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <PlatformPicker projectId={projectId} artifactId={a.artifactId} current={a.platform} />
                      {!a.qaSubmittedAt ? <SubmitToQaButton projectId={projectId} artifactId={a.artifactId} /> : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </Card>

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
                <div className="mt-2">
                  <SendPrototypeForm projectId={projectId} deliverableId={b.id} blockers={prototypeSendBlockers(gateOf.get(b.id) ?? { qaPassed: false, adminApproved: false, qaSource: 'no QA evidence' })} mayOverride={mayOverride} />
                </div>
              ) : null}
              <Link href={`/projects/${projectId}/prototype/builds/${b.id}`} className="mt-1 inline-block text-xs text-brand hover:underline">Open the build</Link>
              {(() => {
                // SCR-037 — a pending approval is decided here rather than on
                // /approvals. The same form; `approvals.decide_approval` holds
                // the role check under its lock exactly as it does there.
                const request = approvalFor.get(b.id);
                if (!request || request.state !== 'pending') return null;
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
    </PreviewDrawerProvider>
  );
}
