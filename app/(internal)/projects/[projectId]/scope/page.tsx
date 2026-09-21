import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, readScopeBaseline } from '@/modules/projects/queries';
import { EmptyState, IconProjects, PageHeader } from '@/ui';

import { OpenScopeVersionForm, ScopeVersionCard } from '../scope-panel';
import { ProjectSubNav } from '../project-subnav';

export const metadata: Metadata = { title: 'Scope' };

/**
 * The scope baseline (Doc 11 §3, §29) — Requirements & Scope's core screen
 * (SCR-030). Every accepted requirement becomes a frozen scope version that
 * QA's test plan and a change request both cite by foreign key, so "is this
 * in scope" has one answer. Gated on project.read for viewing, milestone.write
 * for the writes (re-checked server-side by the actions).
 */
export default async function ScopePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/scope`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const { active, draft } = await readScopeBaseline(projectId);
  const canWrite = can(context.role, 'milestone.write');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Scope`}
        description="The frozen baseline everything downstream — the test plan, a change request — is measured against."
      />

      <ProjectSubNav projectId={projectId} />

      {draft ? <ScopeVersionCard projectId={projectId} scopeVersion={draft} editable={canWrite} /> : null}

      {active ? (
        <ScopeVersionCard projectId={projectId} scopeVersion={active} editable={false} />
      ) : !draft ? (
        <EmptyState
          icon={<IconProjects size={22} />}
          title="No scope baseline yet"
          description="Open a draft, add what is in and out of scope, then freeze it once it is complete."
        />
      ) : null}

      {canWrite && !draft ? <OpenScopeVersionForm projectId={projectId} /> : null}
    </div>
  );
}
