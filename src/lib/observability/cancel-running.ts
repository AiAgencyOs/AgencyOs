import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

/**
 * Asking a RUNNING job to stop — SCR-065/066, `core.cancel_running_job`
 * (20261001150000). `cancelJob` handles work that has not started; this is
 * its twin for work the runner holds. The function stamps a flag; the runner
 * reads it before its next model call and settles the job and its run as
 * cancelled (`core.settle_cancelled_job`, audited). So the honest answer to
 * a click is "asked to stop", not "stopped" — the row stays running until
 * the runner reaches its next step.
 *
 * `job.requeue` again: owner and ops_admin, the two roles who may change
 * what the queue will do.
 */

type Row = { outcome: 'requested' | 'not_found' | 'not_running' | 'no_reason' | 'already_requested'; job_status: string | null };

export async function cancelRunningJob(jobId: string, reason: string): Promise<Result<{ jobId: string }>> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return err('VALIDATION', 'That is not a job id.');
  const trimmed = reason.trim();
  if (!trimmed) return err('VALIDATION', 'Say why the job is being stopped — the reason is what the audit row keeps.');
  if (trimmed.length > 500) return err('VALIDATION', 'Keep the reason under 500 characters.');

  const context = await requireInternal();
  if (!can(context, 'job.requeue')) {
    return err('FORBIDDEN', 'You do not have permission to cancel jobs.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('cancel_running_job', { p_job_id: jobId, p_reason: trimmed });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'cancelRunningJob', jobId, detail: error.message }));
    return err('INTERNAL', 'Could not ask that job to stop.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
  switch (row?.outcome) {
    case 'requested':
      return ok({ jobId });
    case 'already_requested':
      return err('CONFLICT', 'That job has already been asked to stop; the runner settles it at its next step.');
    case 'not_running':
      return err(
        'CONFLICT',
        row.job_status === 'queued' || row.job_status === 'failed'
          ? 'That job is not running — cancel it from the queue instead.'
          : `That job is ${row.job_status ?? 'no longer running'}, so there is nothing to stop.`,
      );
    case 'not_found':
      return err('NOT_FOUND', 'That job is not in this queue.');
    case 'no_reason':
      return err('VALIDATION', 'Say why the job is being stopped.');
    default:
      return err('INTERNAL', 'Could not ask that job to stop.');
  }
}
