import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * Owner decision 13 (round 2): the contract and migration checks of a client
 * environment run as a GitHub workflow dispatched from the panel.
 *
 * The doors are EXECUTED here: the real `dispatchEnvironmentChecks` and
 * `refreshEnvironmentChecks` against an in-memory database (the two SQL doors
 * are re-enacted by tiny fakes; the real ones are proven by
 * scripts/verify-x2.mjs) and a fake GitHub behind `fetch`. No real GitHub is
 * called. The pure matcher is called with real inputs.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';
process.env.GITHUB_TOKEN = 'ghp_test_token_not_a_real_credential';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ENV = '22222222-2222-4222-8222-222222222222';

type Row = Record<string, unknown>;
let role = 'delivery_lead';
let accessLevel = 'full';
let linked = true;
const db: { runs: Row[]; rpcs: [string, Record<string, unknown>][]; readiness: Record<string, unknown> } = { runs: [], rpcs: [], readiness: {} };

function chain(rows: () => Row[]) {
  const filters: ((r: Row) => boolean)[] = [];
  const api = {
    select: () => api,
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), api),
    is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), api),
    order: () => api,
    maybeSingle: async () => ({ data: rows().filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: rows().filter((r) => filters.every((f) => f(r))), error: null }),
  };
  return api;
}

mock.module('@/lib/auth/session', { exports: { requireInternal: async () => ({ role, userId: 'u1', organizationId: 'o1' }) } });
mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema: () => ({
        from: (table: string) =>
          chain(() => {
            if (table === 'repository_links')
              return linked
                ? [{ id: 'l1', provider: 'github', owner: 'acme', repo: 'site', default_branch: 'main', workflow_file: null, access_level: accessLevel, merge_min_approvals: 0, merge_role: 'delivery', linked_by: null, created_at: '', updated_at: '', project_id: PROJECT }]
                : [];
            if (table === 'environments') return [{ id: ENV, project_id: PROJECT, label: 'Staging', url: 'https://staging.acme.test' }];
            if (table === 'environment_check_runs') return db.runs;
            return [];
          }),
        rpc: async (fn: string, args: Record<string, unknown>) => {
          db.rpcs.push([fn, args]);
          if (fn === 'record_check_dispatch') {
            const id = `run-row-${db.runs.length + 1}`;
            db.runs.push({ id, project_id: PROJECT, environment_id: ENV, workflow_file: args.p_workflow_file, ref: args.p_ref, dispatch_key: args.p_dispatch_key, dispatched_at: new Date().toISOString(), run_id: null, applied_at: null });
            return { data: [{ outcome: 'recorded', run_row_id: id }], error: null };
          }
          if (fn === 'record_check_run_result') {
            const row = db.runs.find((r) => r.id === args.p_run_row_id);
            if (row) {
              row.run_id = args.p_run_id;
              if (args.p_status === 'completed') {
                row.applied_at = new Date().toISOString();
                db.readiness = { ok: args.p_conclusion === 'success', evidence: args.p_run_url };
              }
            }
            return { data: [{ outcome: args.p_status === 'completed' ? 'recorded' : 'progress_noted' }], error: null };
          }
          return { data: null, error: { message: 'unexpected rpc' } };
        },
      }),
    }),
  },
});

// ── a fake GitHub ──────────────────────────────────────────────────────────
type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];
let workflowRuns: { id: number; status: string; conclusion: string | null; html_url: string; created_at: string; display_title: string; head_branch: string }[] = [];
let dispatchStatus = 204;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = url.replace('https://api.github.com', '');
  calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
  const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(b === null ? null : JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });
  if (path === '/user') return json({ login: 'bot' }, 200, { 'x-oauth-scopes': 'repo, workflow' });
  if (method === 'POST' && path.includes('/actions/workflows/') && path.endsWith('/dispatches')) return dispatchStatus === 204 ? json(null, 204) : json({ message: 'Workflow does not have workflow_dispatch trigger' }, dispatchStatus);
  if (path.includes('/actions/workflows/') && path.includes('/runs?')) return json({ workflow_runs: workflowRuns });
  return json({ message: `unexpected ${method} ${path}` }, 500);
}) as typeof fetch;

