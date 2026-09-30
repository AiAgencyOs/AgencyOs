import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listCommitLinksForTask } from '@/modules/projects/git-queries';
import { getProject } from '@/modules/projects/queries';
import { readTaskCollab } from '@/modules/projects/task-collab-queries';
import { listTaskEvidence, readTaskHandoff } from '@/modules/projects/task-evidence-queries';
import { readTaskTime } from '@/modules/projects/time-log-queries';
import { readTaskDetail } from '@/modules/projects/task-queries';
import { listDefectsForTask } from '@/modules/qa/defect-task-queries';
import { Badge, buttonClass, Card, CardHeader, DetailPanel, EntityHeader, humanize, IconArrowLeft, IconCalendar, IconEdit, IconList, ProgressBar, StatusBadge, statusTone } from '@/ui';

import { ProjectSubNav } from '../../../project-subnav';
import { TaskCollabPanel } from '../../../../../task-collab-panel';
import { TimeLogPanel } from '../../../../../time-log-panel';
import { TaskClarificationForm } from './task-clarification-form';
import { AddSubtaskForm, LabelsForm } from './task-plan-forms';
import { listProjectSprints } from '@/modules/projects/sprint-queries';
import { sprintEnd } from '@/modules/projects/sprint-schema';
import { PlaceInSprintForm } from '../../../sprint-forms';
import { listAssigneeCandidates } from '@/modules/projects/project-members-queries';
import { LinkCommitPanel, ReadyForQaButton, ReopenFromDefectPanel, StartTaskButton, SubmitEvidencePanel } from './task-doors-panel';

export const metadata: Metadata = { title: 'Task' };

/**
 * One task's detail — SCR-041. The development tab lists tasks as a title
 * and a status; this is the surface behind the title, assembled from the
 * foreign keys the schema already holds (see `readTaskDetail`). Gated on
 * project.read like the tab it hangs off; the one write here — raising a
 * clarification — goes through the plan's own door and is offered only
 * when the newest plan is a draft, which is the only state that door
 * accepts.
 *
 * Bucket F (migration 20261001130000) — SCR-041: the four doors on the
 * task itself (start, mark ready for QA, submit evidence, reopen after a QA
 * failure), the evidence status and the test evidence a "done" points at,
 * the handoff status read from the row, and the commits linked to the task.
 */
