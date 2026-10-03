import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-006's three per-row indicators, each derived from a stored row:
 *
 * - **Consent** — `crm.communication_consent` for the lead's contact: any
 *   channel granted is "Consent given"; a withdrawal with no grant is
 *   "Withdrawn"; no row at all is "No consent" (absent means no consent —
 *   ADM-70, the send path refuses the same way).
 * - **Human handoff** — the lead's conversation has its agent paused
 *   (`conversations.agent_paused_at`): a person has taken the thread.
 * - **Possible duplicate** — another live (not merged, not deleted) lead
 *   shares the lead's contact. Only same-contact leads can be merged
 *   (`crm.merge_leads` refuses the rest), so this is the set the merge
 *   door accepts.
 *
 * A failed read throws; it never renders as "no indicator".
 */
export type LeadIndicators = {
  contactId: string | null;
  consent: 'granted' | 'withdrawn' | 'none';
  handoff: boolean;
  /** The other live leads on the same contact (id + title), newest first. */
  duplicates: { id: string; title: string }[];
};

export async function readLeadIndicators(leadIds: readonly string[]): Promise<Map<string, LeadIndicators>> {
  const out = new Map<string, LeadIndicators>();
  if (leadIds.length === 0) return out;
  const supabase = await createClient();

  const { data: leads, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, contact_id')
    .in('id', [...leadIds]);
  if (error) unreadable('readLeadIndicators.leads', error);

  const contactIds = [...new Set((leads ?? []).map((l) => l.contact_id).filter((c): c is string => c !== null))];
  const [consent, conversations, siblings] = await Promise.all([
    contactIds.length > 0
      ? supabase.schema('crm').from('communication_consent').select('contact_id, status').in('contact_id', contactIds)
      : Promise.resolve({ data: [] as { contact_id: string; status: string }[], error: null }),
    supabase.schema('crm').from('conversations').select('lead_id, agent_paused_at').in('lead_id', [...leadIds]).not('agent_paused_at', 'is', null),
    contactIds.length > 0
      ? supabase.schema('crm').from('leads').select('id, title, contact_id, updated_at').in('contact_id', contactIds).is('deleted_at', null).is('merged_at', null).order('updated_at', { ascending: false })
      : Promise.resolve({ data: [] as { id: string; title: string; contact_id: string | null; updated_at: string }[], error: null }),
  ]);
  if (consent.error) unreadable('readLeadIndicators.consent', consent.error);
  if (conversations.error) unreadable('readLeadIndicators.conversations', conversations.error);
  if (siblings.error) unreadable('readLeadIndicators.siblings', siblings.error);

  const consentBy = new Map<string, 'granted' | 'withdrawn'>();
  for (const c of consent.data ?? []) {
    if (c.status === 'granted') consentBy.set(c.contact_id, 'granted');
    else if (c.status === 'withdrawn' && consentBy.get(c.contact_id) !== 'granted') consentBy.set(c.contact_id, 'withdrawn');
  }
  const handedOff = new Set((conversations.data ?? []).map((c) => c.lead_id));
  const byContact = new Map<string, { id: string; title: string }[]>();
  for (const s of siblings.data ?? []) {
    if (!s.contact_id) continue;
    byContact.set(s.contact_id, [...(byContact.get(s.contact_id) ?? []), { id: s.id, title: s.title }]);
  }

  for (const l of leads ?? []) {
    out.set(l.id, {
      contactId: l.contact_id,
      consent: l.contact_id ? (consentBy.get(l.contact_id) ?? 'none') : 'none',
      handoff: handedOff.has(l.id),
      duplicates: l.contact_id ? (byContact.get(l.contact_id) ?? []).filter((s) => s.id !== l.id) : [],
    });
  }
  return out;
}
