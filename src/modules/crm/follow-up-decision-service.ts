import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { decideFollowUpSequenceSchema, type DecideFollowUpSequenceInput, type FollowUpDecision } from './follow-up-decision-schema';

/**
 * SCR-013 — the three decisions a person takes about a sequence, through
 * the one database door that writes them. `lead.write` is the capability
 * `stopFollowUpSequence` already takes; the door checks the session again,
 * RLS decides on the row, and `core.record_audit` records the decision.
 */
export async function decideFollowUpSequence(input: DecideFollowUpSequenceInput): Promise<Result<{ outcome: FollowUpDecision }>> {
  const parsed = decideFollowUpSequenceSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid decision.');

  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to decide follow-ups.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('decide_follow_up_sequence', {
    p_sequence_id: parsed.data.sequenceId,
    p_action: parsed.data.action,
    p_reason: parsed.data.reason,
    p_next_due_at: parsed.data.nextDueAt ?? null,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'decideFollowUpSequence', detail: error.message }));
    return err('INTERNAL', 'The decision could not be recorded.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'rescheduled':
    case 'completed':
    case 'cancelled':
      return ok({ outcome: parsed.data.action });
    case 'not_found':
      return err('NOT_FOUND', 'Sequence not found.');
    case 'not_open':
      return err('CONFLICT', 'This sequence is already over; only an active, escalated or stopped one is decided.');
    case 'no_reason':
      return err('VALIDATION', 'Say why, in a sentence.');
    case 'no_time':
      return err('VALIDATION', 'A reschedule needs the new time.');
    case 'bad_action':
      return err('VALIDATION', 'Not a decision this door takes.');
    default:
      return err('FORBIDDEN', 'You do not have permission to decide follow-ups.');
  }
}
