import { agencyClock } from '@/lib/admin/agency-clock';
import { describeGithubReason, githubConfigured, readGithubRepository } from '@/lib/git/github';
import type { RepositoryLink } from '@/modules/projects/repository-link-queries';
import { Badge, Callout, Card, EmptyState, IconIntegrations } from '@/ui';

import { LinkRepositoryForm, UnlinkRepositoryButton } from './github-link-forms';

/**
 * The live half of the Repository tab — Decision: reversed by the owner on
 * 2026-09-29. Reads the linked repository from GitHub on THIS request
 * (nothing is cached in the database but the link) and shows the latest
 * commits on the linked branch, the open pull requests and the branch count.
 * A read that fails says "not reachable: <reason>" in the fetcher's own
 * words rather than rendering empty lists that would read as "nothing
 * happened". With no token, the panel says GitHub is not configured and
 * shows the link alone.
 */
export async function GithubPanel({
  projectId,
  link,
  editable,
}: {
  projectId: string;
  link: RepositoryLink | null;
  editable: boolean;
}) {
  const clock = await agencyClock();
  const configured = githubConfigured();

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Live from GitHub</h2>
        <span className="text-xs text-muted">
          {configured ? (
            <span className="text-success">GITHUB_TOKEN configured</span>
          ) : (
            <span className="text-warning">GITHUB_TOKEN not configured</span>
          )}{' '}
          · read-only
        </span>
      </div>

      {!configured ? (
        <Callout tone="warning">
          GitHub is not configured in this deployment: set <code>GITHUB_TOKEN</code> and the linked repository&apos;s
          commits, open pull requests and branches are read here. Until then only the link is kept.
        </Callout>
      ) : null}

      {link ? (
        <Card className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <a
                href={`https://github.com/${link.owner}/${link.repo}`}
                target="_blank"
                rel="noreferrer noopener"
                className="block truncate text-sm font-medium underline-offset-2 hover:underline"
              >
                {link.owner}/{link.repo}
              </a>
              <span className="block text-xs text-muted">
                GitHub · reads branch <code>{link.defaultBranch}</code> · linked {clock.dateTime(link.linkedAt)}
              </span>
            </div>
            {editable ? <UnlinkRepositoryButton projectId={projectId} /> : null}
          </div>
        </Card>
      ) : (
        <EmptyState
          icon={<IconIntegrations size={22} />}
          title="No GitHub repository linked"
          description={
            editable
              ? 'Link one below to read its commits and pull requests here.'
              : 'An owner, ops admin or delivery lead can link one.'
          }
        />
      )}

      {link && configured ? <LiveRead link={link} /> : null}

      {editable ? (
        <LinkRepositoryForm
          projectId={projectId}
          current={link ? { owner: link.owner, repo: link.repo, defaultBranch: link.defaultBranch } : null}
        />
      ) : null}
    </section>
  );
}

async function LiveRead({ link }: { link: RepositoryLink }) {
  const clock = await agencyClock();
  const read = await readGithubRepository({ owner: link.owner, repo: link.repo, branch: link.defaultBranch });

  if (!read.ok) {
    return (
      <Callout tone="danger">
        Not reachable: {describeGithubReason(read.reason)}. <span className="text-muted">({read.detail})</span>
      </Callout>
    );
  }

  const { repository, branch, commits, pullRequests, branchesCount, readAt } = read.data;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone="neutral">{branchesCount} {branchesCount === 1 ? 'branch' : 'branches'}</Badge>
        <Badge tone="neutral">{pullRequests.length} open PR{pullRequests.length === 1 ? '' : 's'}</Badge>
        {repository.private ? <Badge tone="warning">private</Badge> : null}
        <span>
          read {clock.dateTime(readAt)} · GitHub&apos;s default branch is <code>{repository.defaultBranch}</code>
          {repository.defaultBranch !== branch ? (
            <span className="text-warning"> — this page reads <code>{branch}</code></span>
          ) : null}
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold tracking-tight">
            Latest commits on <code>{branch}</code>
          </h3>
          {commits.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-sm text-muted">
              GitHub returned no commits on this branch.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {commits.map((c) => (
                <li key={c.sha} className="flex flex-col gap-0.5 px-4 py-2 text-[13px]">
                  <span className="flex flex-wrap items-baseline gap-2">
                    <a href={c.url} target="_blank" rel="noreferrer noopener" className="font-mono text-xs underline-offset-2 hover:underline">
                      {c.shortSha}
                    </a>
                    <span className="min-w-0 flex-1 truncate">{c.message}</span>
                  </span>
                  <span className="text-xs text-muted">
                    {c.author ?? 'unknown author'}
                    {c.authoredAt ? ` · ${clock.dateTime(c.authoredAt)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold tracking-tight">Open pull requests</h3>
          {pullRequests.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-sm text-muted">
              No open pull requests.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {pullRequests.map((p) => (
                <li key={p.number} className="flex flex-col gap-0.5 px-4 py-2 text-[13px]">
                  <span className="flex flex-wrap items-baseline gap-2">
                    <a href={p.url} target="_blank" rel="noreferrer noopener" className="font-mono text-xs underline-offset-2 hover:underline">
                      #{p.number}
                    </a>
                    <span className="min-w-0 flex-1 truncate">{p.title}</span>
                    {p.draft ? <Badge tone="neutral">draft</Badge> : null}
                  </span>
                  <span className="text-xs text-muted">
                    {p.author ?? 'unknown author'} · <code>{p.headBranch}</code> → <code>{p.baseBranch}</code> · updated{' '}
                    {clock.dateTime(p.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
