import 'server-only';

import { serverEnv } from '@/lib/env';

/**
 * Live Git, read-only — Decision: reversed by the owner on 2026-09-29.
 *
 * 20260922110000_a_repository_is_a_link_too.sql recorded that SCR-042 stays
 * link-based and never reads branch or PR state from a host. The owner
 * reversed that: the panel may READ recent commits, open pull requests and
 * the branch count from GitHub for a repository a project has been linked to.
 *
 * Three properties this file holds:
 *
 *   1. It never throws to the page. Every failure — no token, an
 *      unauthorized or missing repository, a rate limit, a network error, a
 *      timeout — comes back as `{ ok: false, reason }` with the reason in
 *      words the screen shows verbatim, so the Repository tab can say
 *      "not reachable: <reason>" rather than render an empty list that
 *      reads as "nothing happened on this repository".
 *   2. It only ever reads (GET). There is no function here that could write
 *      to GitHub, so a caller cannot reach for one.
 *   3. It caches nothing. What the screen shows was fetched on that request;
 *      the only thing stored in the database is the link itself
 *      (`projects.repository_links`).
 *
 * The token is `GITHUB_TOKEN` through `serverEnv()` — the same validated
 * environment everything else reads — and its absence is a supported state
 * (`githubConfigured()` is false, the fetcher answers `not_configured`),
 * never a crash.
 */

const API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;
const PAGE = 10;

export type GithubCommit = {
  sha: string;
  shortSha: string;
  message: string;
  author: string | null;
  authoredAt: string | null;
  url: string;
};

export type GithubPullRequest = {
  number: number;
  title: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  url: string;
};

export type GithubRepositoryRead = {
  /** The repository as GitHub describes it — its own default branch, so the screen can say when the link's branch differs. */
  repository: { fullName: string; defaultBranch: string; private: boolean; url: string };
  /** The branch the commits were read on — the link's, not GitHub's. */
  branch: string;
  commits: GithubCommit[];
  pullRequests: GithubPullRequest[];
  /** Exact when GitHub paginates its branch list; otherwise the count of one page. */
  branchesCount: number;
  /** The moment the read happened, so the screen can say how fresh it is. */
  readAt: string;
};

export type GithubReadReason =
  | 'not_configured'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'unexpected';

export type GithubReadResult =
  | { ok: true; data: GithubRepositoryRead }
  | { ok: false; reason: GithubReadReason; detail: string };

/** True when a token is present. NEVER the value. */
export function githubConfigured(): boolean {
  try {
    return typeof serverEnv().GITHUB_TOKEN === 'string' && serverEnv().GITHUB_TOKEN!.trim().length > 0;
  } catch {
    return false;
  }
}

/** The words the screen shows for a failed read — the reason, not a paraphrase of it. */
export function describeGithubReason(reason: GithubReadReason): string {
  switch (reason) {
    case 'not_configured':
      return 'GITHUB_TOKEN is not set in this deployment';
    case 'unauthorized':
      return 'GitHub refused the token for this repository (401/403)';
    case 'not_found':
      return 'GitHub has no such repository for this token (404)';
    case 'rate_limited':
      return 'GitHub rate limit reached';
    case 'timeout':
      return `GitHub did not answer within ${TIMEOUT_MS / 1000}s`;
    case 'network':
      return 'GitHub could not be reached';
    case 'unexpected':
      return 'GitHub answered something this reader does not understand';
  }
}

type Fetched<T> = { ok: true; body: T; headers: Headers } | { ok: false; reason: GithubReadReason; detail: string };

