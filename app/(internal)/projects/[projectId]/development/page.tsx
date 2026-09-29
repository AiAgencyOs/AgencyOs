import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDependencies, listDevelopmentBreakdown, readPlanBoard } from '@/modules/projects/queries';
import { Badge, Card, CardHeader, EmptyState, IconProjects, PageHeader, PermissionDenied, Stat, StatGrid, buttonClass } from '@/ui';

import { AddModuleForm, ModuleCard, UnassignedTasks } from '../development-panel';
import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Development' };

/**
 * Phase 5's development breakdown — modules → features → tasks (SCR-039/040).
 * `projects.modules`, `.features` and `.tasks` have had real schema and RLS
 * since 20260813; this is their first reader or writer anywhere in the
 * application. Gated on project.read for viewing, milestone.write / task.write
 * (checked again server-side by the actions themselves) for the writes.
 */
export default async function DevelopmentPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/development`);
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [{ modules, features, tasks }, board, recordedDependencies] = await Promise.all([
    listDevelopmentBreakdown(projectId),
    readPlanBoard(projectId),
    listDependencies(projectId),
  ]);
  const canWrite = can(context.role, 'milestone.write') || can(context.role, 'task.write');

  const unassignedTasks = tasks.filter((t) => t.moduleId === null);
  // SCR-039 — what development is waiting on, from the registers that hold
  // it: the plan's dependency register (unmet = not yet received and not
  // written off), tasks and features somebody marked blocked, and the
  // unsettled plan questions an "escalate to PM" lands beside.
  const unmetDependencies = board.dependencies.filter((d) => ['pending', 'requested', 'blocked'].includes(d.status));
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
          description="What is in the way, from the registers that hold it. Escalating sends a person to the plan's questions; a QA handoff starts on the QA tab against the frozen baseline."
          actions={
            <span className="flex flex-wrap gap-2">
              <Link href={`/projects/${projectId}/plan`} className={buttonClass('secondary', 'sm')}>
                Escalate to the PM
              </Link>
              <Link href={`/projects/${projectId}/qa`} className={buttonClass('primary', 'sm')}>
                Start QA handoff
              </Link>
            </span>
          }
        />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          {unmetDependencies.length === 0 && blockedTasks.length === 0 && blockedFeatures.length === 0 ? (
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
          {blockedFeatures.length > 0 || blockedTasks.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {blockedFeatures.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                  <Badge tone="warning">feature blocked</Badge>
                  <span className="font-medium">{f.name}</span>
                </li>
              ))}
              {blockedTasks.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                  <Badge tone="danger">task blocked</Badge>
                  <Link href={`/projects/${projectId}/development/tasks/${t.id}`} className="font-medium underline-offset-2 hover:underline">
                    {t.title}
                  </Link>
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
