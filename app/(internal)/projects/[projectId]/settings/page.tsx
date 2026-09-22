import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject } from '@/modules/projects/queries';
import { Callout, PageHeader } from '@/ui';

import { ProjectVisibilityForm } from '../settings-panel';
import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Settings' };

/**
 * SCR-027's Settings half. Confirmed genuinely missing: `visibility` is the
 * one project-level field with a real, standing effect (the client portal's
 * RLS) and no admin control anywhere before this. Templates (the other
 * PDF ask under this screen number) stays undone — there is no project-
 * template concept anywhere in the schema, and defining what one copies
 * (tasks? milestones? modules?) is a product decision, not a code gap.
 */
export default async function ProjectSettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/settings`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const canWrite = can(context.role, 'project.write');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={`${project.name} — Settings`} description="Project-level configuration." />

      <ProjectSubNav projectId={projectId} />

      {canWrite ? (
        <ProjectVisibilityForm projectId={projectId} current={project.visibility} />
      ) : (
        <Callout tone="info">
          Client portal visibility is currently <strong>{project.visibility}</strong>. You do not have
          permission to change it.
        </Callout>
      )}

      <Callout tone="info">
        Project templates are not built — nothing in this product defines what a template copies
        (tasks, milestones, modules), so this page does not invent one.
      </Callout>
    </div>
  );
}
