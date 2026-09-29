import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

export type MeetingAwaitingNotes = { id: string; leadId: string; completedAt: string | null; purpose: string | null };

/**
 * Meetings a person marked completed that carry no evidence yet — SCR-060's
 * "awaiting notes". A completed meeting with nothing attached cannot be
 * analysed (`crm.request_meeting_analysis` refuses it), so it is work
 * waiting on a person, not on the system. Two reads: the completed
 * meetings, then which of them have evidence, because PostgREST has no
 * anti-join and a `count` embed would still be a per-row aggregate.
 */
export async function listMeetingsAwaitingNotes(limit = 100): Promise<MeetingAwaitingNotes[]> {
  const supabase = await createClient();

  const { data: meetings, error: meetingsError } = await supabase
    .schema('crm')
    .from('meetings')
    .select('id, lead_id, completed_at, purpose')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (meetingsError) unreadable('listMeetingsAwaitingNotes.meetings', meetingsError);

  const rows = meetings ?? [];
  if (rows.length === 0) return [];

  const { data: evidence, error: evidenceError } = await supabase
    .schema('crm')
    .from('meeting_evidence')
    .select('meeting_id')
    .in(
      'meeting_id',
      rows.map((m) => m.id),
    );
  if (evidenceError) unreadable('listMeetingsAwaitingNotes.evidence', evidenceError);

  const withEvidence = new Set((evidence ?? []).map((e) => e.meeting_id));
  return rows
    .filter((m) => !withEvidence.has(m.id))
    .map((m) => ({ id: m.id, leadId: m.lead_id, completedAt: m.completed_at, purpose: m.purpose }));
}
