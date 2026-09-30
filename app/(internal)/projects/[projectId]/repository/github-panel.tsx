import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import {
  describeGithubReason,
  githubConfigured,
  readGithubBranches,
  readGithubChecks,
  readGithubRepository,
  readGithubReviewFindings,
  readGithubTokenScopes,
} from '@/lib/git/github';
import type { GitAction } from '@/modules/projects/git-queries';
import type { RepositoryLink } from '@/modules/projects/repository-link-queries';
import { Badge, Callout, Card, CardHeader, EmptyState, humanize, IconIntegrations } from '@/ui';

import { LinkRepositoryForm, UnlinkRepositoryButton } from './github-link-forms';
import { CreateTaskBranchPanel, LinkCommitToTaskPanel, MergePullRequestPanel, SubmitReviewPanel, WorkflowFilePanel } from './git-write-panels';

/**
 * The live half of the Repository tab — Decision: reversed by the owner on
 * 2026-09-29 (read) and on 2026-09-30 (write, bucket F / F4). Reads the
 * linked repository from GitHub on THIS request (nothing is cached in the
 * database but the link and the record of what the panel wrote) and shows
 * the latest commits on the linked branch, the open pull requests, the
 * branches, the failed or running check runs on the branch and the review
 * findings on the open pull requests. A read that fails says "not
 * reachable: <reason>" in the fetcher's own words rather than rendering
 * empty lists that would read as "nothing happened". With no token, the
 * panel says GitHub is not configured and shows the link alone.
 *
 * The three write doors (create a task branch, submit a review, squash-merge)
 * and the build trigger's workflow file are below, each a governed door in
 * src/modules/projects/git-write-service.ts; the token's scopes (read once)
 * say up front whether a write can succeed.
 */