const service = await import('../src/modules/projects/git-write-service.ts');
const checkRuns = await import('../src/modules/projects/environment-check-runs.ts');

beforeEach(() => {
  role = 'delivery_lead';
  accessLevel = 'full';
  linked = true;
  db.runs = [];
  db.rpcs = [];
  db.readiness = {};
  calls.length = 0;
  workflowRuns = [];
  dispatchStatus = 204;
});

const input = { projectId: PROJECT, environmentId: ENV, checks: ['api_contract', 'migrations'] as ('api_contract' | 'migrations')[] };

describe('dispatching the checks', () => {
  test('GitHub is dispatched first with the named workflow and its inputs, and only then is the dispatch recorded', async () => {
    const result = await service.dispatchEnvironmentChecks(input);
    assert.ok(result.ok, JSON.stringify(result));
    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post?.path, '/repos/acme/site/actions/workflows/agencyos-checks.yml/dispatches');
    const sent = post?.body as { ref: string; inputs: Record<string, string> };
    assert.equal(sent.ref, 'main');
    assert.equal(sent.inputs.environment, 'Staging');
    assert.equal(sent.inputs.checks, 'api_contract,migrations');
    assert.match(sent.inputs.dispatch_key ?? '', /^ck-[0-9a-f]{20}$/);
    assert.deepEqual(db.rpcs.map(([fn]) => fn), ['record_check_dispatch']);
    assert.equal(db.rpcs[0]?.[1].p_dispatch_key, sent.inputs.dispatch_key, 'the key sent to GitHub is the key stored');
  });

  test('a workflow GitHub refuses records nothing — nothing ran', async () => {
    dispatchStatus = 422;
    const result = await service.dispatchEnvironmentChecks(input);
    assert.equal(result.ok, false);
    assert.equal(db.rpcs.length, 0);
  });

  test('a member may not dispatch, and nothing leaves the process', async () => {
    role = 'member';
    const result = await service.dispatchEnvironmentChecks(input);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });

  test('the owner, the ops admin and the delivery lead may', async () => {
    for (const r of ['owner', 'ops_admin', 'delivery_lead']) {
      role = r;
      db.runs = [];
      assert.ok((await service.dispatchEnvironmentChecks(input)).ok, r);
    }
  });

  test('a repository set to read only is refused by its policy, and so is a project with no repository', async () => {
    accessLevel = 'read_only';
    assert.equal((await service.dispatchEnvironmentChecks(input)).ok, false);
    accessLevel = 'full';
    linked = false;
    const none = await service.dispatchEnvironmentChecks(input);
    assert.equal(none.ok, false);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });

  test('no check chosen, or a workflow path, is refused before anything is sent', async () => {
    assert.equal((await service.dispatchEnvironmentChecks({ ...input, checks: [] })).ok, false);
    assert.equal((await service.dispatchEnvironmentChecks({ ...input, workflowFile: '../x.yml' })).ok, false);
    assert.equal(calls.length, 0);
  });
});

