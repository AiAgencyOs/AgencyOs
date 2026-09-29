import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

/**
 * Git is written by a door — Decision: reversed by the owner on 2026-09-30
 * (bucket F, F4).
 *
 * Three things this pins:
 *
 *   A. Every write to GitHub in `src/` goes through
 *      src/lib/git/github-write.ts — the only file that sends anything but
 *      GET to api.github.com — and the only caller of that file is the
 *      governed service, which records `projects.git_actions` (audited
 *      git.branch_created | git.review_submitted | git.merged |
 *      git.build_triggered) AFTER GitHub accepted the write, never before.
 *   B. A token whose stated scopes lack `repo` is refused before anything is
 *      sent (`missing_scope`), proved by driving the real functions against a
 *      stubbed fetch: no non-GET request leaves the process.
 *   C. A squash-merge is refused while a check run is red or still running.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';
process.env.GITHUB_TOKEN = 'ghp_test_token_not_a_real_credential';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const WRITE = read('src/lib/git/github-write.ts');
const READ = read('src/lib/git/github.ts');
const SERVICE = read('src/modules/projects/git-write-service.ts');
const MIGRATION = read('supabase/migrations/20261001130000_a_design_has_activity_assets_have_states_and_git_is_written.sql');

// ── the stubbed GitHub ──────────────────────────────────────────────────────

type Call = { method: string; url: string; body: unknown };
const calls: Call[] = [];
let scopesHeader: string | null = 'repo, workflow';
let checkRuns: { name: string; status: string; conclusion: string | null }[] = [];
const realFetch = globalThis.fetch;

function respond(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const path = url.replace('https://api.github.com', '');
    if (path === '/user') return respond({ login: 'agencyos-bot' }, 200, scopesHeader === null ? {} : { 'x-oauth-scopes': scopesHeader });
    if (path === '/repos/acme/site') return respond({ full_name: 'acme/site', default_branch: 'main', private: true, html_url: 'https://github.com/acme/site' });
    if (path === '/repos/acme/site/git/ref/heads/main') return respond({ object: { sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } });
    if (path === '/repos/acme/site/git/refs' && method === 'POST') return respond({ ref: 'refs/heads/x', object: { sha: 'deadbeef' } }, 201);
    if (path === '/repos/acme/site/pulls/7') return respond({ number: 7, title: 'Fix login', html_url: 'https://github.com/acme/site/pull/7', state: 'open', merged: false, draft: false, head: { ref: 'task/abcd1234-fix', sha: 'cafebabecafebabecafebabecafebabecafebabe' }, base: { ref: 'main' }, created_at: '', updated_at: '', user: null });
    if (path.startsWith('/repos/acme/site/commits/') && path.includes('/check-runs')) return respond({ total_count: checkRuns.length, check_runs: checkRuns.map((c) => ({ ...c, html_url: null, completed_at: null })) });
    if (path === '/repos/acme/site/pulls/7/merge' && method === 'PUT') return respond({ sha: 'feedfacefeedface', merged: true, message: 'Pull Request successfully merged' });
    if (path === '/repos/acme/site/pulls/7/reviews' && method === 'POST') return respond({ id: 99, state: 'CHANGES_REQUESTED', html_url: 'https://github.com/acme/site/pull/7#pullrequestreview-99' });
    if (path.startsWith('/repos/acme/site/actions/workflows/') && method === 'POST') return respond(null, 204);
    return respond({ message: `unexpected ${method} ${path}` }, 500);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

const nonGet = () => calls.filter((c) => c.method !== 'GET');

describe('A. the only file that writes to GitHub', () => {
  test('api.github.com is named in exactly two files under src/, and only github-write.ts sends a non-GET', () => {
    const files = walk(join(root, 'src')).filter((f) => readFileSync(f, 'utf8').includes('api.github.com'));
    assert.deepEqual(files.map((f) => f.replace(root, '')).sort(), ['src/lib/git/github-write.ts', 'src/lib/git/github.ts']);
    assert.doesNotMatch(READ, /method:\s*['"`](POST|PUT|PATCH|DELETE)/);
    assert.match(READ, /method: 'GET'/);
    assert.equal((WRITE.match(/\bfetch\(/g) ?? []).length, 1, 'one fetch call, in githubSend');
    assert.match(WRITE, /async function githubSend<T>\(token: string, method: 'POST' \| 'PUT'/);
  });

  test('nothing else in src/ or app/ imports github-write.ts but the governed service', () => {
    const importers = [...walk(join(root, 'src')), ...walk(join(root, 'app'))]
      .filter((f) => /from '@\/lib\/git\/github-write'|from '\.\/github-write'/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(root, ''))
      .sort();
    assert.deepEqual(importers, ['src/modules/projects/git-write-service.ts']);
  });

  test('every write door checks the capability, calls GitHub, and records git_actions only after GitHub accepted', () => {
    for (const [door, cap, call, action] of [
      ['createTaskBranch', 'task.write', 'githubCreateTaskBranch', 'branch_created'],
      ['submitReview', 'project.write', 'githubSubmitReview', 'review_submitted'],
      ['mergePullRequest', 'project.write', 'githubMergePullRequest', 'merged'],
      ['triggerBuild', 'project.write', 'dispatchWorkflow', 'build_triggered'],
    ] as const) {
      const start = SERVICE.indexOf(`export async function ${door}(`);
      assert.ok(start > 0, `${door} exists`);
      const end = SERVICE.indexOf('\nexport async function', start + 1);
      const body = SERVICE.slice(start, end === -1 ? undefined : end);
      assert.match(body, new RegExp(`can\\(context\\.role, '${cap}'\\)`), `${door} gates on ${cap}`);
      const callAt = body.indexOf(`await ${call}(`);
      const refuseAt = body.indexOf('return githubRefused(', callAt);
      const recordAt = body.indexOf('await recordGitAction({', callAt);
      assert.ok(callAt > 0 && refuseAt > callAt && recordAt > refuseAt, `${door}: GitHub first, refusal next, the record last`);
      assert.match(body, new RegExp(`action: '${action}'`));
    }
    assert.match(SERVICE, /\.rpc\('record_git_action', \{/);
  });

  test('the database names the four actions and audits each as git.<action>', () => {
    assert.match(MIGRATION, /action\s+text not null check \(action in \('branch_created', 'review_submitted', 'merged', 'build_triggered'\)\)/);
    assert.match(MIGRATION, /'git\.' \|\| p_action, 'git_action', v_id/);
    assert.match(MIGRATION, /Decision: reversed by the owner on 2026-09-30/);
    // branch: task work; review, merge, build: delivery management.
    assert.match(MIGRATION, /if p_action = 'branch_created' then\s+if not coalesce\(\(select core\.can_write\(\)\), false\)/);
    assert.match(MIGRATION, /elsif not coalesce\(\(select core\.can_manage_delivery\(\)\), false\) then/);
  });
});

describe('B. a token without the repo scope is refused before anything is sent', () => {
  test('X-OAuth-Scopes is read once, from GET /user', async () => {
    const github = await import('../src/lib/git/github.ts');
    github.forgetGithubTokenScopes();
    calls.length = 0;
    scopesHeader = 'read:user';
    const first = await github.readGithubTokenScopes();
    const second = await github.readGithubTokenScopes();
    assert.ok(first.ok && second.ok);
    assert.deepEqual(first.data.scopes, ['read:user']);
    assert.equal(first.data.mayWrite, false);
    assert.equal(calls.filter((c) => c.url.endsWith('/user')).length, 1, 'read once');
  });

  test('createTaskBranch answers missing_scope and sends no POST', async () => {
    const write = await import('../src/lib/git/github-write.ts');
    calls.length = 0;
    const result = await write.createTaskBranch({ link: { owner: 'acme', repo: 'site', defaultBranch: 'main' }, taskId: 'abcd1234-0000-0000-0000-000000000000', title: 'Fix login flow' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'missing_scope');
      assert.match(write.describeGithubWriteReason(result.reason), /repo/);
    }
    assert.deepEqual(nonGet(), []);
  });

  test('with the repo scope the branch is task/<id>-<slug> from the default branch, and the POST is the last call', async () => {
    const github = await import('../src/lib/git/github.ts');
    const write = await import('../src/lib/git/github-write.ts');
    github.forgetGithubTokenScopes();
    scopesHeader = 'repo, workflow';
    calls.length = 0;
    const result = await write.createTaskBranch({ link: { owner: 'acme', repo: 'site', defaultBranch: 'develop' }, taskId: 'abcd1234-0000-0000-0000-000000000000', title: 'Fix login flow!' });
    assert.ok(result.ok, JSON.stringify(result));
    if (result.ok) {
      assert.equal(result.data.branch, 'task/abcd1234-fix-login-flow');
      assert.equal(result.data.fromBranch, 'main', "GitHub's default branch, not the link's branch to read");
    }
    const posts = nonGet();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.method, 'POST');
    assert.equal(posts[0]?.url, 'https://api.github.com/repos/acme/site/git/refs');
    assert.deepEqual(posts[0]?.body, { ref: 'refs/heads/task/abcd1234-fix-login-flow', sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    assert.equal(calls[calls.length - 1]?.method, 'POST');
  });

  test('a fine-grained token states no scopes: the write is attempted and GitHub decides', async () => {
    const github = await import('../src/lib/git/github.ts');
    github.forgetGithubTokenScopes();
    scopesHeader = null;
    const scopes = await github.readGithubTokenScopes();
    assert.ok(scopes.ok && scopes.data.scopes === null && scopes.data.mayWrite === true);
  });

  test('a review that requests changes with no words is refused without a POST', async () => {
    const write = await import('../src/lib/git/github-write.ts');
    calls.length = 0;
    const result = await write.submitReview({ link: { owner: 'acme', repo: 'site' }, pullNumber: 7, event: 'REQUEST_CHANGES', body: '   ' });
    assert.equal(result.ok, false);
    assert.deepEqual(nonGet(), []);
    const sent = await write.submitReview({ link: { owner: 'acme', repo: 'site' }, pullNumber: 7, event: 'REQUEST_CHANGES', body: 'The token is logged.' });
    assert.ok(sent.ok);
    assert.deepEqual(nonGet().map((c) => [c.method, c.url, c.body]), [['POST', 'https://api.github.com/repos/acme/site/pulls/7/reviews', { event: 'REQUEST_CHANGES', body: 'The token is logged.' }]]);
  });
});

describe('C. a merge is squash, and refused on a red or running check', () => {
  test('a failed check refuses with its name and sends no PUT', async () => {
    const write = await import('../src/lib/git/github-write.ts');
    checkRuns = [{ name: 'ci / test', status: 'completed', conclusion: 'failure' }, { name: 'ci / lint', status: 'completed', conclusion: 'success' }];
    calls.length = 0;
    const result = await write.mergePullRequest({ link: { owner: 'acme', repo: 'site' }, pullNumber: 7 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'checks_red');
      assert.match(result.detail, /ci \/ test: failure/);
    }
    assert.deepEqual(nonGet(), []);
  });

  test('a running check refuses too', async () => {
    const write = await import('../src/lib/git/github-write.ts');
    checkRuns = [{ name: 'ci / test', status: 'in_progress', conclusion: null }];
    calls.length = 0;
    const result = await write.mergePullRequest({ link: { owner: 'acme', repo: 'site' }, pullNumber: 7 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'checks_red');
    assert.deepEqual(nonGet(), []);
  });

  test('green checks merge with merge_method squash against the head sha that was checked', async () => {
    const write = await import('../src/lib/git/github-write.ts');
    checkRuns = [{ name: 'ci / test', status: 'completed', conclusion: 'success' }];
    calls.length = 0;
    const result = await write.mergePullRequest({ link: { owner: 'acme', repo: 'site' }, pullNumber: 7 });
    assert.ok(result.ok, JSON.stringify(result));
    const puts = nonGet();
    assert.equal(puts.length, 1);
    assert.equal(puts[0]?.method, 'PUT');
    assert.deepEqual(puts[0]?.body, { merge_method: 'squash', sha: 'cafebabecafebabecafebabecafebabecafebabe' });
  });

  test('a build trigger dispatches the linked workflow on the given ref', async () => {
    const write = await import('../src/lib/git/github-write.ts');
    calls.length = 0;
    const result = await write.dispatchWorkflow({ link: { owner: 'acme', repo: 'site' }, workflowFile: 'deploy.yml', ref: 'main' });
    assert.ok(result.ok);
    assert.deepEqual(nonGet().map((c) => [c.method, c.url, c.body]), [['POST', 'https://api.github.com/repos/acme/site/actions/workflows/deploy.yml/dispatches', { ref: 'main' }]]);
  });

  test('and the service records nothing when the dispatch is refused: the refusal returns before recordGitAction', () => {
    const start = SERVICE.indexOf('export async function triggerBuild(');
    const body = SERVICE.slice(start, SERVICE.indexOf('\nexport async function', start + 1));
    assert.ok(body.indexOf('if (!dispatched.ok) return githubRefused(') < body.indexOf('await recordGitAction({'));
    assert.match(body, /reference: link\.workflowFile \?\? 'record only'/);
  });
});
