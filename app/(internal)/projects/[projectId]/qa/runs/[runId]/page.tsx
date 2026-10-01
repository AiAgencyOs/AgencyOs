import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listAttachedFiles } from '@/modules/projects/attached-files-queries';
import { getProject, listDeliverables, listInternalRoster } from '@/modules/projects/queries';
import { listTestCaseResults } from '@/modules/qa/case-results-queries';
import { readRunDetail } from '@/modules/qa/run-detail-queries';
import { readTestPlan } from '@/modules/qa/queries';
import { Badge, Card, CardHeader, DetailList, DetailRow, EmptyState, IconCheck, PageHeader, PermissionDenied, humanize, statusTone } from '@/ui';

import { AttachFileForm } from '../../../attach-file-form';
import { AttachedFileLinks } from '../../../attached-file-links';
import { ProjectSubNav } from '../../../project-subnav';
import { RaiseDefectForm } from '../../../qa-panel';
import { AddEvidenceForm, CloseRunForm, MetricForm, RerunButton } from '../../run-lifecycle-panel';

export const metadata: Metadata = { title: 'Test Run' };

const KIND_LABEL: Record<string, string> = { screenshot: 'Screenshot', log: 'Log', report: 'Report', recording: 'Recording', note: 'Note' };

/**
 * SCR-046 — one test run's page ("drawer for run detail"): which build, where
 * (environment, device, browser, OS), who ran it and who recorded it, every
 * piece of evidence, the per-case results, the defects it found, the metrics
 * attached to it and its chain of reruns. Evidence is added here at any time,
 * open run or closed: `qa.add_run_evidence` never rewrites the run. Gated on
 * project.read like the QA tab it hangs off; a run from another project is a 404.
 */