describe('reading the result', () => {
  test('a run that is still going is noted, then the finished run is recorded with its link, once', async () => {
    assert.ok((await service.dispatchEnvironmentChecks(input)).ok);
    const key = db.runs[0]?.dispatch_key as string;
    workflowRuns = [{ id: 901, status: 'in_progress', conclusion: null, html_url: 'https://github.com/acme/site/actions/runs/901', created_at: new Date().toISOString(), display_title: `checks ${key}`, head_branch: 'main' }];
    const going = await service.refreshEnvironmentChecks({ projectId: PROJECT, environmentId: ENV });
    assert.ok(going.ok && going.data.runs[0]?.status === 'in_progress');
    assert.equal(db.readiness && Object.keys(db.readiness).length, 0, 'nothing is recorded on the environment while it runs');

    workflowRuns = [{ ...workflowRuns[0]!, status: 'completed', conclusion: 'success' }];
    const done = await service.refreshEnvironmentChecks({ projectId: PROJECT, environmentId: ENV });
    assert.ok(done.ok && done.data.runs[0]?.status === 'completed' && done.data.runs[0]?.conclusion === 'success');
    assert.deepEqual(db.readiness, { ok: true, evidence: 'https://github.com/acme/site/actions/runs/901' });

    const again = await service.refreshEnvironmentChecks({ projectId: PROJECT, environmentId: ENV });
    assert.ok(again.ok && again.data.runs.length === 0, 'a recorded result is not read again');
  });

  test('a failed run records a failure', async () => {
    assert.ok((await service.dispatchEnvironmentChecks(input)).ok);
    const key = db.runs[0]?.dispatch_key as string;
    workflowRuns = [{ id: 7, status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/site/actions/runs/7', created_at: new Date().toISOString(), display_title: `checks ${key}`, head_branch: 'main' }];
    assert.ok((await service.refreshEnvironmentChecks({ projectId: PROJECT, environmentId: ENV })).ok);
    assert.equal((db.readiness as { ok: boolean }).ok, false);
  });

  test('a run GitHub has not started yet leaves the dispatch waiting and records nothing', async () => {
    assert.ok((await service.dispatchEnvironmentChecks(input)).ok);
    const waiting = await service.refreshEnvironmentChecks({ projectId: PROJECT, environmentId: ENV });
    assert.ok(waiting.ok && waiting.data.runs[0]?.status === 'dispatched');
    assert.equal(db.rpcs.filter(([fn]) => fn === 'record_check_run_result').length, 0);
  });
});

describe('matching a run to its dispatch', () => {
  const at = '2026-10-01T10:00:00Z';
  const run = (id: number, createdAt: string, displayTitle = '') => ({ id, status: 'completed', conclusion: 'success', url: `https://x/${id}`, createdAt, displayTitle });

  test('the run whose title carries the key is the one, whenever it was created', () => {
    const picked = checkRuns.matchWorkflowRun([run(1, '2026-10-01T10:00:05Z'), run(2, '2026-10-01T09:00:00Z', 'checks ck-abc123')], { dispatchKey: 'ck-abc123', dispatchedAt: at });
    assert.equal(picked?.id, 2);
  });

  test('without the key, the earliest run at or after the dispatch that nobody else has claimed', () => {
    const runs = [run(1, '2026-10-01T09:00:00Z'), run(2, '2026-10-01T10:00:03Z'), run(3, '2026-10-01T10:00:09Z')];
    assert.equal(checkRuns.matchWorkflowRun(runs, { dispatchKey: 'ck-none', dispatchedAt: at })?.id, 2);
    assert.equal(checkRuns.matchWorkflowRun(runs, { dispatchKey: 'ck-none', dispatchedAt: at }, new Set([2]))?.id, 3);
    assert.equal(checkRuns.matchWorkflowRun([run(1, '2026-10-01T09:00:00Z')], { dispatchKey: 'ck-none', dispatchedAt: at }), null);
  });

  test('GitHub statuses reduce to what the database stores, and the sentence says it', () => {
    assert.deepEqual(checkRuns.runState({ status: 'queued', conclusion: null }), { status: 'in_progress', conclusion: null });
    assert.deepEqual(checkRuns.runState({ status: 'completed', conclusion: 'timed_out' }), { status: 'completed', conclusion: 'timed_out' });
    assert.equal(checkRuns.describeCheckRun({ status: 'completed', conclusion: 'success', checks: ['api_contract', 'migrations'] }), 'API contracts and DB migrations: passed');
    assert.match(checkRuns.describeCheckRun({ status: 'dispatched', conclusion: null, checks: ['migrations'] }), /waiting for GitHub/);
  });
});

process.on('exit', () => {
  globalThis.fetch = realFetch;
});
