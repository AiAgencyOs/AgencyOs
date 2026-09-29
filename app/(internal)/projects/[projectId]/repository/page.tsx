import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getProject, listRepositories } from '@/modules/projects/queries';
import { getRepositoryLink } from '@/modules/projects/repository-link-queries';
import { Callout, EmptyState, IconIntegrations, PageHeader, PermissionDenied } from '@/ui';

import { AddRepositoryForm, RepositoryCard } from '../repository-panel';
import { ProjectSubNav } from '../project-subnav';
import { GithubPanel } from './github-panel';

export const metadata: Metadata = { title: 'Repository' };

/**
 * SCR-042 — Repository, Branch & Code Review. Link-based, confirmed with the
 * owner (2026-09-22): a repository row records where the code and its
 * reviews live, never a live branch or PR state pulled from an API this
 * product does not integrate with — see the migration
 * (20260922110000_a_repository_is_a_link_too.sql) for the full reasoning.
 * `defaultBranch` is therefore a fact somebody typed, not one this page
 * verifies against the host.
 *
 * Decision: reversed by the owner on 2026-09-29 — the tab ALSO carries one
 * live GitHub repository per project (`projects.repository_links`): linked
 * and unlinked through a governed door, read on each request through
 * src/lib/git/github.ts with `GITHUB_TOKEN` (commits on the linked branch,
 * open pull requests, branch count), never written to, and honest about a
 * read that fails or a token that is absent. The link rows below stay what
 * they were: where the code and its reviews live, typed by a person.
 */
export default async function RepositoryPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/repository`);
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const editable = can(context.role, 'project.write');
  const [repositories, link] = await Promise.all([listRepositories(projectId), getRepositoryLink(projectId)]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${project.name} — Repository`}
        description={
          repositories.length === 0
            ? 'No repositories linked yet.'
            : `${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'}.`
        }
      />

      <ProjectSubNav projectId={projectId} />

      <GithubPanel projectId={projectId} link={link} editable={editable} />

      <h2 className="text-[13px] font-semibold tracking-tight">Repository links</h2>
      <Callout tone="info">
        These are links to where the code and its reviews actually live, typed by a person. Branch and review
        state on these rows is whatever was typed in, not read from the host — the live read above is the only
        thing on this page that asks GitHub.
      </Callout>

      {repositories.length > 0 ? (
        <div className="flex flex-col gap-2">
          {repositories.map((r) => (
            <RepositoryCard key={r.id} repo={r} projectId={projectId} editable={editable} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<IconIntegrations size={22} />}
          title="No repositories yet"
          description="Link the repository below once there is one to point at."
        />
      )}

      {editable ? <AddRepositoryForm projectId={projectId} /> : null}
    </div>
  );
}
