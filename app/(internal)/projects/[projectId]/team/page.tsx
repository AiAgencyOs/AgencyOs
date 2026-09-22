import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listProjectTeam } from '@/modules/projects/queries';
import { Card, EmptyState, humanize, IconUser, PageHeader } from '@/ui';

import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Team' };

/**
 * SCR-025 — Project Team. Confirmed genuinely missing by the traceability
 * sweep: there is no `project_members` table, and `listInternalRoster`
 * elsewhere in this module is agency-wide, not per-project. Rather than
 * inventing a membership model, this reads the one fact the schema already
 * carries — who is assigned a task on this project — so the roster is
 * exactly who is doing the work, never a name added once and forgotten.
 *
 * That also means a person appears here only once they've been assigned
 * something: a PM who has only reviewed a design and never held a task will
 * not show up, which is the honest boundary of what task assignment can say
 * — not a design decision this page invents on its own.
 */
export default async function ProjectTeamPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/team`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const team = await listProjectTeam(projectId);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={`${project.name} — Team`} description="Everyone with a task assigned on this project." />

      <ProjectSubNav projectId={projectId} />

      {team.length > 0 ? (
        <Card>
          <ul className="divide-y divide-line">
            {team.map((m) => (
              <li key={m.userId} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-[13px] font-semibold uppercase text-brand">
                    {m.fullName.slice(0, 2)}
                  </span>
                  <div className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{m.fullName}</span>
                    <span className="block truncate text-xs text-muted">{humanize(m.role)}</span>
                  </div>
                </div>
                <span className="shrink-0 text-xs font-medium text-muted tabular">
                  {m.tasksDone}/{m.tasksTotal} tasks done
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState
          icon={<IconUser size={22} />}
          title="No one assigned yet"
          description="A person shows up here the first time a task on this project is assigned to them."
        />
      )}
    </div>
  );
}