export default async function RunDetailPage({ params }: { params: Promise<{ projectId: string; runId: string }> }) {
  const { projectId, runId } = await params;

  const context = await requireInternal(`/projects/${projectId}/qa/runs/${runId}`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const run = await readRunDetail(projectId, runId);
  if (!run) notFound();

  const [clock, caseResults, plan, deliverables, roster, attachedFiles] = await Promise.all([
    agencyClock(),
    listTestCaseResults(projectId),
    readTestPlan(projectId),
    listDeliverables(projectId),
    listInternalRoster(),
    // Q-C6: the evidence files uploaded against this run.
    listAttachedFiles(projectId),
  ]);
  void roster;
  const canRecord = can(context, 'task.write');
  const canWrite = can(context, 'project.write');
  const caseTitle = (itemId: string) => plan?.items.find((i) => i.id === itemId)?.scopeItemTitle ?? 'A case that is no longer in the plan';
  const cases = caseResults.get(runId) ?? run.cases.map((c) => ({ id: c.id, testRunId: runId, testPlanItemId: c.testPlanItemId, status: c.status, notes: c.notes, evidenceUrl: c.evidenceUrl, executedAt: run.executedAt }));
  const base = `/projects/${projectId}/qa`;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow={
          <Link href={`${base}#run-lifecycle`} className="hover:underline">
            {project.name} · QA · runs
          </Link>
        }
        title={`${humanize(run.suite)} run`}
        description={`${run.buildTitle ? `${run.buildTitle} v${run.buildVersion}` : 'A build'} · ${run.startedAt ? `started ${clock.dateTime(run.startedAt)}` : `recorded ${clock.dateTime(run.executedAt)}`}${run.endedAt ? ` · ended ${clock.dateTime(run.endedAt)}` : ''}`}
        meta={
          <>
            <Badge tone={run.status === 'open' ? 'warning' : run.failed > 0 || run.blocked > 0 ? 'danger' : 'success'}>{run.status}</Badge>
            {run.environment ? <Badge tone="neutral">{humanize(run.environment)}</Badge> : <Badge tone="warning">environment not recorded</Badge>}
          </>
        }
      />

      <ProjectSubNav projectId={projectId} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Result" description="The counts this run closed with. A closed run is evidence and never changes; what is added below sits beside it." />
            <div className="grid grid-cols-2 gap-3 px-4 pb-4 text-[13px] sm:grid-cols-5 sm:px-5">
              {[
                ['Total', run.total],
                ['Passed', run.passed],
                ['Failed', run.failed],
                ['Skipped', run.skipped],
                ['Blocked', run.blocked],
              ].map(([label, n]) => (
                <div key={label as string} className="rounded-md border border-line px-3 py-2">
                  <p className="text-xs font-medium text-muted">{label}</p>
                  <p className="text-lg font-semibold tabular">{n}</p>
                </div>
              ))}
            </div>
            {run.perfNotes ? <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Performance: {run.perfNotes}</p> : null}
            {canRecord && run.status === 'open' ? (
              <div className="px-4 pb-4 sm:px-5">
                <CloseRunForm projectId={projectId} runId={run.id} />
              </div>
            ) : null}
            {canRecord && run.status === 'closed' && (run.failed > 0 || run.blocked > 0) ? (
              <div className="px-4 pb-4 sm:px-5">
                <RerunButton projectId={projectId} runId={run.id} />
              </div>
            ) : null}
          </Card>

          <Card id="evidence">
            <CardHeader title={`Evidence (${run.evidence.length + (run.evidenceUrl ? 1 : 0)})`} description="Screenshots, logs, reports, recordings and notes — each appended by whoever has it and never edited. A file itself lives in storage; the row is its link." />
            <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
              {run.evidence.length === 0 && !run.evidenceUrl ? (
                <p className="text-[13px] text-muted">No evidence attached yet.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
                  {run.evidenceUrl ? (
                    <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
                      <Badge tone="neutral">Evidence link</Badge>
                      <a href={run.evidenceUrl} target="_blank" rel="noreferrer" className="min-w-0 break-all text-brand hover:underline">{run.evidenceUrl}</a>
                      <span className="text-xs text-muted">recorded with the run</span>
                    </li>
                  ) : null}
                  {run.evidence.map((e) => (
                    <li key={e.id} className="flex flex-col gap-1 px-3 py-2 text-[13px]">
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge tone="info">{KIND_LABEL[e.kind] ?? humanize(e.kind)}</Badge>
                        {e.label ? <span className="font-medium">{e.label}</span> : null}
                        <span className="text-xs text-muted">
                          {clock.dateTime(e.addedAt)}
                          {e.addedBy ? ` · ${e.addedBy}` : ''}
                        </span>
                      </span>
                      {e.kind === 'note' ? (
                        <p className="whitespace-pre-line text-muted">{e.value}</p>
                      ) : (
                        <a href={e.value} target="_blank" rel="noreferrer" className="break-all text-brand hover:underline">{e.value}</a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {/* Q-C6: evidence may be an uploaded file — a screenshot or a log — under the project-file limits and credentials guard. */}
              <AttachedFileLinks projectId={projectId} files={attachedFiles.get(run.id)} label="Evidence files of this run" />
              {canRecord ? <AddEvidenceForm projectId={projectId} runId={run.id} /> : null}
              {canRecord ? <AttachFileForm projectId={projectId} subjectKind="test_run" subjectId={run.id} /> : null}
            </div>
          </Card>

          <Card>
            <CardHeader title={`Case results (${cases.length})`} description="What each planned case did on this run." />
            {cases.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No per-case result was recorded. The run&apos;s own counts above are the record.</p>
            ) : (
              <ul className="divide-y divide-line">
                {cases.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2 text-[13px] sm:px-5">
                    <span className="min-w-0">
                      <span className="font-medium">{caseTitle(c.testPlanItemId)}</span>
                      {c.notes ? <span className="block text-xs text-muted">{c.notes}</span> : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge tone={statusTone(c.status)}>{humanize(c.status)}</Badge>
                      {c.evidenceUrl ? <a href={c.evidenceUrl} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">evidence</a> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title={`Defects from this run (${run.defects.length})`} description="Bugs raised against this run, with the run named on each." />
            {run.defects.length === 0 ? (
              <EmptyState icon={<IconCheck size={22} />} title="No defect raised from this run" description={run.failed > 0 ? 'The run had failures. Raise a defect so the fix is tracked and retested.' : 'Nothing has been raised against it.'} action={<Link href={`${base}#defects`} className="text-[13px] font-medium text-brand hover:underline">Open the defect register</Link>} />
            ) : (
              <ul className="divide-y divide-line">
                {run.defects.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px] sm:px-5">
                    <Link href={`${base}/bugs/${d.id}`} className="font-medium hover:underline">{d.title}</Link>
                    <span className="flex items-center gap-2">
                      <Badge tone={d.severity === 'blocker' ? 'danger' : d.severity === 'major' ? 'warning' : 'neutral'}>{d.severity}</Badge>
                      <Badge tone={statusTone(d.status)}>{humanize(d.status)}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {canWrite ? (
              <details className="px-4 pb-4 text-xs sm:px-5">
                <summary className="cursor-pointer text-brand">Raise a defect from this run</summary>
                <div className="mt-2">
                  <RaiseDefectForm projectId={projectId} deliverables={deliverables.map((d) => ({ id: d.id, kind: d.kind, version: d.version, title: d.title }))} defaultDeliverableId={run.deliverableId} defaultRunId={run.id} />
                </div>
              </details>
            ) : null}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Where and who" description="Doc 14 §31: evidence must identify the build and the environment." />
            <div className="px-4 pb-4 sm:px-5">
              <DetailList>
                <DetailRow label="Build" value={run.buildTitle ? `${run.buildTitle} v${run.buildVersion}` : 'Not found'} />
                <DetailRow label="Environment" value={run.environment ? humanize(run.environment) : <span className="text-muted">not recorded</span>} />
                <DetailRow label="Device" value={run.device ?? <span className="text-muted">not recorded</span>} />
                <DetailRow label="Browser" value={run.browser ?? <span className="text-muted">not recorded</span>} />
                <DetailRow label="OS" value={run.os ?? <span className="text-muted">not recorded</span>} />
                <DetailRow label="Tester" value={run.tester ? (run.tester.kind === 'person' ? run.tester.name : `agent ${run.tester.key}`) : <span className="text-muted">not recorded</span>} />
                <DetailRow label="Recorded by" value={run.recordedBy ?? <span className="text-muted">not recorded</span>} />
              </DetailList>
            </div>
          </Card>

          <Card>
            <CardHeader title="Retest history" description="The runs this one repeats, and the reruns it led to." />
            {run.chain.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">This run was not a rerun and has not been rerun.</p>
            ) : (
              <ul className="divide-y divide-line">
                {run.chain.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px] sm:px-5">
                    <span className="flex items-center gap-2">
                      <Badge tone={c.relation === 'earlier' ? 'neutral' : 'info'}>{c.relation === 'earlier' ? 'Earlier run' : 'Rerun'}</Badge>
                      <Link href={`${base}/runs/${c.id}`} className="hover:underline">{humanize(c.suite)} · {clock.dateTime(c.executedAt)}</Link>
                    </span>
                    <span className="text-xs text-muted tabular">{c.status === 'open' ? 'open' : `${c.passed} passed, ${c.failed} failed, ${c.blocked} blocked`}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title={`Metrics (${run.metrics.length})`} description="Measurements attached to this run, read against the project's budgets on the QA tab." />
            <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
              {run.metrics.length === 0 ? <p className="text-[13px] text-muted">No metric attached.</p> : null}
              {run.metrics.map((m) => (
                <p key={m.id} className="text-[13px] tabular">
                  <span className="font-medium">{m.metric}</span> {m.value} {m.unit}
                </p>
              ))}
              {canRecord ? <MetricForm projectId={projectId} runId={run.id} /> : null}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
