import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

/**
 * Stopping work that has not started — SCR-066, `core.cancel_job`
 * (20260929210000). The requeue door's twin, and built the same way: this
 * file checks the capability and turns the function's answers into sentences;
 * the function reads the status under a row lock and decides.
 *
 * `job.requeue` is the capability, not a new one: it names the two roles —
 * owner and ops_admin — who may change what the queue will do, and cancelling
 * is the same kind of decision about the same table (the finance rule: a new
 * capability mapping to an identical role set adds vocabulary without adding
 * control).
 *
 * Only a queued job — queued now, or queued for a retry — can be cancelled.
 * A running job has a live claim and stopping the row would not stop the
 * work; a finished one is history; a dead one has its own door. Each refusal
 * quotes the status back, because "that job is running" and "that job does
 * not exist" ask different things of the operator.
 */

type CancelRow = {
  outcome: 'cancelled' | 'not_found' | 'not_cancellable' | 'no_reason';
  job_status: string | null;
};

export type Cancelled = { jobId: string };

export async function cancelJob(jobId: string, reason: string): Promise<Result<Cancelled>> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    return err('VALIDATION', 'That is not a job id.');
  }
  const trimmed = reason.trim();
  if (!trimmed) return err('VALIDATION', 'Say why the job is being cancelled — the reason is what the audit row keeps.');
  if (trimmed.length > 500) return err('VALIDATION', 'Keep the reason under 500 characters.');

  const context = await requireInternal();
  if (!can(context, 'job.requeue')) {
    return err('FORBIDDEN', 'You do not have permission to cancel jobs.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('cancel_job', { p_job_id: jobId, p_reason: trimmed });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'cancelJob', jobId, detail: error.message }));
    return err('INTERNAL', 'Could not cancel that job.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as CancelRow | undefined;
  if (!row) {
    console.error(JSON.stringify({ level: 'error', scope: 'cancelJob', jobId, detail: 'no row returned' }));
    return err('INTERNAL', 'Could not cancel that job.');
  }

  switch (row.outcome) {
    case 'cancelled':
      return ok({ jobId });
    case 'not_found':
      return err('NOT_FOUND', 'That job is not in this queue.');
    case 'no_reason':
      return err('VALIDATION', 'Say why the job is being cancelled.');
    case 'not_cancellable':
      return err(
        'CONFLICT',
        row.job_status === 'running'
          ? 'That job is running, so it cannot be cancelled — the runner holds it. Wait for it to settle.'
          : row.job_status === 'dead'
            ? 'That job is dead; it will not run again unless somebody requeues it.'
            : `That job is ${row.job_status ?? 'no longer queued'}, so there is nothing to cancel.`,
      );
    default:
      console.error(JSON.stringify({ level: 'error', scope: 'cancelJob', jobId, detail: `unrecognised outcome "${String(row.outcome)}"` }));
      return err('INTERNAL', 'Could not cancel that job.');
  }
}
