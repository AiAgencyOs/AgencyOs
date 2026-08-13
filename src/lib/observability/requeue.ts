import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

/**
 * Sending dead work back to the queue — G-099.
 *
 * Beside the reads it belongs to, rather than in a module: `/operations` is a
 * platform screen, there is no `ops` domain, and `lib/` may not import
 * `modules/` (ARCHITECTURE.md §3.2). The reads for this page already live next
 * door in `queries.ts`.
 *
 * Nothing here decides anything. `core.requeue_job` reads the status under a
 * row lock and answers from it, because a status this file checked first would
 * be a status somebody else could change before the write landed — the shape
 * D1, D2, D4 and D20 all were. What this file does is check the capability,
 * call the function, and turn its three answers into three different sentences.
 *
 * They are three different sentences on purpose. "That job is not dead" and
 * "that job does not exist" mean opposite things to somebody staring at a
 * queue: the first is usually a page loaded a minute ago and a colleague who
 * got there first, and the second is a link that should not exist. Flattening
 * both to "something went wrong" tells the operator to retry the one thing
 * that cannot work.
 */

/** The row `core.requeue_job` returns. */
type RequeueRow = {
  outcome: 'requeued' | 'not_found' | 'not_dead';
  job_status: string | null;
  attempts: number | null;
};

export type Requeued = { jobId: string; attempts: number };

export async function requeueJob(jobId: string): Promise<Result<Requeued>> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    return err('VALIDATION', 'That is not a job id.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'job.requeue')) {
    return err('FORBIDDEN', 'You do not have permission to requeue jobs.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('core').rpc('requeue_job', { p_job_id: jobId });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'requeueJob', jobId, detail: error.message }),
    );
    return err('INTERNAL', 'Could not requeue that job.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as RequeueRow | undefined;

  // A read that returned nothing is a failed read, not an empty answer — G-054,
  // and D3 before it.
  if (!row) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'requeueJob', jobId, detail: 'no row returned' }),
    );
    return err('INTERNAL', 'Could not requeue that job.');
  }

  switch (row.outcome) {
    case 'requeued':
      return ok({ jobId, attempts: row.attempts ?? 0 });

    case 'not_found':
      return err('NOT_FOUND', 'That job is not in this queue.');

    // Not an error the operator caused, and worth quoting the status back: a
    // job that is queued again was almost certainly requeued by somebody else
    // while this page was open.
    case 'not_dead':
      return err(
        'CONFLICT',
        `That job is ${row.job_status ?? 'not dead'}, so there is nothing to revive.`,
      );

    default:
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'requeueJob',
          jobId,
          detail: `unrecognised outcome "${String(row.outcome)}"`,
        }),
      );
      return err('INTERNAL', 'Could not requeue that job.');
  }
}
