import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listDevelopmentBreakdown } from '@/modules/projects/queries';
import { EmptyState, IconProjects, PageHeader } from '@/ui';

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
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const { modules, features, tasks } = await listDevelopmentBreakdown(projectId);
  const canWrite = can(context.role, 'milestone.write') || can(context.role, 'task.write');

  const unassignedTasks = tasks.filter((t) => t.moduleId === null);

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