export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string }>;
}) {
  const { projectId, taskId } = await params;

  const context = await requireInternal(`/projects/${projectId}/development/tasks/${taskId}`);
  if (!can(context, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const detail = await readTaskDetail(projectId, taskId);
  if (!detail) notFound();

  const clock = await agencyClock();
  // SCR-047 — the defects triaged against this task.
  const [collab, defects, time, taskEvidence, handoff, commits] = await Promise.all([readTaskCollab(taskId, clock), listDefectsForTask(taskId), readTaskTime(taskId), listTaskEvidence(taskId), readTaskHandoff(taskId), listCommitLinksForTask(taskId)]);
  const openDefects = defects.filter((d) => d.status === 'open').map((d) => ({ id: d.id, title: d.title, severity: d.severity }));
  const testEvidence = taskEvidence.filter((e) => e.kind === 'test');
  const { task, module, feature, scopeItems, evidence, plan, dependencies, subtasks } = detail;
  const candidates = await listAssigneeCandidates(projectId);
  const sprints = await listProjectSprints(projectId);
  const mayPlan = can(context, 'project.write');
  const mayWriteTask = can(context, 'task.write');

  const priority: Record<string, { label: string; tone: 'danger' | 'warning' | 'info' | 'neutral' }> = {
    p0: { label: 'Critical', tone: 'danger' },
    p1: { label: 'High', tone: 'warning' },
    p2: { label: 'Medium', tone: 'info' },
    p3: { label: 'Low', tone: 'neutral' },
  };
  const pr = priority[task.priority] ?? { label: task.priority, tone: 'neutral' as const };

  return (
    <div className="flex flex-col gap-5">
      <EntityHeader
        name={task.title}
        status={
          <>
            <Badge tone={statusTone(task.status)}>{humanize(task.status)}</Badge>
            <Badge tone={pr.tone}>{pr.label} priority</Badge>
            {module ? <Badge tone="info">{module.name}</Badge> : null}
            {task.labels.map((l) => (
              <Badge key={l} tone="neutral">{l}</Badge>
            ))}
          </>
        }
        subtitle={
          <Link href={`/projects/${projectId}/development`} className="underline underline-offset-2 hover:text-foreground">
            {project.name} — Development
          </Link>
        }
        facts={[
          { label: 'Task ID', value: <span className="font-mono">#{task.id.slice(0, 8)}</span>, icon: <IconList size={14} /> },
          { label: 'Created', value: clock.date(task.createdAt), icon: <IconCalendar size={14} /> },
          ...(task.completedAt ? [{ label: 'Completed', value: clock.date(task.completedAt), icon: <IconCalendar size={14} /> }] : []),
          ...(feature ? [{ label: 'Feature', value: feature.name, icon: <IconList size={14} /> }] : []),
        ]}
        actions={
          <>
            <Link href={`/projects/${projectId}/board`} className={buttonClass('secondary', 'sm')}>
              <IconArrowLeft size={14} />
              Back
            </Link>
            {mayWriteTask ? (
              <Link href={`/projects/${projectId}/board`} className={buttonClass('primary', 'sm')}>
                <IconEdit size={14} />
                Edit task
              </Link>
            ) : null}
          </>
        }
      />

      <ProjectSubNav projectId={projectId} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(19rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Task description" actions={mayWriteTask ? <Link href={`/projects/${projectId}/board`} className="text-[13px] font-medium text-brand hover:underline">Edit</Link> : undefined} />
            <div className="px-4 pb-4 sm:px-5">
              {task.description ? <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">{task.description}</p> : <p className="text-[13px] text-muted">No description recorded.</p>}
              {task.status === 'blocked' ? (
                <p className="mt-3 whitespace-pre-wrap text-[13px] text-danger">
                  Blocked on: {collab.blocked.reason ?? 'No reason recorded.'}
                  {collab.blocked.sinceLabel ? <span className="text-muted"> · since {collab.blocked.sinceLabel}</span> : null}
                </p>
              ) : null}
            </div>
          </Card>

              <Card>
                <CardHeader title={`Subtasks (${subtasks.filter((x) => x.status === 'done').length}/${subtasks.length})`} description={task.parent ? undefined : 'Work broken out under this task. A subtask keeps its own status on its own page.'} />
                <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
                  {task.parent ? (
                    <p className="text-[13px] text-muted">This is itself a subtask, so it has none of its own.</p>
                  ) : subtasks.length === 0 ? (
                    <p className="text-[13px] text-muted">No subtasks yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[30rem] text-[13px]">
                        <thead>
                          <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                            <th className="w-8 py-2 pr-2">#</th>
                            <th className="py-2 pr-3">Title</th>
                            <th className="py-2 pr-3">Assignee</th>
                            <th className="py-2 pr-3">Due date</th>
                            <th className="py-2">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {subtasks.map((x, i) => (
                            <tr key={x.id}>
                              <td className="tabular py-2 pr-2 text-muted">{i + 1}</td>
                              <td className="py-2 pr-3 font-medium"><Link href={`/projects/${projectId}/development/tasks/${x.id}`} className="hover:underline">{x.title}</Link></td>
                              <td className="py-2 pr-3 text-muted">{x.assigneeName ?? 'Unassigned'}</td>
                              <td className="whitespace-nowrap py-2 pr-3 text-muted">{x.dueOn ? clock.date(x.dueOn) : '—'}</td>
                              <td className="py-2"><StatusBadge status={x.status} dot={false} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {mayWriteTask && !task.parent ? <AddSubtaskForm projectId={projectId} parentTaskId={task.id} roster={candidates.people} /> : null}
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Working the task"
                  description={
                    collab.progress.total > 0
                      ? `${collab.progress.done} of ${collab.progress.total} checklist steps done · ${collab.comments.length} comment${collab.comments.length === 1 ? '' : 's'} · ${collab.attachments.length} attachment${collab.attachments.length === 1 ? '' : 's'}`
                      : 'Implementation notes: the checklist, the comments and the attached links a task is worked through (SCR-041).'
                  }
                />
                <div className="px-4 pb-4 sm:px-5">
                  <TaskCollabPanel projectId={projectId} taskId={task.id} status={task.status} collab={collab} canWrite={mayWriteTask} />
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Scope it delivers"
                  description="The scope items the task's feature carries. Acceptance criteria are what a reviewer measures 'done' against."
                />
                <div className="px-4 pb-4 sm:px-5">
                  {scopeItems.length === 0 ? (
                    <p className="text-[13px] text-muted">
                      {feature
                        ? 'No scope item is linked to this feature yet.'
                        : 'The task has no feature, so nothing in the scope baseline points at it.'}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {scopeItems.map((s) => (
                        <li key={s.id} className="flex flex-col gap-0.5 rounded-md border border-line px-3 py-2 text-[13px]">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{s.title}</span>
                            <Badge tone={s.inclusion === 'included' ? 'success' : 'neutral'}>{s.inclusion}</Badge>
                            <Link href={`/projects/${projectId}/scope`} className="text-xs text-muted underline underline-offset-2">
                              baseline v{s.scopeVersion} · {s.scopeStatus}
                            </Link>
                          </span>
                          {s.acceptanceCriteria ? (
                            <span className="text-muted">Accept: {s.acceptanceCriteria}</span>
                          ) : (
                            <span className="text-xs text-warning">No acceptance criteria recorded.</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>

              <Card>
                <CardHeader
                  title={`Test evidence (${taskEvidence.length})`}
                  description="What 'done' points at — a test run, a screenshot, a review note. A link or a note, never a blob (SCR-041)."
                />
                <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
                  {taskEvidence.length === 0 ? (
                    <p className="text-[13px] text-muted">No evidence submitted yet.</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {taskEvidence.map((e) => (
                        <li key={e.id} className="flex flex-col gap-0.5 rounded-md border border-line px-3 py-2 text-[13px]">
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge tone={e.kind === 'test' ? 'success' : 'neutral'}>{e.kind}</Badge>
                            {e.url ? (
                              <a href={e.url} target="_blank" rel="noreferrer noopener" className="font-medium underline-offset-2 hover:underline">
                                {e.title}
                              </a>
                            ) : (
                              <span className="font-medium">{e.title}</span>
                            )}
                            <span className="text-xs text-muted">{clock.dateTime(e.createdAt)}</span>
                          </span>
                          {e.note ? <span className="whitespace-pre-wrap text-muted">{e.note}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                  {mayWriteTask ? <SubmitEvidencePanel projectId={projectId} taskId={task.id} /> : null}
                </div>
              </Card>

              <Card>
                <CardHeader
                  title={`Commits (${commits.length})`}
                  description="Commits a person linked to this task (SCR-042). The repository tab reads what GitHub says about them."
                />
                <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
                  {commits.length === 0 ? (
                    <p className="text-[13px] text-muted">No commit is linked to this task.</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {commits.map((c) => (
                        <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                          {c.url ? (
                            <a href={c.url} target="_blank" rel="noreferrer noopener" className="font-mono text-xs underline-offset-2 hover:underline">
                              {c.shortSha}
                            </a>
                          ) : (
                            <span className="font-mono text-xs">{c.shortSha}</span>
                          )}
                          <span className="min-w-0 flex-1 truncate">{c.message ?? <span className="text-muted">no message recorded</span>}</span>
                          <span className="text-xs text-muted">{clock.dateTime(c.createdAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {mayWriteTask ? <LinkCommitPanel projectId={projectId} taskId={task.id} /> : null}
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Outstanding dependencies"
                  description={
                    plan
                      ? `What plan v${plan.version} is still waiting on. A task cannot be done by ignoring one.`
                      : 'The project has no plan, so nothing is recorded as waited on.'
                  }
                />
                <div className="px-4 pb-4 sm:px-5">
                  {dependencies.length === 0 ? (
                    <p className="text-[13px] text-muted">Nothing outstanding.</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {dependencies.map((d) => (
                        <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                          <span className="font-medium">{d.description}</span>
                          <span className="text-muted">
                            {d.kind.replace(/_/g, ' ')} · by {d.neededByPhase.replace('_', ' ')} · {d.ownerRole} ·{' '}
                            <Badge tone={d.status === 'blocked' ? 'danger' : 'warning'}>{d.status}</Badge>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>

              <Card>
                <CardHeader
                  title={`Defects (${defects.length})`}
                  description="Defects triaged against this task on the QA tab or the overview's register. An open blocker or major here blocks the project's delivery, not only this task."
                />
                <div className="px-4 pb-4 sm:px-5">
                  {defects.length === 0 ? (
                    <p className="text-[13px] text-muted">No defect is linked to this task.</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {defects.map((d) => (
                        <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge tone={d.severity === 'blocker' ? 'danger' : d.severity === 'major' ? 'warning' : 'neutral'}>{d.severity}</Badge>
                            <Badge tone={statusTone(d.status)}>{humanize(d.status)}</Badge>
                            <Link href={`/projects/${projectId}/qa`} className="font-medium underline-offset-2 hover:underline">
                              {d.title}
                            </Link>
                          </span>
                          <span className="text-xs text-muted">raised {clock.date(d.createdAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Evidence"
                  description="Deliverables the task's module has produced — what a 'done' has to be able to point at."
                />
                <div className="px-4 pb-4 sm:px-5">
                  {evidence.length === 0 ? (
                    <p className="text-[13px] text-muted">
                      {module ? 'No deliverable has been recorded against this module.' : 'The task has no module, so no deliverable is attributed to it.'}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {evidence.map((e) => (
                        <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                          <span className="flex items-center gap-2">
                            <span className="font-medium">
                              {e.kind} v{e.version} — {e.title}
                            </span>
                            <Badge tone={statusTone(e.status)}>{humanize(e.status)}</Badge>
                          </span>
                          {e.artifactUrl ? (
                            <a href={e.artifactUrl} target="_blank" rel="noreferrer noopener" className="text-xs underline underline-offset-2">
                              open
                            </a>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Request clarification"
                  description="A question the task cannot answer for itself goes on the plan, where it stops a guess from being built (Project Planning §10)."
                />
                <div className="px-4 pb-4 sm:px-5">
                  {!mayPlan ? (
                    <p className="text-[13px] text-muted">You do not have permission to raise a question on this project's plan.</p>
                  ) : !plan ? (
                    <p className="text-[13px] text-muted">
                      There is no plan to raise it on.{' '}
                      <Link href={`/projects/${projectId}/plan`} className="underline underline-offset-2">
                        Draft one
                      </Link>
                      .
                    </p>
                  ) : plan.status !== 'draft' ? (
                    <p className="text-[13px] text-muted">
                      Plan v{plan.version} is {plan.status}; a question is raised on the next draft.{' '}
                      <Link href={`/projects/${projectId}/plan`} className="underline underline-offset-2">
                        Open the next version on the plan tab
                      </Link>
                      .
                    </p>
                  ) : (
                    <TaskClarificationForm projectId={projectId} planId={plan.id} taskTitle={task.title} />
                  )}
                </div>
              </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <DetailPanel
            title="Task details"
            rows={[
              { label: 'Status', value: <Badge tone={statusTone(task.status)}>{humanize(task.status)}</Badge> },
              { label: 'Priority', value: <Badge tone={pr.tone}>{pr.label}</Badge> },
              { label: 'Assignee', value: task.assignee ? task.assignee.fullName : <span className="font-normal text-muted">Unassigned</span> },
              {
                label: 'Sprint',
                value: task.sprint ? (
                  <span>
                    {task.sprint.name}
                    <span className="ml-1.5 text-xs font-normal text-muted">{clock.date(task.sprint.startsOn)} – {clock.date(sprintEnd(task.sprint.startsOn, task.sprint.lengthDays))}{task.sprint.closedAt ? ' · closed' : ''}</span>
                  </span>
                ) : (
                  <span className="font-normal text-muted">Not in a sprint</span>
                ),
              },
              { label: 'Start date', value: task.startOn ? clock.date(task.startOn) : <span className="font-normal text-muted">No date</span> },
              { label: 'Due date', value: task.dueOn ? clock.date(task.dueOn) : <span className="font-normal text-muted">No date</span> },
              { label: 'Estimated hours', value: task.estimateHours !== null ? `${task.estimateHours} hours` : <span className="font-normal text-muted">Not estimated</span> },
              { label: 'Logged hours', value: `${time.totalHours} hours${task.estimateHours ? ` (${Math.round((time.totalHours / task.estimateHours) * 100)}%)` : ''}` },
              {
                label: 'Handoff status',
                value: handoff ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={handoff.label === 'ready for QA' || handoff.label === 'done' ? 'success' : handoff.label === 'blocked' ? 'danger' : handoff.label === 'reopened' ? 'warning' : 'neutral'}>{handoff.label}</Badge>
                    {handoff.readyForQaAt ? <span className="text-xs font-normal text-muted">ready {clock.dateTime(handoff.readyForQaAt)}</span> : null}
                    {handoff.reopenedCount > 0 ? <span className="text-xs font-normal text-muted">reopened {handoff.reopenedCount}×</span> : null}
                  </span>
                ) : (
                  <span className="font-normal text-muted">unknown</span>
                ),
              },
              {
                label: 'Evidence status',
                value:
                  taskEvidence.length === 0 ? (
                    <span className="font-normal text-warning">none submitted — a hand-off is refused until there is some</span>
                  ) : (
                    <span>{taskEvidence.length} submitted · {testEvidence.length} test evidence</span>
                  ),
              },
            ]}
          >
            {collab.progress.total > 0 ? (
              <div className="px-4 pb-4 sm:px-5">
                <ProgressBar value={collab.progress.percent} label="Checklist progress" tone="brand" />
                <p className="mt-1 text-xs text-muted">{collab.progress.done} of {collab.progress.total} checklist steps done</p>
              </div>
            ) : null}
          </DetailPanel>

              {/* SCR-041 — the task's own doors. Which are drawn follows the status. */}
              <Card>
                <CardHeader
                  title="Move the task"
                  description="Start it, hand it to QA (needs evidence, never while blocked), or reopen it after a QA failure against an open defect. Each is one audited transition; a refusal is the database's own sentence."
                />
                <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
                  {!mayWriteTask ? (
                    <p className="text-[13px] text-muted">You do not have permission to move this task.</p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-3">
                      {task.status === 'todo' ? <StartTaskButton projectId={projectId} taskId={task.id} /> : null}
                      {task.status === 'in_progress' ? <ReadyForQaButton projectId={projectId} taskId={task.id} evidenceCount={taskEvidence.length} /> : null}
                      {task.status === 'in_review' || task.status === 'done' ? <ReopenFromDefectPanel projectId={projectId} taskId={task.id} defects={openDefects} /> : null}
                      {(task.status === 'in_review' || task.status === 'done') && openDefects.length === 0 ? <span className="text-[13px] text-muted">No open defect is triaged against this task, so there is nothing to reopen it from.</span> : null}
                      {task.status === 'blocked' ? <span className="text-[13px] text-muted">Blocked. Unblock it from the checklist panel, or escalate it to the PM on the Development tab.</span> : null}
                    </div>
                  )}
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Time"
                  description={time.entries.length > 0 ? `${time.totalHours} h logged across ${time.entries.length} entr${time.entries.length === 1 ? 'y' : 'ies'}. Hours only — no rate is recorded, so nothing here is billed.` : 'Manual hours per task with a date and a note (decision 4 of 2026-09-29). No billing effect.'}
                />
                <div className="px-4 pb-4 sm:px-5">
                  <TimeLogPanel projectId={projectId} taskId={task.id} time={time} currentUserId={context.userId} canDeleteAny={mayPlan} canWrite={mayWriteTask} today={clock.dayKey(new Date())} />
                </div>
              </Card>

          {mayWriteTask ? (
            <Card>
              <CardHeader title="Sprint" description="Place the task in one open sprint of this project, or take it out." />
              <div className="px-4 pb-4 sm:px-5">
                {sprints.length === 0 ? (
                  <p className="text-[13px] text-muted">
                    This project has no sprint yet. <Link href={`/projects/${projectId}/tasks`} className="text-brand underline underline-offset-2">Create one on the Tasks tab.</Link>
                  </p>
                ) : (
                  <PlaceInSprintForm projectId={projectId} taskId={task.id} current={task.sprint?.id ?? null} sprints={sprints.map((s) => ({ id: s.id, name: s.name, closed: s.closedAt !== null }))} />
                )}
              </div>
            </Card>
          ) : null}

          {mayWriteTask ? (
            <Card>
              <CardHeader title="Labels" />
              <div className="px-4 pb-4 sm:px-5">
                <LabelsForm key={task.labels.join('|')} projectId={projectId} taskId={task.id} labels={task.labels} />
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Related" />
            <dl className="grid grid-cols-[minmax(5rem,30%)_1fr] gap-x-3 gap-y-2.5 px-4 pb-4 text-[13px] sm:px-5">
              <dt className="text-muted">Project</dt>
              <dd className="min-w-0 font-medium"><Link href={`/projects/${projectId}`} className="text-brand hover:underline">{project.name}</Link></dd>
              <dt className="text-muted">Phase</dt>
              <dd className="min-w-0 font-medium">{task.milestone ? <Link href={`/projects/${projectId}/milestones`} className="text-brand hover:underline">{task.milestone.name}</Link> : <span className="font-normal text-muted">None</span>}</dd>
              <dt className="text-muted">Parent task</dt>
              <dd className="min-w-0 font-medium">{task.parent ? <Link href={`/projects/${projectId}/development/tasks/${task.parent.id}`} className="text-brand hover:underline">{task.parent.title}</Link> : <span className="font-normal text-muted">None</span>}</dd>
              <dt className="text-muted">Module</dt>
              <dd className="min-w-0 font-medium">{module ? module.name : <span className="font-normal text-muted">None</span>}</dd>
              <dt className="text-muted">Feature</dt>
              <dd className="min-w-0 font-medium">{feature ? feature.name : <span className="font-normal text-muted">None</span>}</dd>
              <dt className="text-muted">Commits</dt>
              <dd className="min-w-0 font-medium">{commits.length}</dd>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
