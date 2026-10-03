import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { replayRunSchema, type ReplayRunInput } from './replay-schema';

/**
 * SCR-065 — queue the job that produced a run again. `job.requeue`'s two
 * roles here; `core.is_admin()` again inside `ai.replay_run`, which also
 * holds the rule that matters: only `read` work (read-only tools) may be
 * replayed — every other class would act twice. Audited as agent_run.replayed.
 */
export async function replayRun(input: ReplayRunInput): Promise<Result<{ runId: string; jobId: string }>> {
  const parsed = replayRunSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');

  const context = await requireInternal();
  if (!can(context, 'job.requeue')) {
    return err('FORBIDDEN', 'You do not have permission to replay a run.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').rpc('replay_run', {
    p_run_id: parsed.data.runId,
    p_reason: parsed.data.reason,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'replayRun', detail: error.message }));
    return err('INTERNAL', 'Could not replay the run.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; job_id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'replayed':
      return ok({ runId: parsed.data.runId, jobId: row.job_id as string });
    case 'unsafe_work_class':
      return err('FORBIDDEN', 'Only a run of read-only work can be replayed — anything that drafts, plans, sends or spends would act twice.');
    case 'no_job':
      return err('CONFLICT', 'The job that produced this run is no longer in the queue, so there is nothing to replay.');
    case 'not_found':
      return err('NOT_FOUND', 'That run is not in this organisation.');
    case 'no_reason':
      return err('VALIDATION', 'Say why the run is being replayed.');
    default:
      return err('FORBIDDEN', 'You do not have permission to replay a run.');
  }
}
