/**
 * The production deployment executor (P704) - the seam, and the honest "not configured" implementation.
 *
 * WHAT IS BUILT: the database doors that record a deployment (request / start / succeed / fail / roll back / recover) and the independent validation that follows.
 * WHAT IS NOT BUILT: the thing that actually puts the approved artifact on a production host. It needs production credentials and a target the OWNER binds
 * (see docs/phase-7-manual-actions.md); no such credential exists in this repository and none may be invented.
 *
 * So the only executor that exists is `notConfiguredExecutor`: it does nothing to production and says so. The job that calls it records the answer as an
 * honest BLOCKER on the deployment (`projects.record_deployment_blocker`); it never records a start, a success or a "validated" it did not observe.
 * A configured executor, when the owner binds one, reports its own progress through the service-role door `projects.record_deployment_progress` with the
 * deployed artifact hash, which the door compares with the approved candidate's hash byte for byte.
 */

export type DeploymentRequest = {
  readonly deploymentId: string;
  readonly planId: string;
  readonly projectId: string;
  /** The exact approved candidate. A runner deploys this commit and this artifact hash and nothing else. */
  readonly commitRef: string;
  readonly artifactSha256: string;
  readonly environment: 'production';
};

export type ExecutorResult =
  /** Nothing was done to production. `code` is a stable [a-z_]+ key stored on the deployment. */
  | { readonly status: 'blocked'; readonly code: string; readonly detail: string }
  /** The executor accepted the request and reports its own progress through the service-role door; the caller infers nothing. */
  | { readonly status: 'accepted' };

export interface DeploymentExecutor {
  readonly kind: 'not_configured' | 'runner';
  execute(request: DeploymentRequest): Promise<ExecutorResult>;
}

export const NOT_CONFIGURED_CODE = 'executor_not_configured';

export const notConfiguredExecutor: DeploymentExecutor = {
  kind: 'not_configured',
  async execute() {
    return {
      status: 'blocked',
      code: NOT_CONFIGURED_CODE,
      detail: 'No production deployment executor is bound. The owner must provide production credentials and a deployment target (docs/phase-7-manual-actions.md). Nothing was deployed.',
    };
  },
};

/**
 * Which executor runs. Today the answer is always "not configured": there is no environment variable, setting or credential that selects another one, on
 * purpose. When the owner binds a real executor this is the one place that changes.
 */
export function resolveDeploymentExecutor(): DeploymentExecutor {
  return notConfiguredExecutor;
}