async function getJson<T>(token: string, path: string): Promise<Fetched<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API}${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'agencyos-admin',
      },
      signal: controller.signal,
      cache: 'no-store',
    });

    if (response.status === 401 || response.status === 403) {
      // 403 is also how GitHub says "rate limit" — the header tells them apart.
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (response.status === 403 && remaining === '0') {
        return { ok: false, reason: 'rate_limited', detail: `rate limit resets at ${resetAt(response.headers)}` };
      }
      return { ok: false, reason: 'unauthorized', detail: `HTTP ${response.status} on ${path}` };
    }
    if (response.status === 404) return { ok: false, reason: 'not_found', detail: `HTTP 404 on ${path}` };
    if (response.status === 429) {
      return { ok: false, reason: 'rate_limited', detail: `rate limit resets at ${resetAt(response.headers)}` };
    }
    if (!response.ok) return { ok: false, reason: 'unexpected', detail: `HTTP ${response.status} on ${path}` };

    const body = (await response.json()) as T;
    return { ok: true, body, headers: response.headers };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, reason: 'timeout', detail: `no answer within ${TIMEOUT_MS}ms on ${path}` };
    }
    return { ok: false, reason: 'network', detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function resetAt(headers: Headers): string {
  const reset = Number(headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : 'an unstated time';
}

/** The `page=N` of the `rel="last"` link, when GitHub paginated; null otherwise. */
function lastPage(headers: Headers): number | null {
  const link = headers.get('link');
  if (!link) return null;
  const match = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
  return match ? Number(match[1]) : null;
}

type RepoBody = { full_name: string; default_branch: string; private: boolean; html_url: string };
type CommitBody = {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name?: string; date?: string } | null };
  author: { login: string } | null;
};
type PullBody = {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  draft: boolean;
  user: { login: string } | null;
  head: { ref: string };
  base: { ref: string };
};

/**
 * One read of a linked repository: the repository itself, the latest commits
 * on `branch`, the open pull requests, and how many branches there are. Reads
 * only; never throws; the first failure is the answer (a repository that 404s
 * is not then asked for its commits).
 */
export async function readGithubRepository(link: {
  owner: string;
  repo: string;
  branch: string;
}): Promise<GithubReadResult> {
  let token: string | undefined;
  try {
    token = serverEnv().GITHUB_TOKEN?.trim() || undefined;
  } catch (error) {
    return { ok: false, reason: 'unexpected', detail: error instanceof Error ? error.message : String(error) };
  }
  if (!token) return { ok: false, reason: 'not_configured', detail: 'GITHUB_TOKEN is unset' };

  const owner = encodeURIComponent(link.owner);
  const repo = encodeURIComponent(link.repo);
  const base = `/repos/${owner}/${repo}`;

  const repository = await getJson<RepoBody>(token, base);
  if (!repository.ok) return repository;

  const branch = link.branch.trim() || repository.body.default_branch;

  const [commits, pulls, branches] = await Promise.all([
    getJson<CommitBody[]>(token, `${base}/commits?sha=${encodeURIComponent(branch)}&per_page=${PAGE}`),
    getJson<PullBody[]>(token, `${base}/pulls?state=open&sort=updated&direction=desc&per_page=${PAGE}`),
    getJson<unknown[]>(token, `${base}/branches?per_page=1`),
  ]);
  if (!commits.ok) return commits;
  if (!pulls.ok) return pulls;
  if (!branches.ok) return branches;

  if (!Array.isArray(commits.body) || !Array.isArray(pulls.body) || !Array.isArray(branches.body)) {
    return { ok: false, reason: 'unexpected', detail: 'a list endpoint did not answer with a list' };
  }

  return {
    ok: true,
    data: {
      repository: {
        fullName: repository.body.full_name,
        defaultBranch: repository.body.default_branch,
        private: Boolean(repository.body.private),
        url: repository.body.html_url,
      },
      branch,
      commits: commits.body.map((c) => ({
        sha: c.sha,
        shortSha: c.sha.slice(0, 7),
        message: (c.commit?.message ?? '').split('\n')[0] ?? '',
        author: c.author?.login ?? c.commit?.author?.name ?? null,
        authoredAt: c.commit?.author?.date ?? null,
        url: c.html_url,
      })),
      pullRequests: pulls.body.map((p) => ({
        number: p.number,
        title: p.title,
        author: p.user?.login ?? null,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        draft: Boolean(p.draft),
        headBranch: p.head?.ref ?? '',
        baseBranch: p.base?.ref ?? '',
        url: p.html_url,
      })),
      branchesCount: lastPage(branches.headers) ?? branches.body.length,
      readAt: new Date().toISOString(),
    },
  };
}
