import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-007 — the follow-up sequences running against one lead, for the Lead
 * 360's sequences card. A sequence names its subject by (type, id); a
 * lead's sequences are the ones whose subject is the lead itself, plus the
 * ones on its proposals and meetings, which are read by their own ids so
 * nothing is inferred from a conversation.
 */
export type LeadSequence = {
  id: string;
  situationKey: string;
  subjectType: string;
  status: string;
  attemptsSent: number;
  nextDueAt: string | null;
  lastSentAt: string | null;
  stopReason: string | null;
  lastBlockReason: string | null;
};

export async function listSequencesForLead(input: { leadId: string; proposalIds: readonly string[]; meetingIds: readonly string[] }): Promise<LeadSequence[]> {
  const supabase = await createClient();
  const subjectIds = [input.leadId, ...input.proposalIds, ...input.meetingIds];
  const { data, error } = await supabase
    .schema('crm')
    .from('follow_up_sequences')
    .select('id, situation_key, subject_type, subject_id, status, attempts_sent, next_due_at, last_sent_at, stop_reason, last_block_reason')
    .in('subject_id', subjectIds)
    .order('triggered_at', { ascending: false })
    .limit(20);
  if (error) unreadable('listSequencesForLead', error);
  return (data ?? [])
    .filter((r) => (r.subject_type === 'lead' && r.subject_id === input.leadId) || (r.subject_type === 'proposal' && input.proposalIds.includes(r.subject_id)) || (r.subject_type === 'meeting' && input.meetingIds.includes(r.subject_id)))
    .map((r) => ({
      id: r.id,
      situationKey: r.situation_key,
      subjectType: r.subject_type,
      status: r.status,
      attemptsSent: r.attempts_sent,
      nextDueAt: r.next_due_at,
      lastSentAt: r.last_sent_at,
      stopReason: r.stop_reason,
      lastBlockReason: r.last_block_reason,
    }));
}
