import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listAttachedFiles } from '@/modules/projects/attached-files-queries';
import { getProject, listDeliverables, listDevelopmentBreakdown, listInternalRoster } from '@/modules/projects/queries';
import { readDefectHistory } from '@/modules/qa/dashboard-queries';
import { readDefectDetail } from '@/modules/qa/defect-detail-queries';
import { ActivityFeed, Badge, Card, CardHeader, DetailList, DetailRow, EmptyState, IconCheck, PageHeader, PermissionDenied, humanize, statusTone, type Tone } from '@/ui';

import { AttachFileForm } from '../../../attach-file-form';
import { AttachedFileLinks } from '../../../attached-file-links';
import { ProjectSubNav } from '../../../project-subnav';
import { DefectTriageForm, SettleDefectForm } from '../../../qa-panel';
import { AttachEvidenceForm, LinkBuildForm } from './bug-detail-forms';

export const metadata: Metadata = { title: 'Bug' };

const SEVERITY_TONE: Record<string, Tone> = { blocker: 'danger', major: 'warning', minor: 'info', trivial: 'neutral' };

const HISTORY_LABEL: Record<string, string> = {
  'defect.raised': 'raised',
  'defect.fixed': 'marked fixed',
  'defect.open': 'reopened — the fix did not hold',
  'defect.verified': 'verified by QA',
  'defect.wontfix': 'will not be fixed',
  'defect.updated': 'triaged',
  'defect.retest_assigned': 'retest assigned',
  'defect.evidence_added': 'evidence attached',
  'defect.build_linked': 'build linked',
  'defect.build_unlinked': 'build unlinked',
};

/**
 * SCR-047 — one bug's page ("use dedicated page/tabs for complex workflows").
 *
 * Every element the PDF lists under Bug detail: the title, the severity with
 * the reason of its last change, the status, the owner, the reproduction
 * steps, expected against actual, the environment and the version it was
 * found on, the run that found it, the linked task, the linked build, the
 * evidence list, and the full fix / retest history from the audit log and
 * the retest assignments. The doors are the QA tab's own (triage, settle —
 * the same components) plus attach-evidence and link-build
 * (20261001160000). Gated on project.read like the tab it hangs off.
 */
