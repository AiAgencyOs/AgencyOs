import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { agencyClock } from '@/lib/admin/agency-clock';
import { listDevelopmentEvents } from '@/modules/projects/development-events-queries';
import { listCommitLinks, listGitActions } from '@/modules/projects/git-queries';
import { getProject, listDependencies, listDevelopmentBreakdown, readPlanBoard } from '@/modules/projects/queries';
import { Badge, Card, CardHeader, EmptyState, IconProjects, PageHeader, PermissionDenied, Stat, StatGrid, buttonClass, humanize } from '@/ui';

import { AcknowledgeEscalationButton, EscalateBlockerPanel, StartQaHandoffPanel } from '../../../development-events-panels';

import { AddModuleForm, ModuleCard, UnassignedTasks } from '../development-panel';
import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Development' };

/**
 * Phase 5's development breakdown — modules → features → tasks (SCR-039/040).
 * `projects.modules`, `.features` and `.tasks` have had real schema and RLS
 * since 20260813; this is their first reader or writer anywhere in the
 * application. Gated on project.read for viewing, milestone.write / task.write
 * (checked again server-side by the actions themselves) for the writes.
 *
 * Bucket F (migration 20261001130000) — SCR-039: escalating a blocker to
 * the PM and starting the QA handoff are RECORDED (`development_events`)
 * through the same panels the Development dashboard mounts; the handoff is
 * gated in the database on no blocked and no unfinished task. Recent
 * commits (linked to tasks) and Git actions are listed from the rows the
 * panel wrote.
 */
