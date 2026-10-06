/**
 * The Phase 5 build runner - DevOps/Build spec (P509): a deterministic stage machine around an injected `Executor`.
 *
 * It owns what must never depend on a model or a vendor: the ORDER of stages, stopping at the first failure, classifying the failure from the
 * stage that failed, computing nothing it was not told (the artifact hash comes from the executor and is format-checked), masking secrets from
 * anything recorded, retrying ONLY a transient infrastructure failure and never a deterministic one, and recording through the same doors a
 * person would. A run that "succeeded" but produced no artifact is `artifact_missing`, never a pass (T012).
 *
 * What it does not own: actually running a toolchain. `notConfiguredExecutor` is what runs when no CI binding exists, and it records an honest
 * `environment_missing` failure - the blocker is visible instead of a build being faked. The scripted fake in the tests proves the decisions; a
 * real executor (a CI worker, a container) is the owner's binding and the one thing not proven here.
 */

export const BUILD_STAGES = ['source', 'env', 'install', 'lint_type', 'test', 'build', 'artifact_verify'] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];

export type FailureClass =
  | 'environment_missing' | 'dependency_install_failed' | 'lint_type_failed' | 'test_failed' | 'compile_failed'
  | 'signing_failed' | 'artifact_missing' | 'install_failed' | 'runtime_crash' | 'infra_transient' | 'toolchain_incompatible';

export type StageResult = { status: 'passed' | 'failed'; transient?: boolean; log?: string; durationMs?: number };
export type StageRecord = { name: BuildStage; status: 'passed' | 'failed'; duration_ms: number; required: true };

export interface Executor {
  stage(name: BuildStage, ctx: { commit: string; environment: string }): Promise<StageResult>;
  /** The sha256 of the artifact the build produced, or null when there is none. */
  artifactSha256(ctx: { commit: string }): Promise<string | null>;
  /** The command the build ran: recorded in the fingerprint and checked: a build never deploys. */
  command(): string;
  /** The runtime facts for the fingerprint (never a secret). */
  fingerprint(): Record<string, string>;
}

/** What runs when nothing is bound: an honest blocker, never a fabricated result. */
export const notConfiguredExecutor: Executor = {
  async stage(name) {
    return name === 'source' ? { status: 'passed' } : { status: 'failed', log: 'no build executor is configured for this deployment' };
  },
  async artifactSha256() { return null; },
  command: () => 'none',
  fingerprint: () => ({ runner: 'not-configured' }),
};

const FAILURE_BY_STAGE: Record<BuildStage, FailureClass> = {
  source: 'environment_missing',
  env: 'environment_missing',
  install: 'dependency_install_failed',
  lint_type: 'lint_type_failed',
  test: 'test_failed',
  build: 'compile_failed',
  artifact_verify: 'artifact_missing',
};

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi,
  /\b(api[_-]?key|secret|token|password|passwd)\s*[=:]\s*\S{6,}/gi,
];

/** Masks anything that looks like a secret. Applied to every log line before it is stored or shown. */
export function maskSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, '[masked]'), text);
}

export type RunPlan = {
  deliverableId: string;
  taskId?: string | null;
  commit: string;
  environment: 'dev' | 'review' | 'staging' | 'client_test';
  /** Called by the runner to record through the `record_build_run` door. */
  record: (args: {
    status: 'succeeded' | 'failed';
    failureClass: FailureClass | null;
    stages: StageRecord[];
    fingerprint: Record<string, string>;
    artifactSha256: string | null;
    retryOf: string | null;
    idempotencyKey: string;
  }) => Promise<{ outcome: string; runId: string | null }>;
  /** Called on a failure, to record the attempt through `record_execution_failure` (best effort, never blocks the build record). */
  recordFailure?: (args: { attempt: number; failureClass: string; retry: 'safe' | 'never'; escalate: boolean; detail: string }) => Promise<void>;
  maxAttempts?: number;
};

export type RunResult = { status: 'succeeded' | 'failed' | 'blocked'; attempts: number; failureClass: FailureClass | null; runId: string | null; detail: string };

const DEPLOY = /(vercel +(deploy|--prod)|gh +release|fastlane +(supply|pilot|deliver)|npm +publish|kubectl +apply|terraform +apply|git +push|--deploy)/i;

export async function runBuild(executor: Executor, plan: RunPlan): Promise<RunResult> {
  const max = plan.maxAttempts ?? 3;
  const command = executor.command();
  if (DEPLOY.test(command)) {
    return { status: 'blocked', attempts: 0, failureClass: null, runId: null, detail: 'the build command deploys or publishes; a build never does, so nothing was run' };
  }
  let retryOf: string | null = null;
  let lastDetail = '';
  for (let attempt = 1; attempt <= max; attempt += 1) {
    const stages: StageRecord[] = [];
    let failedStage: BuildStage | null = null;
    let transient = false;
    for (const name of BUILD_STAGES) {
      if (name === 'artifact_verify') break; // verified below, from the artifact itself
      const res = await executor.stage(name, { commit: plan.commit, environment: plan.environment });
      stages.push({ name, status: res.status, duration_ms: Math.max(0, Math.round(res.durationMs ?? 0)), required: true });
      if (res.status === 'failed') {
        failedStage = name;
        transient = res.transient === true;
        lastDetail = maskSecrets(res.log ?? `${name} failed`);
        break;
      }
    }
    let sha: string | null = null;
    if (!failedStage) {
      sha = await executor.artifactSha256({ commit: plan.commit });
      const ok = typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha);
      stages.push({ name: 'artifact_verify', status: ok ? 'passed' : 'failed', duration_ms: 0, required: true });
      if (!ok) {
        failedStage = 'artifact_verify';
        sha = null;
        lastDetail = 'the build reported success but produced no artifact with a valid sha256';
      }
    }
    const fingerprint = { ...executor.fingerprint(), commit: plan.commit, command };
    const failureClass: FailureClass | null = failedStage ? (transient ? 'infra_transient' : FAILURE_BY_STAGE[failedStage]) : null;
    const recorded = await plan.record({
      status: failedStage ? 'failed' : 'succeeded',
      failureClass,
      stages,
      fingerprint,
      artifactSha256: failedStage ? null : sha,
      retryOf,
      idempotencyKey: `build:${plan.deliverableId}:${plan.commit}:${attempt}`,
    });
    if (recorded.outcome !== 'recorded' && recorded.outcome !== 'already_recorded') {
      return { status: 'blocked', attempts: attempt, failureClass, runId: null, detail: `the door refused the run: ${recorded.outcome}` };
    }
    if (!failedStage) return { status: 'succeeded', attempts: attempt, failureClass: null, runId: recorded.runId, detail: 'built, artifact verified' };
    const retry = transient && attempt < max;
    await plan.recordFailure?.({
      attempt,
      failureClass: failedStage === 'test' ? 'test_failure' : transient ? 'tool_unavailable' : 'build_failure',
      retry: retry ? 'safe' : 'never',
      escalate: !retry,
      detail: lastDetail,
    });
    // only a transient infrastructure failure is repeated, on the same commit; a deterministic failure goes back to the specialist
    if (!retry) return { status: 'failed', attempts: attempt, failureClass, runId: recorded.runId, detail: lastDetail };
    retryOf = recorded.runId;
  }
  return { status: 'failed', attempts: max, failureClass: 'infra_transient', runId: retryOf, detail: lastDetail };
}