export default async function BugDetailPage({ params }: { params: Promise<{ projectId: string; defectId: string }> }) {
  const { projectId, defectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/qa/bugs/${defectId}`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const detail = await readDefectDetail(projectId, defectId);
  if (!detail) notFound();

  const [clock, history, roster, deliverables, { tasks }, attachedFiles] = await Promise.all([
    agencyClock(),
    readDefectHistory([defectId]),
    listInternalRoster(),
    listDeliverables(projectId),
    listDevelopmentBreakdown(projectId, { excludeCancelled: true }),
    // Q-C6: the evidence files uploaded against this bug.
    listAttachedFiles(projectId),
  ]);
  const canWrite = can(context, 'project.write');
  const canAttach = can(context, 'task.write');
  const { defect, task, build, foundOn, run, evidence, retests, lastSeverityChange, resolutionNotes } = detail;
  const name = (userId: string | null) => (userId ? (roster.find((m) => m.userId === userId)?.fullName ?? 'a member') : null);
  const builds = deliverables.filter((d) => d.kind === 'build').map((d) => ({ id: d.id, version: d.version, title: d.title }));
  const trail = history.get(defectId) ?? [];
  const settled = defect.status === 'verified' || defect.status === 'wontfix';

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow={
          <Link href={`/projects/${projectId}/qa#defects`} className="hover:underline">
            {project.name} · QA · bugs
          </Link>
        }
        title={defect.title}
        description={`Raised ${clock.dateTime(defect.created_at)}${defect.reportedBy ? ` by ${name(defect.reportedBy)}` : ''} · last change ${clock.dateTime(defect.updatedAt)}`}
        meta={
          <>
            <Badge tone={SEVERITY_TONE[defect.severity] ?? 'neutral'}>{defect.severity}</Badge>
            <Badge tone={statusTone(defect.status)}>{humanize(defect.status)}</Badge>
            {defect.status === 'open' && (defect.severity === 'blocker' || defect.severity === 'major') ? <Badge tone="danger">blocks release</Badge> : null}
          </>
        }
      />

      <ProjectSubNav projectId={projectId} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Reproduction" description="How to make it happen, what should happen, and what happens instead." />
            <div className="flex flex-col gap-3 px-4 pb-4 text-[13px] sm:px-5">
              <p className="whitespace-pre-line">{defect.reproduction}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-line px-3 py-2">
                  <p className="text-xs font-medium text-muted">Expected</p>
                  <p className="whitespace-pre-line">{defect.expected ?? <span className="text-muted">not stated</span>}</p>
                </div>
                <div className="rounded-md border border-line px-3 py-2">
                  <p className="text-xs font-medium text-muted">Actual</p>
                  <p className="whitespace-pre-line">{defect.actual ?? <span className="text-muted">not stated</span>}</p>
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title={`Evidence (${evidence.length + (defect.evidence_url ? 1 : 0)})`} description="What shows the bug is real, and later what shows it is fixed. Appended, never edited." />
            <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
              {evidence.length === 0 && !defect.evidence_url ? (
                <EmptyState
                  icon={<IconCheck size={22} />}
                  title="No evidence attached"
                  description="A screenshot, a recording, a log line or a note — whoever has it attaches it here."
                  action={canAttach ? <AttachEvidenceForm projectId={projectId} defectId={defectId} /> : <span className="text-xs text-muted">Attaching evidence needs task.write.</span>}
                />
              ) : (
                <ul className="flex flex-col gap-1 text-[13px]">
                  {defect.evidence_url ? (
                    <li className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">link</Badge>
                      <a href={defect.evidence_url} target="_blank" rel="noreferrer" className="break-all underline underline-offset-2">
                        {defect.evidence_url}
                      </a>
                      <span className="text-xs text-muted">attached when raised</span>
                    </li>
                  ) : null}
                  {evidence.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{e.kind === 'url' ? 'link' : 'note'}</Badge>
                      {e.kind === 'url' ? (
                        <a href={e.value} target="_blank" rel="noreferrer" className="break-all underline underline-offset-2">
                          {e.value}
                        </a>
                      ) : (
                        <span className="whitespace-pre-line">{e.value}</span>
                      )}
                      <span className="text-xs text-muted">
                        {name(e.addedBy) ?? 'system'} · {clock.dateTime(e.addedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {canAttach && (evidence.length > 0 || defect.evidence_url) ? <AttachEvidenceForm projectId={projectId} defectId={defectId} /> : null}
              {/* Q-C6: the evidence may be an uploaded file — a screenshot or a log — under the project-file limits and credentials guard. */}
              <AttachedFileLinks projectId={projectId} files={attachedFiles.get(defectId)} label="Evidence files of this bug" />
              {canWrite ? <AttachFileForm projectId={projectId} subjectKind="defect" subjectId={defectId} /> : null}
            </div>
          </Card>

          <div id="history">
            <ActivityFeed
              title="Fix / retest history"
              emptyTitle="Nothing recorded yet"
              emptyDescription="Every move this bug makes lands here from the audit log, with every retest that is assigned."
              compact
              items={[
                ...trail.map((h, i) => ({
                  id: `h-${i}`,
                  at: h.createdAt,
                  title: HISTORY_LABEL[h.action] ?? h.action.replace('defect.', ''),
                  detail: h.actorType ? `by ${h.actorType}` : undefined,
                  tone: (h.action === 'defect.open' ? 'danger' : h.action === 'defect.verified' ? 'success' : h.action === 'defect.fixed' ? 'brand' : 'neutral') as Tone,
                })),
                ...retests.map((r) => ({
                  id: `r-${r.id}`,
                  at: r.createdAt,
                  title: `retest asked of ${name(r.retesterId) ?? 'a member'}`,
                  detail: [r.assignedBy ? `by ${name(r.assignedBy)}` : null, r.note].filter(Boolean).join(' · ') || undefined,
                  tone: 'info' as Tone,
                })),
              ]
                .sort((a, b) => a.at.localeCompare(b.at))
                .map((t) => ({ id: t.id, title: t.title, detail: t.detail, when: clock.dateTime(t.at), tone: t.tone }))}
            />
          </div>

          {canWrite ? (
            <Card>
              <CardHeader title="Assign, change severity, submit fix, verify" description="Assign a developer and change the severity with a reason; move it along — a developer marks it fixed, QA verifies or reopens." />
              <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
                {settled ? (
                  <p className="text-[13px] text-muted">This defect is {defect.status}; it is not re-triaged. Raise a new one if it is wrong again.</p>
                ) : (
                  <DefectTriageForm projectId={projectId} defect={defect} roster={roster.map((m) => ({ userId: m.userId, fullName: m.fullName || m.email }))} tasks={tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }))} />
                )}
                <SettleDefectForm projectId={projectId} defect={defect} />
                {!settled ? <LinkBuildForm projectId={projectId} defectId={defectId} currentBuildId={defect.build_id} builds={builds} /> : null}
              </div>
            </Card>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Bug detail" />
            <div className="px-4 pb-2 sm:px-5">
              <DetailList>
                <DetailRow
                  label="Severity"
                  value={
                    <span className="flex flex-col gap-0.5">
                      <Badge tone={SEVERITY_TONE[defect.severity] ?? 'neutral'} className="self-start">
                        {defect.severity}
                      </Badge>
                      {lastSeverityChange ? (
                        <span className="text-xs text-muted">
                          was {lastSeverityChange.from}: {lastSeverityChange.reason}
                        </span>
                      ) : (
                        <span className="text-xs text-muted">as raised</span>
                      )}
                    </span>
                  }
                />
                <DetailRow label="Status" value={<Badge tone={statusTone(defect.status)}>{humanize(defect.status)}</Badge>} />
                <DetailRow label="Assigned developer" value={name(defect.assignee_id) ?? <span className="text-muted">unassigned</span>} />
                <DetailRow label="Reported by" value={name(defect.reportedBy) ?? <span className="text-muted">not recorded</span>} />
                <DetailRow label="Environment" value={defect.environment ?? <span className="text-muted">not stated</span>} />
                <DetailRow
                  label="Found on"
                  value={
                    foundOn ? (
                      <Link href={`/projects/${projectId}/${foundOn.kind === 'build' ? 'builds' : 'design'}`} className="underline underline-offset-2">
                        {foundOn.kind} v{foundOn.version} — {foundOn.title}
                      </Link>
                    ) : (
                      <span className="text-muted">the project as a whole</span>
                    )
                  }
                />
                <DetailRow
                  label="Found by run"
                  value={
                    run ? (
                      <Link href={`/projects/${projectId}/qa/runs/${run.id}`} className="underline underline-offset-2">
                        {humanize(run.suite)} run · {run.status} · {clock.dateTime(run.executedAt)}
                      </Link>
                    ) : (
                      <span className="text-muted">not raised from a run</span>
                    )
                  }
                />
                <DetailRow
                  label="Linked task"
                  value={
                    task ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <Link href={`/projects/${projectId}/development/tasks/${task.id}`} className="underline underline-offset-2">
                          {task.title}
                        </Link>
                        <Badge tone={statusTone(task.status)}>{humanize(task.status)}</Badge>
                      </span>
                    ) : (
                      <span className="text-muted">none — set at triage</span>
                    )
                  }
                />
                <DetailRow
                  label="Linked build"
                  value={
                    build ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <Link href={`/projects/${projectId}/builds`} className="underline underline-offset-2">
                          v{build.version} — {build.title}
                        </Link>
                        <Badge tone={statusTone(build.status)}>{humanize(build.status)}</Badge>
                      </span>
                    ) : (
                      <span className="text-muted">none — the build the fix lands in</span>
                    )
                  }
                />
                {resolutionNotes ? <DetailRow label="Resolution notes" value={<span className="whitespace-pre-line">{resolutionNotes}</span>} /> : null}
                {defect.verified_at ? <DetailRow label="Verified" value={`${name(defect.verifiedBy) ?? 'QA'} · ${clock.dateTime(defect.verified_at)}`} /> : null}
              </DetailList>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