export default async function DevelopmentPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/development`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [{ modules, features, tasks }, board, recordedDependencies, events, commits, gitActions, clock] = await Promise.all([
    listDevelopmentBreakdown(projectId),
    readPlanBoard(projectId),
    listDependencies(projectId),
    listDevelopmentEvents(projectId),
    listCommitLinks(projectId, 10),
    listGitActions(projectId, 10),
    agencyClock(),
  ]);
  const openEscalations = events.filter((e) => (e.kind === 'blocker_escalated' || e.kind === 'dependency_requested') && e.status === 'open');
  const escalatedTaskIds = new Set(openEscalations.filter((e) => e.kind === 'blocker_escalated').map((e) => e.taskId));
  const handoffs = events.filter((e) => e.kind === 'qa_handoff_started');
  const notReady = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').length;
  const mayManage = can(context, 'project.write');
  const canWrite = can(context, 'milestone.write') || can(context, 'task.write');

  const unassignedTasks = tasks.filter((t) => t.moduleId === null);
  // SCR-039 — what development is waiting on, from the registers that hold
  // it: the plan's dependency register (unmet = not yet received and not
  // written off), tasks and features somebody marked blocked, and the
  // unsettled plan questions an "escalate to PM" lands beside.
  const unmetDependencies = board.dependencies.filter((d) => ['pending', 'requested', 'blocked'].includes(d.status));
  // SCR-043: the technical register's open rows — closed from the Builds tab.
  const openTechnical = recordedDependencies.filter((d) => d.status === 'open');
  const blockedTasks = tasks.filter((t) => t.status === 'blocked');
  const blockedFeatures = features.filter((f) => f.status === 'blocked');
  const openQuestions = board.clarifications.filter((c) => c.status !== 'resolved' && c.status !== 'routed_to_change_request');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Development`}
        description={
          modules.length === 0
            ? 'No modules broken down yet.'
            : `${modules.length} module${modules.length === 1 ? '' : 's'}, ${tasks.length} task${tasks.length === 1 ? '' : 's'}.`
        }
      />

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={4}>
        <Stat
          label="Unmet dependencies"
          value={String(unmetDependencies.length)}
          tone={unmetDependencies.some((d) => d.status === 'blocked') ? 'danger' : unmetDependencies.length > 0 ? 'warning' : 'success'}
          caption={board.plan ? `on plan v${board.plan.version}` : 'no plan yet'}
        />
        <Stat label="Blocked tasks" value={String(blockedTasks.length)} tone={blockedTasks.length > 0 ? 'danger' : 'success'} />
        <Stat label="Blocked features" value={String(blockedFeatures.length)} tone={blockedFeatures.length > 0 ? 'warning' : 'success'} />
        <Stat
          label="Open questions"
          value={String(openQuestions.length)}
          tone={openQuestions.length > 0 ? 'warning' : 'success'}
          href={`/projects/${projectId}/plan`}
        />
      </StatGrid>

      <Card>
        <CardHeader
          title="Dependencies and blockers"
          description="What is in the way, from the registers that hold it. A blocked task is escalated to the PM here, with a reason, and recorded; the QA handoff is recorded here too, and refused while a task is blocked or not yet in review."
          actions={
            <span className="flex flex-wrap gap-2">
              {mayManage ? <StartQaHandoffPanel projectId={projectId} blocked={blockedTasks.length} notReady={notReady} /> : null}
              <Link href={`/projects/${projectId}/qa`} className={buttonClass('ghost', 'sm')}>
                QA tab
              </Link>
            </span>
          }
        />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          {unmetDependencies.length === 0 && openTechnical.length === 0 && blockedTasks.length === 0 && blockedFeatures.length === 0 ? (
            <p className="text-[13px] text-muted">Nothing is recorded as in the way.</p>
          ) : null}
          {unmetDependencies.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {unmetDependencies.map((d) => (
                <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                  <span className="font-medium">{d.description}</span>
                  <span className="flex items-center gap-2 text-muted">
                    {d.kind.replace(/_/g, ' ')} · by {d.neededByPhase.replace('_', ' ')} · {d.ownerRole}
                    <Badge tone={d.status === 'blocked' ? 'danger' : 'warning'}>{d.status}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {openTechnical.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {openTechnical.map((d) => (
                <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                  <span className="font-medium">{d.name}{d.version ? <span className="text-muted"> {d.version}</span> : null}</span>
                  <span className="flex items-center gap-2 text-muted">
                    technical dependency
                    <Badge tone="warning">open</Badge>
                    <Link href={`/projects/${projectId}/builds`} className="text-xs underline underline-offset-2">mark supplied</Link>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {blockedFeatures.length > 0 || blockedTasks.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {blockedFeatures.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                  <Badge tone="warning">feature blocked</Badge>
                  <span className="font-medium">{f.name}</span>
                </li>
              ))}
              {blockedTasks.map((t) => (
                <li key={t.id} className="flex flex-col gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone="danger">task blocked</Badge>
                    <Link href={`/projects/${projectId}/development/tasks/${t.id}`} className="font-medium underline-offset-2 hover:underline">
                      {t.title}
                    </Link>
                    {escalatedTaskIds.has(t.id) ? <Badge tone="warning">with the PM</Badge> : null}
                  </span>
                  {canWrite && !escalatedTaskIds.has(t.id) ? <EscalateBlockerPanel projectId={projectId} taskId={t.id} taskTitle={t.title} /> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {recordedDependencies.length > 0 ? (
            <p className="text-xs text-muted">
              {recordedDependencies.length} technical dependenc{recordedDependencies.length === 1 ? 'y' : 'ies'} recorded on the{' '}
              <Link href={`/projects/${projectId}/builds`} className="underline underline-offset-2">
                Builds tab
              </Link>
              .
            </p>
          ) : null}
        </div>
      </Card>

      {/* SCR-039 — the escalation and handoff record, and recent commits / Git actions. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={`Escalations and handoffs (${events.length})`} description={`${openEscalations.length} open escalation${openEscalations.length === 1 ? '' : 's'} · ${handoffs.length} QA handoff${handoffs.length === 1 ? '' : 's'} recorded.`} />
          <div className="px-4 pb-4 sm:px-5">
            {events.length === 0 ? (
              <p className="text-[13px] text-muted">Nothing escalated and no handoff started yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {events.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-2">
                        <Badge tone={e.kind === 'qa_handoff_started' ? 'success' : e.status === 'open' ? 'warning' : 'neutral'}>{humanize(e.kind)}</Badge>
                        <span className="text-xs text-muted">{clock.dateTime(e.createdAt)} · {e.status}</span>
                      </span>
                      {e.reason ? <span className="text-muted">{e.reason}</span> : null}
                    </span>
                    {mayManage && (e.kind === 'blocker_escalated' || e.kind === 'dependency_requested') && e.status === 'open' ? <AcknowledgeEscalationButton projectId={projectId} eventId={e.id} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title={`Recent commits and builds (${commits.length + gitActions.length})`} description="Commits linked to tasks and what the panel did on GitHub — branches, reviews, merges, build triggers." actions={<Link href={`/projects/${projectId}/repository`} className="text-xs underline hover:text-foreground">Repository</Link>} />
          <div className="px-4 pb-4 sm:px-5">
            {commits.length === 0 && gitActions.length === 0 ? (
              <p className="text-[13px] text-muted">No commit linked and no Git action recorded yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {gitActions.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                    <Badge tone={a.action === 'merged' ? 'success' : 'info'}>{humanize(a.action)}</Badge>
                    {a.url ? (
                      <a href={a.url} target="_blank" rel="noreferrer noopener" className="font-mono text-xs underline-offset-2 hover:underline">
                        {a.reference}
                      </a>
                    ) : (
                      <span className="font-mono text-xs">{a.reference}</span>
                    )}
                    <span className="text-xs text-muted">{a.repository} · {clock.dateTime(a.createdAt)}</span>
                  </li>
                ))}
                {commits.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                    <Badge tone="neutral">commit</Badge>
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer noopener" className="font-mono text-xs underline-offset-2 hover:underline">
                        {c.shortSha}
                      </a>
                    ) : (
                      <span className="font-mono text-xs">{c.shortSha}</span>
                    )}
                    <Link href={`/projects/${projectId}/development/tasks/${c.taskId}`} className="min-w-0 flex-1 truncate underline-offset-2 hover:underline">
                      {c.taskTitle}
                    </Link>
                    <span className="text-xs text-muted">{clock.dateTime(c.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      {modules.length > 0 ? (
        <div className="flex flex-col gap-4">
          {modules.map((m) => (
            <ModuleCard
              key={m.id}
              module={m}
              features={features.filter((f) => f.moduleId === m.id)}
              tasks={tasks.filter((t) => t.moduleId === m.id)}
              projectId={projectId}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<IconProjects size={22} />}
          title="No modules yet"
          description="Break the project into modules once the implementation plan is ready."
        />
      )}

      {unassignedTasks.length > 0 || canWrite ? (
        <UnassignedTasks projectId={projectId} tasks={unassignedTasks} />
      ) : null}

      {canWrite ? <AddModuleForm projectId={projectId} /> : null}
    </div>
  );
}
