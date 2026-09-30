import 'server-only';

import { ilikeAny, ilikeOperand } from '@/lib/db/search';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { SITUATIONS } from './follow-up-situations';

/**
 * The Follow-ups screen's fuller read — SCR-013.
 *
 * `listFollowUpSequences` carries the columns a row needs; the detail
 * drawer needs the drafted body, its language, who drafted it, the last
 * block reason and the escalation, and the channel and owner filters need
 * two facts a sequence does not hold itself: the conversation's channel
 * and the lead's assignee. Both are joined here by id under the caller's
 * own RLS, as `listFollowUpSequences` already does for lead titles.
 */
export type FollowUpSequenceDetail = {
  id: string;
  situation_key: string;
  subject_type: string;
  subject_id: string;
  status: string;
  attempts_sent: number;
  next_due_at: string | null;
  last_sent_at: string | null;
  triggered_at: string;
  stop_reason: string | null;
  escalated_at: string | null;
  drafted_at: string | null;
  drafted_body: string | null;
  drafted_language: string | null;
  drafted_by_agent: string | null;
  last_block_reason: string | null;
  last_evaluated_at: string | null;
  conversation_id: string | null;
  correlation_id: string;
  subjectTitle: string | null;
  /** The conversation's channel, when the sequence is attached to one. */
  channel: string | null;
  /** The lead's assignee, when the subject is a lead. */
  ownerId: string | null;
  leadId: string | null;
};

export async function listFollowUpSequencesDetailed(filter?: {
  status?: string;
  limit?: number;
  /** Search within domain (bucket G-3): the lead's title, or the situation key. Server-side. */
  q?: string;
}): Promise<FollowUpSequenceDetail[]> {
  const supabase = await createClient();

  // A sequence carries no name of its own; the human-named column is the
  // lead it runs against. Resolve the matching leads first, then filter the
  // sequences to those subjects or a matching situation key — two reads,
  // both server-side.
  let matchingLeadIds: string[] = [];
  if (filter?.q) {
    const { data: leadMatches, error: leadMatchError } = await supabase.schema('crm').from('leads').select('id').or(ilikeAny(['title'], filter.q)).limit(500);
    if (leadMatchError) unreadable('listFollowUpSequencesDetailed.search', leadMatchError);
    matchingLeadIds = (leadMatches ?? []).map((l) => l.id);
  }

  let query = supabase
    .schema('crm')
    .from('follow_up_sequences')
    .select(
      'id, situation_key, subject_type, subject_id, status, attempts_sent, next_due_at, last_sent_at, triggered_at, stop_reason, escalated_at, drafted_at, drafted_body, drafted_language, drafted_by_agent, last_block_reason, last_evaluated_at, conversation_id, correlation_id',
    )
    .order('next_due_at', { ascending: true, nullsFirst: false })
    .limit(Math.min(filter?.limit ?? 100, 200));
  if (filter?.status) query = query.eq('status', filter.status);
  if (filter?.q) {
    const bySituation = `situation_key.ilike.${ilikeOperand(filter.q)}`;
    query = query.or(matchingLeadIds.length > 0 ? `${bySituation},subject_id.in.(${matchingLeadIds.join(',')})` : bySituation);
  }

  const { data, error } = await query;
  if (error) unreadable('listFollowUpSequencesDetailed', error);

  const rows = data ?? [];
  const leadIds = [...new Set(rows.filter((r) => r.subject_type === 'lead').map((r) => r.subject_id))];
  const conversationIds = [...new Set(rows.map((r) => r.conversation_id).filter((id): id is string => id !== null))];

  const leads = new Map<string, { title: string; assigned_to: string | null }>();
  if (leadIds.length > 0) {
    const { data: leadRows, error: leadsError } = await supabase
      .schema('crm')
      .from('leads')
      .select('id, title, assigned_to')
      .in('id', leadIds);
    if (leadsError) unreadable('listFollowUpSequencesDetailed.leads', leadsError);
    for (const l of leadRows ?? []) leads.set(l.id, { title: l.title, assigned_to: l.assigned_to });
  }

  const conversations = new Map<string, { channel: string; lead_id: string | null }>();
  if (conversationIds.length > 0) {
    const { data: convRows, error: convError } = await supabase
      .schema('crm')
      .from('conversations')
      .select('id, channel, lead_id')
      .in('id', conversationIds);
    if (convError) unreadable('listFollowUpSequencesDetailed.conversations', convError);
    for (const c of convRows ?? []) conversations.set(c.id, { channel: c.channel, lead_id: c.lead_id });
  }

  return rows.map((r) => {
    const conversation = r.conversation_id ? (conversations.get(r.conversation_id) ?? null) : null;
    const leadId = r.subject_type === 'lead' ? r.subject_id : (conversation?.lead_id ?? null);
    const lead = leadId ? (leads.get(leadId) ?? null) : null;
    return {
      ...r,
      subjectTitle: r.subject_type === 'lead' ? (lead?.title ?? null) : null,
      channel: conversation?.channel ?? null,
      ownerId: lead?.assigned_to ?? null,
      leadId,
    };
  });
}

/**
 * Which approved WhatsApp template answers which follow-up situation —
 * SCR-013's mapping view. `crm.whatsapp_templates.situation_key` is what
 * the sender looks up when a sequence is outside the 24-hour window; a
 * situation with no active approved template is one whose nudges the
 * window gate will suppress. Every situation the contract names is
 * listed, with whatever the registry holds for it — including nothing.
 */
export type TemplateSituationRow = {
  situationKey: string;
  situationName: string | null;
  automation: string | null;
  templates: { name: string; language: string; status: string; active: boolean }[];
  /** Sequences currently running on this situation, from the same read. */
  running: number;
};

export async function listTemplateSituationMapping(
  sequences: readonly Pick<FollowUpSequenceDetail, 'situation_key' | 'status'>[],
): Promise<TemplateSituationRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('whatsapp_templates')
    .select('situation_key, template_name, language_code, status, active')
    .order('situation_key', { ascending: true });
  if (error) unreadable('listTemplateSituationMapping', error);

  const byKey = new Map<string, TemplateSituationRow['templates']>();
  for (const t of data ?? []) {
    const list = byKey.get(t.situation_key) ?? [];
    list.push({ name: t.template_name, language: t.language_code, status: t.status, active: t.active });
    byKey.set(t.situation_key, list);
  }

  const keys = [...new Set([...SITUATIONS.map((s) => s.key), ...byKey.keys(), ...sequences.map((s) => s.situation_key)])];
  return keys.map((key) => {
    const situation = SITUATIONS.find((s) => s.key === key) ?? null;
    return {
      situationKey: key,
      situationName: situation?.name ?? null,
      automation: situation?.automation ?? null,
      templates: byKey.get(key) ?? [],
      running: sequences.filter((s) => s.situation_key === key && s.status === 'active').length,
    };
  });
}
