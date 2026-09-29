import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The leads a client account is reachable from.
 *
 * `crm.leads` carries no `client_account_id` of its own; the link exists twice
 * at one remove — `sales.opportunities.client_account_id` (set when a deal is
 * won) and `crm.contacts.client_account_id` (a person attached to the account)
 * through `leads.contact_id`. Both are read and unioned, because a returning
 * client's second enquiry is a lead on a known contact before it is an
 * opportunity on the account, and either path alone would miss it.
 *
 * Shared by the follow-up KPI, the unread-replies KPI and the meeting notes
 * card, so the trace from account to lead is written down once.
 */

export type ClientLead = {
  id: string;
  title: string;
  status: string;
  nextFollowUpAt: string | null;
  createdAt: string;
};

export async function listClientLeads(clientAccountId: string): Promise<ClientLead[]> {
  const supabase = await createClient();

  const [{ data: opportunities, error: oppError }, { data: contacts, error: contactError }] = await Promise.all([
    supabase.schema('sales').from('opportunities').select('lead_id').eq('client_account_id', clientAccountId),
    supabase.schema('crm').from('contacts').select('id').eq('client_account_id', clientAccountId),
  ]);
  if (oppError) unreadable('listClientLeads.opportunities', oppError);
  if (contactError) unreadable('listClientLeads.contacts', contactError);

  const leadIds = new Set<string>();
  for (const o of opportunities ?? []) if (o.lead_id) leadIds.add(o.lead_id);
  const contactIds = (contacts ?? []).map((c) => c.id);

  const byContact =
    contactIds.length > 0
      ? await supabase.schema('crm').from('leads').select('id').in('contact_id', contactIds).is('deleted_at', null)
      : { data: [], error: null };
  if (byContact.error) unreadable('listClientLeads.leadsByContact', byContact.error);
  for (const l of byContact.data ?? []) leadIds.add(l.id);

  if (leadIds.size === 0) return [];

  const { data: leads, error: leadsError } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, title, status, next_follow_up_at, created_at')
    .in('id', [...leadIds])
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (leadsError) unreadable('listClientLeads.leads', leadsError);

  return (leads ?? []).map((l) => ({
    id: l.id,
    title: l.title,
    status: l.status,
    nextFollowUpAt: l.next_follow_up_at,
    createdAt: l.created_at,
  }));
}
