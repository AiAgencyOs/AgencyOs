import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { BacklogRow } from './backlog';

/**
 * Reads for the operations screen. RLS-scoped, so an owner sees their own
 * organization's backlog and nothing else — the same function the cron tick
 * calls with a service-role client to see the whole deployment.
 *
 * `unreadable()` rather than a zero, for the G-054 reason, and here it is the
 * sharpest case in the system: a monitoring page that renders zeros because
 * the database did not answer says "everything is fine" at the exact moment it
 * has no idea. A blank page with an error is the honest answer.
 */

export async function readBacklog(): Promise<BacklogRow> {
  const supabase = await createClient();

  const { data, error } = await supabase.schema('core').rpc('operational_backlog');

  if (error) unreadable('readBacklog', error);

  const row = (Array.isArray(data) ? data[0] : data) as BacklogRow | undefined;
  if (!row) unreadable('readBacklog', { message: 'the backlog query returned no row' });

  return row;
}

/**
 * Seconds since the scheduler last ran an authorized tick, or null if the
 * pulse could not be read. A large value means the cron has stopped — the one
 * failure the in-app monitoring cannot alert on itself, so it is shown here.
 */
export async function readCronAgeSeconds(): Promise<number | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('cron_heartbeat_age_seconds');
  if (error) return null;
  const age = Number(data);
  return Number.isFinite(age) ? Math.round(age) : null;
}

export type DeadJob = {
  id: string;
  kind: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  updated_at: string;
  correlation_id: string | null;
};

/**
 * The dead letters themselves — gap G-058.
 *
 * A count tells an operator that something is wrong; this tells them what. The
 * error is carried through as written, because `last_error` is the only record
 * of why the work stopped and paraphrasing it on the way to the screen would
 * lose the one thing worth reading.
 */
export async function listDeadJobs(limit = 50): Promise<DeadJob[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('core')
    .from('jobs')
    .select('id, kind, attempts, max_attempts, last_error, updated_at, correlation_id')
    .eq('status', 'dead')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) unreadable('listDeadJobs', error);

  return data ?? [];
}
