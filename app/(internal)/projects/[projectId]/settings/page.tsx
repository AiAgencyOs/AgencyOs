import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject } from '@/modules/projects/queries';
import { Callout, PageHeader, PermissionDenied } from '@/ui';

import { ProjectDetailsForm, ProjectVisibilityForm } from '../settings-panel';
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
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const canWrite = can(context.role, 'project.write');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={`${project.name} — Settings`} description="Project-level configuration." />

      <ProjectSubNav projectId={projectId} />

      {canWrite ? (
        <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5">
          <h2 className="text-sm font-semibold tracking-tight">Project details</h2>
          <p className="text-[13px] text-muted">The name, description, dates and budget the header and the projects list print. Status is changed on the Overview; billing on its own section.</p>
          <ProjectDetailsForm
            projectId={projectId}
            name={project.name}
            description={project.description}
            startsOn={project.starts_on}
            endsOn={project.ends_on}
            budgetMinor={project.budget_minor}
            currency={project.currency}
          />
        </section>
      ) : null}

      {canWrite ? (
        <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5">
          <h2 className="text-sm font-semibold tracking-tight">Client portal visibility</h2>
          <ProjectVisibilityForm projectId={projectId} current={project.visibility} />
        </section>
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
