import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { BacklogRow } from './backlog';
import type { FailedDeliveryRow } from './delivery';

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

export type WedgedFollowUp = {
  /** The worker's own last_block_reason — reported, not judged. */
  reason: string;
  wedged: number;
  oldest_due_at: string | null;
};

/**
 * Follow-up sequences the worker keeps evaluating but cannot advance — gap
 * G-012. A block is not an attempt and does not move `next_due_at`, so a
 * sequence stuck on the same reason sits active and overdue forever, sending
 * nothing, while no job is dead and nothing else in the backlog moves. This
 * reads `core.wedged_follow_ups()`, grouped by reason so a human can tell the
 * expected G-137 timezone wait from a real defect.
 *
 * `unreadable()` on error for the G-054 reason the whole operations page holds:
 * a monitor that renders an empty list because the database did not answer says
 * "nothing is wedged" at the moment it has no idea.
 */
export async function readWedgedFollowUps(): Promise<WedgedFollowUp[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('wedged_follow_ups');
  if (error) unreadable('readWedgedFollowUps', error);
  return (data ?? []) as WedgedFollowUp[];
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

/**
 * Client messages that left the outbox and the provider REFUSED — the other
 * half of "what is going wrong", one the job/event backlog never shows.
 *
 * A dead job is work the runner gave up on; this is a message that ran to
 * completion and bounced. `crm.mark_outbound_delivery` stamps the outcome into
 * the message's own metadata (`delivery:'failed'`, with the provider's `error`
 * and its `provider_ref`), so the record already exists per-message and RLS
 * already scopes it — this only gathers the failed ones for a screen. Only
 * outbound messages carry a `delivery` key, so an inbound client message can
 * never appear here; the filter names `failed` exactly, so a `pending` or
 * `sent` one cannot either.
 *
 * `unreadable()` on error for the same G-054 reason the whole page holds: an
 * empty list because the database did not answer would read as "nothing
 * failed" at the moment it cannot tell.
 */
export async function listFailedDeliveries(limit = 50): Promise<FailedDeliveryRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .select('author_type, body, metadata, occurred_at')
    .eq('metadata->>delivery', 'failed')
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (error) unreadable('listFailedDeliveries', error);

  return (data ?? []).map((m) => ({
    authorType: m.author_type as string,
    body: m.body as string,
    metadata: (m.metadata ?? null) as Record<string, unknown> | null,
    occurredAt: m.occurred_at as string,
  }));
}
