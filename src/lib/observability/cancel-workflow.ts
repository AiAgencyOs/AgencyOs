import 'server-only';

import { listJobsByCorrelation } from '@/lib/admin/run-chain';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { err, ok, type Result } from '@/lib/result';

import { cancelJob } from './cancel';
import { planWorkflowCancel } from './cancel-workflow-plan';
import { cancelRunningJob } from './cancel-running';

/**
 * Cancel a workflow — SCR-066 "Cancel workflow". A workflow is the jobs that
 * share one correlation id. There is no separate workflow door: each job goes
 * through the same audited door it would on its own (`core.cancel_job` for
 * work that has not started, `core.cancel_running_job` for work the runner
 * holds), each with the same reason, so every stop has its own audit row.
 * A job the door refuses (it settled in the meantime) is reported, not hidden.
 */
export async function cancelWorkflow(correlationId: string, reason: string): Promise<Result<{ summary: string }>> {
  if (!/^[0-9a-f-]{36}$/i.test(correlationId)) return err('VALIDATION', 'That is not a workflow id.');
  const trimmed = reason.trim();
  if (!trimmed) return err('VALIDATION', 'Say why the workflow is being cancelled — the reason is what the audit rows keep.');
  if (trimmed.length > 500) return err('VALIDATION', 'Keep the reason under 500 characters.');

  const context = await requireInternal();
  if (!can(context, 'job.requeue')) return err('FORBIDDEN', 'You do not have permission to cancel jobs.');

  const plan = planWorkflowCancel(await listJobsByCorrelation(correlationId));
  if (plan.cancel.length === 0 && plan.stop.length === 0) return err('CONFLICT', 'Every job in this workflow has already settled, so there is nothing to cancel.');

  let cancelled = 0;
  let asked = 0;
  const refused: string[] = [];
  for (const id of plan.cancel) {
    const result = await cancelJob(id, trimmed);
    if (result.ok) cancelled += 1;
    else refused.push(result.error.message);
  }
  for (const id of plan.stop) {
    const result = await cancelRunningJob(id, trimmed);
    if (result.ok) asked += 1;
    else refused.push(result.error.message);
  }
  if (cancelled + asked === 0) return err('CONFLICT', refused[0] ?? 'Nothing could be cancelled.');

  const parts = [
    ...(cancelled > 0 ? [`Cancelled ${cancelled} job${cancelled === 1 ? '' : 's'}`] : []),
    ...(asked > 0 ? [`asked ${asked} running job${asked === 1 ? '' : 's'} to stop at the next step`] : []),
  ];
  const done = parts.join(' and ').replace(/^./, (c) => c.toUpperCase());
  return ok({ summary: refused.length > 0 ? `${done}. ${refused.length} could not be stopped: ${refused[0]}` : `${done}.` });
}
