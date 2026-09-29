import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { readAudienceCandidates } from './campaign-queries';
import { expandAudience, type CampaignAudience } from './campaign-schema';

/**
 * SCR-059 "Send preview" — what the first recipients would actually receive:
 * the template by name and language, and each parameter filled from the
 * recorded facts the worker will use, or marked missing. A template's body
 * lives at Meta, not here, so the preview is the template's identity plus
 * its filled variables — exactly what the provider is handed. Read under
 * RLS; resolves only the contact facts (the agency's name comes from the
 * organization), which is what a campaign template names.
 */
export type PreviewRecipient = {
  leadId: string;
  leadTitle: string;
  conversationId: string | null;
  values: { name: string; value: string | null }[];
};

export type CampaignSendPreview = {
  templateName: string;
  languageCode: string;
  parameters: string[];
  recipients: PreviewRecipient[];
  total: number;
};

function firstNameOf(fullName: string | null): string | null {
  const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
  if (first.length < 2 || !/\p{L}/u.test(first) || /\d/.test(first)) return null;
  return first;
}

export async function readCampaignSendPreview(
  campaign: { id: string; status: string; templateId: string; audience: CampaignAudience },
  limit = 5,
): Promise<CampaignSendPreview | null> {
  const supabase = await createClient();
  const { data: template, error } = await supabase
    .schema('crm')
    .from('whatsapp_templates')
    .select('template_name, language_code, parameters')
    .eq('id', campaign.templateId)
    .maybeSingle();
  if (error) unreadable('readCampaignSendPreview.template', error);
  if (!template) return null;

  // Draft: the audience as the approval would expand it now. Otherwise: the
  // rows the approval wrote.
  let heads: { leadId: string; conversationId: string | null }[];
  let total: number;
  if (campaign.status === 'draft') {
    const all = expandAudience(await readAudienceCandidates(), campaign.audience, new Date());
    total = all.length;
    heads = all.slice(0, limit);
  } else {
    const { data, error: rError } = await supabase
      .schema('crm')
      .from('campaign_recipients')
      .select('lead_id, conversation_id')
      .eq('campaign_id', campaign.id)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (rError) unreadable('readCampaignSendPreview.recipients', rError);
    const { count, error: cError } = await supabase.schema('crm').from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id);
    if (cError) unreadable('readCampaignSendPreview.count', cError);
    heads = (data ?? []).filter((r) => r.lead_id).map((r) => ({ leadId: r.lead_id as string, conversationId: r.conversation_id }));
    total = count ?? heads.length;
  }
  if (heads.length === 0) return { templateName: template.template_name, languageCode: template.language_code, parameters: template.parameters ?? [], recipients: [], total };

  const [leads, conversations, org] = await Promise.all([
    supabase.schema('crm').from('leads').select('id, title').in('id', heads.map((h) => h.leadId)),
    supabase
      .schema('crm')
      .from('conversations')
      .select('id, contact_id')
      .in('id', heads.map((h) => h.conversationId).filter((id): id is string => id !== null)),
    supabase.schema('core').from('organizations').select('name').limit(1).maybeSingle(),
  ]);
  if (leads.error) unreadable('readCampaignSendPreview.leads', leads.error);
  if (conversations.error) unreadable('readCampaignSendPreview.conversations', conversations.error);
  if (org.error) unreadable('readCampaignSendPreview.org', org.error);
  const contactIds = (conversations.data ?? []).map((c) => c.contact_id).filter((id): id is string => id !== null);
  const { data: contacts, error: contactsError } = contactIds.length > 0 ? await supabase.schema('crm').from('contacts').select('id, full_name').in('id', contactIds) : { data: [], error: null };
  if (contactsError) unreadable('readCampaignSendPreview.contacts', contactsError);

  const titleByLead = new Map((leads.data ?? []).map((l) => [l.id, l.title]));
  const contactByConversation = new Map((conversations.data ?? []).map((c) => [c.id, c.contact_id]));
  const nameByContact = new Map((contacts ?? []).map((c) => [c.id, c.full_name]));
  const parameters = template.parameters ?? [];

  const recipients: PreviewRecipient[] = heads.map((h) => {
    const contactId = h.conversationId ? contactByConversation.get(h.conversationId) : null;
    const fullName = contactId ? (nameByContact.get(contactId) ?? null) : null;
    return {
      leadId: h.leadId,
      leadTitle: titleByLead.get(h.leadId) ?? h.leadId,
      conversationId: h.conversationId,
      values: parameters.map((name) => ({
        name,
        value:
          name === 'contact_first_name'
            ? firstNameOf(fullName)
            : name === 'contact_full_name'
              ? (fullName?.trim() || null)
              : name === 'agency_name'
                ? (org.data?.name ?? null)
                : null,
      })),
    };
  });

  return { templateName: template.template_name, languageCode: template.language_code, parameters, recipients, total };
}
