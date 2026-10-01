/**
 * The contract and migration checks of a client environment, run as a GitHub
 * workflow dispatched from the panel (owner decision 13, round 2, 2026-10-01).
 * Pure helpers, no I/O: the doors are in `git-write-service.ts`, the table and
 * the two database doors are migration 20261007200300.
 *
 * The workflow named here must declare these `workflow_dispatch` inputs (GitHub
 * refuses a dispatch carrying inputs the workflow does not declare):
 *
 *   environment      the environment's label
 *   environment_url  the environment's URL
 *   checks           comma list of `api_contract` and/or `migrations`
 *   dispatch_key     a correlation key; put it in the workflow's `run-name`
 *                    (`run-name: checks ${{ inputs.dispatch_key }}`) so the run is
 *                    found exactly. Without it the run is matched by time.
 *
 * The workflow's CONCLUSION is the result: `success` records each dispatched
 * check as passing on the environment's readiness, anything else records it as
 * failing, with the run's URL as the evidence. The hand-recorded path
 * (`projects.record_environment_check`) is unchanged and stays the fallback.
 */

export const CHECK_RUN_CHECKS = ['api_contract', 'migrations'] as const;
export type CheckRunCheck = (typeof CHECK_RUN_CHECKS)[number];

export const CHECK_RUN_CHECK_LABEL: Record<CheckRunCheck, string> = {
  api_contract: 'API contracts',
  migrations: 'DB migrations',
};

/** The workflow dispatched when the person does not name another. */
export const DEFAULT_CHECKS_WORKFLOW = 'agencyos-checks.yml';

export const WORKFLOW_FILE_PATTERN = /^[A-Za-z0-9._-]{1,120}\.ya?ml$/;

/** A fresh correlation key, 8 to 64 characters as the database requires. */
export function newDispatchKey(random: () => string = () => crypto.randomUUID()): string {
  return `ck-${random().replace(/-/g, '').slice(0, 20)}`;
}

export type WorkflowRunLike = {
  id: number;
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
  displayTitle: string;
};

/** How early a run may have been created and still be this dispatch's (clock skew between GitHub and us). */
const SKEW_MS = 10_000;

/**
 * Which run is this dispatch's. A run whose title carries the dispatch key is
 * exactly it. Otherwise the earliest run created at or after the dispatch (less
 * a little clock skew) that no other dispatch has claimed. null while GitHub has
 * not started one yet.
 */
export function matchWorkflowRun(
  runs: readonly WorkflowRunLike[],
  dispatch: { dispatchKey: string; dispatchedAt: string },
  claimedRunIds: ReadonlySet<number> = new Set(),
): WorkflowRunLike | null {
  const byKey = runs.find((r) => r.displayTitle.includes(dispatch.dispatchKey));
  if (byKey) return byKey;
  const since = new Date(dispatch.dispatchedAt).getTime() - SKEW_MS;
  const candidates = runs
    .filter((r) => !claimedRunIds.has(r.id) && new Date(r.createdAt).getTime() >= since)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return candidates[0] ?? null;
}

export type RunState = { status: 'in_progress' | 'completed'; conclusion: string | null };

/** GitHub's queued / in_progress / completed, reduced to what the database stores. */
export function runState(run: Pick<WorkflowRunLike, 'status' | 'conclusion'>): RunState {
  if (run.status === 'completed') return { status: 'completed', conclusion: run.conclusion ?? 'unknown' };
  return { status: 'in_progress', conclusion: null };
}

/** The sentence the Builds screen shows for one dispatch. */
export function describeCheckRun(run: { status: string; conclusion: string | null; checks: readonly string[] }): string {
  const what = run.checks.map((c) => CHECK_RUN_CHECK_LABEL[c as CheckRunCheck] ?? c).join(' and ');
  if (run.status === 'completed') return run.conclusion === 'success' ? `${what}: passed` : `${what}: ${run.conclusion ?? 'finished without a result'}`;
  if (run.status === 'in_progress') return `${what}: running on GitHub`;
  return `${what}: dispatched, waiting for GitHub to start it`;
}