export async function GithubPanel({
  projectId,
  link,
  editable,
  mayWriteTask,
  tasks,
  gitActions,
}: {
  projectId: string;
  link: RepositoryLink | null;
  editable: boolean;
  mayWriteTask: boolean;
  tasks: { id: string; title: string; status: string }[];
  gitActions: GitAction[];
}) {
  const clock = await agencyClock();
  const configured = await githubConfigured();
  const scopes = configured ? await readGithubTokenScopes() : null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Live from GitHub</h2>
        <span className="text-xs text-muted">
          {configured ? (
            <span className="text-success">GITHUB_TOKEN configured</span>
          ) : (
            <span className="text-warning">GITHUB_TOKEN not configured</span>
          )}
          {scopes?.ok ? (
            <>
              {' '}
              · scopes: {scopes.data.scopes === null ? 'not stated (fine-grained token)' : scopes.data.scopes.length > 0 ? scopes.data.scopes.join(', ') : 'none'}
              {' '}
              · {scopes.data.mayWrite ? <span className="text-success">may write</span> : <span className="text-danger">cannot write (no repo scope)</span>}
            </>
          ) : scopes ? (
            <> · scopes unknown: {describeGithubReason(scopes.reason)}</>
          ) : null}
        </span>
      </div>

      {!configured ? (
        <Callout tone="warning">
          GitHub is not configured in this deployment: set <code>GITHUB_TOKEN</code> (with the <code>repo</code> scope for the write doors) and the linked
          repository&apos;s commits, open pull requests, branches, checks and review findings are read here. Until then only the link is kept.
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
                {link.workflowFile ? (
                  <>
                    {' '}
                    · build trigger dispatches <code>{link.workflowFile}</code>
                  </>
                ) : (
                  ' · build trigger records only (no workflow file)'
                )}
              </span>
            </div>
            {editable ? <UnlinkRepositoryButton projectId={projectId} /> : null}
          </div>
          {editable ? (
            <div className="mt-3 border-t border-line pt-3">
              <WorkflowFilePanel projectId={projectId} current={link.workflowFile} />
            </div>
          ) : null}
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

      {link && configured ? <LiveRead projectId={projectId} link={link} editable={editable} mayWriteTask={mayWriteTask} tasks={tasks} /> : null}

      {link ? (
        <Card>
          <CardHeader title={`What the panel wrote to GitHub (${gitActions.length})`} description="Every branch created, review submitted, pull request merged and build triggered from here — recorded after GitHub accepted it, audited." />
          <div className="px-4 pb-4 sm:px-5">
            {gitActions.length === 0 ? (
              <p className="text-[13px] text-muted">Nothing written yet.</p>
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
                    {a.taskId ? (
                      <Link href={`/projects/${projectId}/development/tasks/${a.taskId}`} className="text-xs underline-offset-2 hover:underline">
                        task
                      </Link>
                    ) : null}
                    <span className="text-xs text-muted">{clock.dateTime(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      ) : null}

      {editable ? (
        <LinkRepositoryForm
          projectId={projectId}
          current={link ? { owner: link.owner, repo: link.repo, defaultBranch: link.defaultBranch } : null}
        />
      ) : null}
    </section>
  );
}

async function LiveRead({
  projectId,
  link,
  editable,
  mayWriteTask,
  tasks,
}: {
  projectId: string;
  link: RepositoryLink;
  editable: boolean;
  mayWriteTask: boolean;
  tasks: { id: string; title: string; status: string }[];
}) {
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
  const [branches, checks, findings] = await Promise.all([
    readGithubBranches({ owner: link.owner, repo: link.repo }),
    readGithubChecks({ owner: link.owner, repo: link.repo }, branch),
    readGithubReviewFindings({ owner: link.owner, repo: link.repo }, pullRequests.map((p) => p.number)),
  ]);
  const pulls = pullRequests.map((p) => ({ number: p.number, title: p.title }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone="neutral">{branchesCount} {branchesCount === 1 ? 'branch' : 'branches'}</Badge>
        <Badge tone="neutral">{pullRequests.length} open PR{pullRequests.length === 1 ? '' : 's'}</Badge>
        {checks.ok ? (
          <Badge tone={checks.data.failed.length > 0 ? 'danger' : checks.data.pending.length > 0 ? 'warning' : 'success'}>
            {checks.data.failed.length} failed check{checks.data.failed.length === 1 ? '' : 's'}
            {checks.data.pending.length > 0 ? ` · ${checks.data.pending.length} running` : ''}
          </Badge>
        ) : null}
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
          {/* SCR-042 — link a commit to a task. */}
          {mayWriteTask ? (
            <div className="rounded-lg border border-line bg-surface p-3">
              <LinkCommitToTaskPanel projectId={projectId} tasks={tasks} defaultSha={commits[0]?.sha} />
            </div>
          ) : null}
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

        {/* SCR-042 — failed checks, read from GitHub's check runs on the linked branch. */}
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold tracking-tight">
            Checks on <code>{branch}</code>
          </h3>
          {!checks.ok ? (
            <Callout tone="danger">
              Checks not readable: {describeGithubReason(checks.reason)}. <span className="text-muted">({checks.detail})</span>
            </Callout>
          ) : checks.data.checks.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-sm text-muted">No check run on the head of this branch.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {[...checks.data.failed, ...checks.data.pending, ...checks.data.checks.filter((c) => c.status === 'completed' && !checks.data.failed.includes(c))].map((c) => (
                <li key={`${c.name}-${c.completedAt ?? c.status}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px]">
                  <span className="flex items-center gap-2">
                    <Badge tone={c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped' ? 'success' : c.status !== 'completed' ? 'warning' : 'danger'}>
                      {c.conclusion ?? c.status}
                    </Badge>
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer noopener" className="underline-offset-2 hover:underline">
                        {c.name}
                      </a>
                    ) : (
                      c.name
                    )}
                  </span>
                  <span className="text-xs text-muted">{c.completedAt ? clock.dateTime(c.completedAt) : 'running'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* SCR-042 — code-review findings on the open pull requests. */}
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold tracking-tight">Code-review findings</h3>
          {!findings.ok ? (
            <Callout tone="danger">
              Reviews not readable: {describeGithubReason(findings.reason)}. <span className="text-muted">({findings.detail})</span>
            </Callout>
          ) : findings.data.findings.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-sm text-muted">
              {pullRequests.length === 0 ? 'No open pull request, so no review to read.' : 'No review or line comment on the open pull requests.'}
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {findings.data.findings.map((f) => (
                <li key={f.url} className="flex flex-col gap-0.5 px-4 py-2 text-[13px]">
                  <span className="flex flex-wrap items-center gap-2">
                    <a href={f.url} target="_blank" rel="noreferrer noopener" className="font-mono text-xs underline-offset-2 hover:underline">
                      #{f.pullNumber}
                    </a>
                    {f.state ? <Badge tone={f.state === 'APPROVED' ? 'success' : f.state === 'CHANGES_REQUESTED' ? 'danger' : 'neutral'}>{f.state.toLowerCase().replace('_', ' ')}</Badge> : <Badge tone="neutral">line comment</Badge>}
                    {f.path ? (
                      <code className="text-xs">
                        {f.path}
                        {f.line !== null ? `:${f.line}` : ''}
                      </code>
                    ) : null}
                    <span className="text-xs text-muted">
                      {f.author ?? 'unknown'}
                      {f.submittedAt ? ` · ${clock.dateTime(f.submittedAt)}` : ''}
                    </span>
                  </span>
                  {f.body ? <span className="line-clamp-3 whitespace-pre-wrap text-muted">{f.body}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* SCR-042 — branch detail. */}
        <div className="flex flex-col gap-2 xl:col-span-2">
          <h3 className="text-[13px] font-semibold tracking-tight">Branches</h3>
          {!branches.ok ? (
            <Callout tone="danger">
              Branches not readable: {describeGithubReason(branches.reason)}. <span className="text-muted">({branches.detail})</span>
            </Callout>
          ) : (
            <ul className="grid gap-1 rounded-lg border border-line bg-surface p-2 sm:grid-cols-2 lg:grid-cols-3">
              {branches.data.branches.map((b) => (
                <li key={b.name} className="flex items-center justify-between gap-2 px-2 py-1 text-[13px]">
                  <a href={b.url} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate font-mono text-xs underline-offset-2 hover:underline">
                    {b.name}
                  </a>
                  <span className="flex items-center gap-1 text-xs text-muted">
                    {b.protected ? <Badge tone="info">protected</Badge> : null}
                    {b.sha.slice(0, 7)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Git is written — Decision: reversed by the owner on 2026-09-30. The three doors. */}
      {editable || mayWriteTask ? (
        <div className="grid gap-4 xl:grid-cols-3">
          {mayWriteTask ? (
            <Card className="p-4">
              <h3 className="mb-2 text-[13px] font-semibold tracking-tight">Create task branch</h3>
              <CreateTaskBranchPanel projectId={projectId} tasks={tasks.filter((t) => t.status !== 'done')} />
            </Card>
          ) : null}
          {editable ? (
            <Card className="p-4">
              <h3 className="mb-2 text-[13px] font-semibold tracking-tight">Submit review</h3>
              <SubmitReviewPanel projectId={projectId} pulls={pulls} />
            </Card>
          ) : null}
          {editable ? (
            <Card className="p-4">
              <h3 className="mb-2 text-[13px] font-semibold tracking-tight">Approve / reject merge</h3>
              <MergePullRequestPanel projectId={projectId} pulls={pulls} />
              <p className="mt-2 text-xs text-muted">Rejecting is a review that requests changes; merging is the squash above.</p>
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
