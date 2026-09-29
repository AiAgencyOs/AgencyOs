import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { listClientLeads, type ClientLead } from './client-leads';

/**
 * The next moment somebody — a person or the follow-up engine — is due to
 * contact this client. SCR-015's next-follow-up KPI.
 *
 * Two sources, because the product keeps two: `crm.leads.next_follow_up_at`
 * is what a person set on the lead, and `crm.follow_up_sequences.next_due_at`
 * is when an active sequence will send its next attempt. The earliest of
 * either across every lead the client is reachable from is the answer; which
 * one won is returned so the page can say "sequence" or "manual" rather than
 * leaving the reader to guess.
 */

export type ClientNextFollowUp = {
  at: string;
  source: 'sequence' | 'lead';
  leadId: string;
  leadTitle: string;
  /** The sequence's situation key when a sequence won, e.g. `quotation_sent`. */
  situationKey: string | null;
};

export async function readClientNextFollowUp(
  clientAccountId: string,
  leads?: ClientLead[],
): Promise<ClientNextFollowUp | null> {
  const clientLeads = leads ?? (await listClientLeads(clientAccountId));
  if (clientLeads.length === 0) return null;

  const supabase = await createClient();
  const leadIds = clientLeads.map((l) => l.id);
  const titleById = new Map(clientLeads.map((l) => [l.id, l.title]));

  const { data: sequences, error } = await supabase
    .schema('crm')
    .from('follow_up_sequences')
    .select('subject_id, situation_key, next_due_at')
    .eq('subject_type', 'lead')
    .eq('status', 'active')
    .in('subject_id', leadIds)
    .not('next_due_at', 'is', null)
    .order('next_due_at', { ascending: true })
    .limit(1);
  if (error) unreadable('readClientNextFollowUp.sequences', error);

  let best: ClientNextFollowUp | null = null;
  const sequence = (sequences ?? [])[0];
  if (sequence?.next_due_at) {
    best = {
      at: sequence.next_due_at,
      source: 'sequence',
      leadId: sequence.subject_id,
      leadTitle: titleById.get(sequence.subject_id) ?? 'Lead',
      situationKey: sequence.situation_key,
    };
  }

  for (const lead of clientLeads) {
    if (!lead.nextFollowUpAt) continue;
    if (!best || lead.nextFollowUpAt < best.at) {
      best = { at: lead.nextFollowUpAt, source: 'lead', leadId: lead.id, leadTitle: lead.title, situationKey: null };
    }
  }

  return best;
}
