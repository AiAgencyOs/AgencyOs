/**
 * What cancelling a workflow (every job that shares one correlation id)
 * can and cannot do — pure, so the drawer's button label and the server
 * action agree.
 *
 * A queued or failed job has not started: it is cancelled outright
 * (`core.cancel_job`). A running job is held by the runner: it is asked to
 * stop and settles as cancelled at its next step (`core.cancel_running_job`).
 * A job already settled (succeeded, cancelled, dead) needs nothing.
 */

export type WorkflowJobLike = { id: string; status: string };

export type WorkflowCancelPlan = {
  /** Jobs cancelled outright. */
  cancel: string[];
  /** Jobs asked to stop at their next step. */
  stop: string[];
  /** Jobs that need nothing (already settled). */
  settled: number;
};

export function planWorkflowCancel(jobs: readonly WorkflowJobLike[]): WorkflowCancelPlan {
  const plan: WorkflowCancelPlan = { cancel: [], stop: [], settled: 0 };
  for (const job of jobs) {
    if (job.status === 'queued' || job.status === 'failed') plan.cancel.push(job.id);
    else if (job.status === 'running') plan.stop.push(job.id);
    else plan.settled += 1;
  }
  return plan;
}

export function describeWorkflowCancel(plan: WorkflowCancelPlan): string {
  const parts: string[] = [];
  if (plan.cancel.length > 0) parts.push(`cancel ${plan.cancel.length} job${plan.cancel.length === 1 ? '' : 's'}`);
  if (plan.stop.length > 0) parts.push(`ask ${plan.stop.length} running job${plan.stop.length === 1 ? '' : 's'} to stop at the next step`);
  return parts.length > 0 ? parts.join(' and ') : 'nothing to cancel';
}
