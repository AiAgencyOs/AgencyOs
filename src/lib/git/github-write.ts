import 'server-only';

import {
  describeGithubReason,
  githubGet,
  githubToken,
  readGithubChecks,
  readGithubPullRequest,
  readGithubTokenScopes,
  type GithubReadReason,
} from './github';

/**
 * Git is WRITTEN — Decision: reversed by the owner on 2026-09-30 (bucket F,
 * F4). Three writes and one dispatch, and nothing else in `src/` may send
 * anything but GET to api.github.com (tests/git-is-written-by-a-door.test.ts
 * pins that):
 *
 *   createTaskBranch   — a branch `task/<id>-<slug>` from the default branch
 *   submitReview       — approve / request changes / comment on a pull request
 *   mergePullRequest   — squash-merge, REFUSED while a check run is red or
 *                        still running
 *   dispatchWorkflow   — GitHub Actions `workflow_dispatch` of a linked
 *                        workflow file (the build trigger)
 *
 * Each is a pure GitHub call: no database, no session. The governed door is
 * `src/modules/projects/git-write-service.ts`, which checks the capability,
 * calls one of these, and only then records `projects.git_actions` (audited
 * git.branch_created | git.review_submitted | git.merged |
 * git.build_triggered). A GitHub call that failed records nothing.
 *
 * Every function first asks `readGithubTokenScopes()` (read once per
 * process): a classic token whose `X-OAuth-Scopes` lacks `repo` is refused
 * here with `missing_scope`, in words, before anything is sent. A
 * fine-grained token states no scopes; the write is attempted and GitHub's
 * own 403 is the answer. Nothing here throws to a caller.
 */

const API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;

export type GithubWriteReason = GithubReadReason | 'missing_scope' | 'checks_red' | 'not_mergeable' | 'already_exists' | 'refused';

export type GithubWriteResult<T> = { ok: true; data: T } | { ok: false; reason: GithubWriteReason; detail: string };

export function describeGithubWriteReason(reason: GithubWriteReason): string {
  switch (reason) {
    case 'missing_scope':
      return 'GITHUB_TOKEN does not carry the `repo` scope, so GitHub would refuse a write';
    case 'checks_red':
      return 'a check run on the pull request is failed or still running';
    case 'not_mergeable':
      return 'GitHub says the pull request cannot be merged as it stands';
    case 'already_exists':
      return 'that branch already exists';
    case 'refused':
      return 'GitHub refused the write';
    default:
      return describeGithubReason(reason);
  }
}

type Sent<T> = { ok: true; body: T; status: number } | { ok: false; reason: GithubWriteReason; detail: string };

