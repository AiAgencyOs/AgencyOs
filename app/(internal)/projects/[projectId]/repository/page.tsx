import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listGitActions, listTaskOptions } from '@/modules/projects/git-queries';
import { getProject, listRepositories } from '@/modules/projects/queries';
import { getRepositoryLink } from '@/modules/projects/repository-link-queries';
import { ACCESS_LEVEL_LABEL, ACCESS_LEVEL_NEEDS, ACCESS_LEVELS, MERGE_ROLE_LABEL } from '@/modules/projects/repository-policy';
import { Badge, Callout, Card, CardHeader, DomainSearch, EmptyState, IconIntegrations, PageHeader, PermissionDenied } from '@/ui';

import { AddRepositoryForm, RepositoryCard } from '../repository-panel';
import { ProjectSubNav } from '../project-subnav';
import { GithubPanel } from './github-panel';
import { RepositoryPolicyForm } from './policy-panel';

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
 *
 * Decision: reversed by the owner on 2026-09-30 — Git is WRITTEN too
 * (bucket F, F4): a task branch, a review and a squash-merge go through the
 * governed doors in src/modules/projects/git-write-service.ts, each recorded
 * in projects.git_actions and audited; commits are linked to tasks; failed
 * checks and review findings are read from GitHub beside them.
 */
export default async function RepositoryPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ q?: string }> }) {
  const { projectId } = await params;
  const q = ((await searchParams).q ?? '').trim().slice(0, 120);

  const context = await requireInternal(`/projects/${projectId}/repository`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const editable = can(context, 'project.write');
  const mayWriteTask = can(context, 'task.write');
  const [repositories, link, tasks, gitActions] = await Promise.all([listRepositories(projectId), getRepositoryLink(projectId), listTaskOptions(projectId), listGitActions(projectId)]);

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

      {/* SCR-042 — least privilege and the merge policy, per repository. */}
      {link ? (
        <Card>
          <CardHeader
            title="Access and Merge Policy"
            description={`${link.owner}/${link.repo}. The GitHub token is organisation-wide; this limits what the panel will do with it in this repository, and every write door checks it first.`}
          />
          <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <Badge tone={link.accessLevel === 'full' ? 'warning' : 'success'}>{ACCESS_LEVEL_LABEL[link.accessLevel]}</Badge>
              <span className="text-muted">
                Merge: {MERGE_ROLE_LABEL[link.mergeRole].toLowerCase()} · {link.mergeMinApprovals} approving review{link.mergeMinApprovals === 1 ? '' : 's'} · green checks always required
              </span>
            </div>
            <dl className="grid gap-2 text-[13px] md:grid-cols-3">
              {ACCESS_LEVELS.map((l) => (
                <div key={l} className={`rounded-md border p-2 ${l === link.accessLevel ? 'border-brand bg-brand-soft/40' : 'border-line'}`}>
                  <dt className="font-medium">{ACCESS_LEVEL_LABEL[l]}{l === link.accessLevel ? ' (current)' : ''}</dt>
                  <dd>
                    <ul className="mt-1 list-disc pl-4 text-xs text-muted">
                      {ACCESS_LEVEL_NEEDS[l].map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted">The token should carry no more than the current level needs. The panel cannot shrink the token itself; it can refuse to use it for more.</p>
            {can(context, 'project.sign_off') ? (
              <RepositoryPolicyForm projectId={projectId} accessLevel={link.accessLevel} mergeMinApprovals={link.mergeMinApprovals} mergeRole={link.mergeRole} />
            ) : (
              <p className="text-xs text-muted">Only an owner or ops admin changes the policy.</p>
            )}
          </div>
        </Card>
      ) : null}

      {link ? <DomainSearch action={`/projects/${projectId}/repository`} value={q} placeholder="Search commits, branches and pull requests…" label="Search the repository" /> : null}

      <GithubPanel projectId={projectId} q={q} link={link} editable={editable} mayWriteTask={mayWriteTask} tasks={tasks} gitActions={gitActions} />

      <h2 className="text-[13px] font-semibold tracking-tight">Repository links</h2>
      <Callout tone="info">
        These are links to where the code and its reviews actually live, typed by a person. Branch and review
        state on these rows is whatever was typed in, not read from the host — the live panel above is the only
        thing on this page that asks GitHub, or writes to it.
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
