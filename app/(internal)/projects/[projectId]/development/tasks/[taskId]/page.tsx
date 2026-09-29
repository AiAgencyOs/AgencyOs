import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject } from '@/modules/projects/queries';
import { readTaskCollab } from '@/modules/projects/task-collab-queries';
import { readTaskDetail } from '@/modules/projects/task-queries';
import { Badge, Card, CardHeader, DetailList, DetailRow, humanize, PageHeader, statusTone } from '@/ui';

import { ProjectSubNav } from '../../../project-subnav';
import { TaskCollabPanel } from '../../../../../task-collab-panel';
import { TaskClarificationForm } from './task-clarification-form';

export const metadata: Metadata = { title: 'Task' };

/**
 * One task's detail — SCR-041. The development tab lists tasks as a title
 * and a status; this is the surface behind the title, assembled from the
 * foreign keys the schema already holds (see `readTaskDetail`). Gated on
 * project.read like the tab it hangs off; the one write here — raising a
 * clarification — goes through the plan's own door and is offered only
 * when the newest plan is a draft, which is the only state that door
 * accepts.
 */
export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string }>;
}) {
  const { projectId, taskId } = await params;

  const context = await requireInternal(`/projects/${projectId}/development/tasks/${taskId}`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const detail = await readTaskDetail(projectId, taskId);
  if (!detail) notFound();

  const clock = await agencyClock();
  const collab = await readTaskCollab(taskId, clock);
  const { task, module, feature, scopeItems, evidence, plan, dependencies } = detail;
  const mayPlan = can(context.role, 'project.write');
  const mayWriteTask = can(context.role, 'task.write');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={task.title}
        description={
          <>
            <Link href={`/projects/${projectId}/development`} className="underline underline-offset-2 hover:text-foreground">
              {project.name} — Development
            </Link>
            {module ? ` · ${module.name}` : ''}
            {feature ? ` · ${feature.name}` : ''}
          </>
        }
      />

      <ProjectSubNav projectId={projectId} />

      <Card className="p-4 sm:p-5">
        <DetailList>
          <DetailRow
            label="Status"
            value={
              <span className="flex items-center gap-2">
                <Badge tone={statusTone(task.status)}>{humanize(task.status)}</Badge>
                <span className="text-xs text-muted">{task.priority} priority</span>
              </span>
            }
          />
          <DetailRow
            label="Owner"
            value={task.assignee ? `${task.assignee.fullName}` : <span className="text-muted">unassigned</span>}
          />
          <DetailRow label="Due" value={task.dueOn ? clock.date(task.dueOn) : <span className="text-muted">no date</span>} />
          <DetailRow
            label="Estimate"
            value={task.estimateHours !== null ? `${task.estimateHours}h` : <span className="text-muted">not estimated</span>}
          />
          <DetailRow label="Created" value={clock.dateTime(task.createdAt)} />
          {task.completedAt ? <DetailRow label="Completed" value={clock.dateTime(task.completedAt)} /> : null}
          {task.status === 'blocked' ? (
            <DetailRow
              label="Blocked on"
              value={
                collab.blocked.reason ? (
                  <span className="whitespace-pre-wrap text-danger">
                    {collab.blocked.reason}
                    {collab.blocked.sinceLabel ? <span className="text-muted"> · since {collab.blocked.sinceLabel}</span> : null}
                  </span>
                ) : (
                  <span className="text-muted">No reason recorded.</span>
                )
              }
            />
          ) : null}
          {task.description ? <DetailRow label="Description" value={<span className="whitespace-pre-wrap">{task.description}</span>} /> : null}
        </DetailList>
      </Card>

      <Card>
        <CardHeader
          title="Working the task"
          description={
            collab.progress.total > 0
              ? `${collab.progress.done} of ${collab.progress.total} checklist steps done · ${collab.comments.length} comment${collab.comments.length === 1 ? '' : 's'} · ${collab.attachments.length} attachment${collab.attachments.length === 1 ? '' : 's'}`
              : 'Checklist, comments and attached links — the implementation notes and evidence a task is done through (SCR-041).'
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
  );
}