/** The one place in `src/` that sends a non-GET request to GitHub. */
async function githubSend<T>(token: string, method: 'POST' | 'PUT', path: string, payload: unknown): Promise<Sent<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'agencyos-admin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const message = (body as { message?: string } | null)?.message ?? '';

    if (response.status === 401 || response.status === 403) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (response.status === 403 && remaining === '0') return { ok: false, reason: 'rate_limited', detail: `rate limit on ${path}` };
      return { ok: false, reason: 'unauthorized', detail: `HTTP ${response.status} on ${method} ${path}${message ? `: ${message}` : ''}` };
    }
    if (response.status === 404) return { ok: false, reason: 'not_found', detail: `HTTP 404 on ${method} ${path}${message ? `: ${message}` : ''}` };
    if (response.status === 405) return { ok: false, reason: 'not_mergeable', detail: message || 'HTTP 405' };
    if (response.status === 409) return { ok: false, reason: 'not_mergeable', detail: message || 'HTTP 409 (head changed)' };
    if (response.status === 422) {
      if (/already exists/i.test(message)) return { ok: false, reason: 'already_exists', detail: message };
      return { ok: false, reason: 'refused', detail: message || `HTTP 422 on ${method} ${path}` };
    }
    if (response.status === 429) return { ok: false, reason: 'rate_limited', detail: `rate limit on ${path}` };
    if (!response.ok) return { ok: false, reason: 'unexpected', detail: `HTTP ${response.status} on ${method} ${path}${message ? `: ${message}` : ''}` };
    return { ok: true, body: body as T, status: response.status };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, reason: 'timeout', detail: `no answer within ${TIMEOUT_MS}ms on ${method} ${path}` };
    }
    return { ok: false, reason: 'network', detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** The token, refused honestly when absent or when its stated scopes cannot write. */
async function writableToken(): Promise<{ ok: true; token: string } | { ok: false; reason: GithubWriteReason; detail: string }> {
  const token = await githubToken();
  if (!token) return { ok: false, reason: 'not_configured', detail: 'GITHUB_TOKEN is unset' };
  const scopes = await readGithubTokenScopes();
  if (!scopes.ok) return scopes;
  if (!scopes.data.mayWrite) {
    return {
      ok: false,
      reason: 'missing_scope',
      detail: `token scopes: ${scopes.data.scopes && scopes.data.scopes.length > 0 ? scopes.data.scopes.join(', ') : 'none'}`,
    };
  }
  return { ok: true, token };
}

const repoPath = (link: { owner: string; repo: string }) => `/repos/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repo)}`;

/** `task/<id>-<slug>`: the id's first 8 characters keep it unique; the slug keeps it readable; both lowercase. */
export function taskBranchName(taskId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `task/${taskId.slice(0, 8)}${slug ? `-${slug}` : ''}`;
}

export type CreatedBranch = { branch: string; sha: string; fromBranch: string; url: string };

export async function createTaskBranch(input: {
  link: { owner: string; repo: string; defaultBranch: string };
  taskId: string;
  title: string;
}): Promise<GithubWriteResult<CreatedBranch>> {
  const auth = await writableToken();
  if (!auth.ok) return auth;
  const base = repoPath(input.link);
  const branch = taskBranchName(input.taskId, input.title);

  // From the default branch as GitHub names it, not the link's branch to read.
  const repo = await githubGet<{ default_branch: string }>(auth.token, base);
  if (!repo.ok) return repo;
  const fromBranch = repo.body.default_branch;
  const head = await githubGet<{ object: { sha: string } }>(auth.token, `${base}/git/ref/heads/${encodeURIComponent(fromBranch)}`);
  if (!head.ok) return head;
  const sha = head.body.object?.sha;
  if (!sha) return { ok: false, reason: 'unexpected', detail: `no sha on heads/${fromBranch}` };

  const created = await githubSend<{ ref: string; object: { sha: string } }>(auth.token, 'POST', `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  if (!created.ok) return created;
  return {
    ok: true,
    data: { branch, sha, fromBranch, url: `https://github.com/${input.link.owner}/${input.link.repo}/tree/${encodeURIComponent(branch)}` },
  };
}

export const REVIEW_EVENTS = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

export type SubmittedReview = { reviewId: number; state: string; url: string };

export async function submitReview(input: {
  link: { owner: string; repo: string };
  pullNumber: number;
  event: ReviewEvent;
  body: string;
}): Promise<GithubWriteResult<SubmittedReview>> {
  const auth = await writableToken();
  if (!auth.ok) return auth;
  if (input.event !== 'APPROVE' && input.body.trim().length === 0) {
    return { ok: false, reason: 'refused', detail: 'a review that asks for changes or comments says what' };
  }
  const sent = await githubSend<{ id: number; state: string; html_url: string }>(
    auth.token,
    'POST',
    `${repoPath(input.link)}/pulls/${input.pullNumber}/reviews`,
    { event: input.event, ...(input.body.trim() ? { body: input.body.trim() } : {}) },
  );
  if (!sent.ok) return sent;
  return { ok: true, data: { reviewId: sent.body.id, state: sent.body.state, url: sent.body.html_url } };
}

export type MergedPull = { sha: string; headSha: string; title: string; url: string };

/** Squash only, and never over a red or running check. */
export async function mergePullRequest(input: {
  link: { owner: string; repo: string };
  pullNumber: number;
}): Promise<GithubWriteResult<MergedPull>> {
  const auth = await writableToken();
  if (!auth.ok) return auth;

  const pull = await readGithubPullRequest(input.link, input.pullNumber);
  if (!pull.ok) return pull;
  if (pull.data.merged) return { ok: false, reason: 'not_mergeable', detail: `#${input.pullNumber} is already merged` };
  if (pull.data.state !== 'open') return { ok: false, reason: 'not_mergeable', detail: `#${input.pullNumber} is ${pull.data.state}` };
  if (pull.data.draft) return { ok: false, reason: 'not_mergeable', detail: `#${input.pullNumber} is a draft` };

  const checks = await readGithubChecks(input.link, pull.data.headSha);
  if (!checks.ok) return checks;
  if (!checks.data.green) {
    const named = [...checks.data.failed.map((c) => `${c.name}: ${c.conclusion}`), ...checks.data.pending.map((c) => `${c.name}: ${c.status}`)];
    return { ok: false, reason: 'checks_red', detail: named.join(', ') };
  }

  const merged = await githubSend<{ sha: string; merged: boolean; message: string }>(
    auth.token,
    'PUT',
    `${repoPath(input.link)}/pulls/${input.pullNumber}/merge`,
    { merge_method: 'squash', sha: pull.data.headSha },
  );
  if (!merged.ok) return merged;
  if (!merged.body?.merged) return { ok: false, reason: 'refused', detail: merged.body?.message ?? 'GitHub did not merge' };
  return { ok: true, data: { sha: merged.body.sha, headSha: pull.data.headSha, title: pull.data.title, url: pull.data.url } };
}

export type DispatchedWorkflow = { workflowFile: string; ref: string; url: string };

/** GitHub Actions `workflow_dispatch` — answers 204 with no body when accepted. */
export async function dispatchWorkflow(input: {
  link: { owner: string; repo: string };
  workflowFile: string;
  ref: string;
  inputs?: Record<string, string>;
}): Promise<GithubWriteResult<DispatchedWorkflow>> {
  const auth = await writableToken();
  if (!auth.ok) return auth;
  const sent = await githubSend<null>(
    auth.token,
    'POST',
    `${repoPath(input.link)}/actions/workflows/${encodeURIComponent(input.workflowFile)}/dispatches`,
    { ref: input.ref, ...(input.inputs ? { inputs: input.inputs } : {}) },
  );
  if (!sent.ok) return sent;
  return {
    ok: true,
    data: {
      workflowFile: input.workflowFile,
      ref: input.ref,
      url: `https://github.com/${input.link.owner}/${input.link.repo}/actions/workflows/${encodeURIComponent(input.workflowFile)}`,
    },
  };
}
