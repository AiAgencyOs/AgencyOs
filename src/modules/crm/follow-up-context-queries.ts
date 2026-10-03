import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-013 — the client and project behind each sequence, so a row on the
 * Follow-ups screen says who it is chasing and about what, not only which
 * lead. Nothing here is guessed: a lead's client is the account on its
 * deal, a proposal's is its deal's, a project's is its own, and a meeting's
 * is its lead's. A sequence with none of those (an approval request, a
 * lead with no deal) carries no context and the row says nothing.
 */
export type FollowUpContext = {
  leadId: string | null;
  clientAccountId: string | null;
  clientName: string | null;
  projectId: string | null;
  projectName: string | null;
};

type Seq = { id: string; subject_type: string; subject_id: string };

export async function readFollowUpContexts(sequences: readonly Seq[]): Promise<Map<string, FollowUpContext>> {
  const out = new Map<string, FollowUpContext>();
  if (sequences.length === 0) return out;
  const supabase = await createClient();

  const meetingIds = sequences.filter((s) => s.subject_type === 'meeting').map((s) => s.subject_id);
  const meetingLead = new Map<string, string>();
  if (meetingIds.length > 0) {
    const { data, error } = await supabase.schema('crm').from('meetings').select('id, lead_id').in('id', meetingIds);
    if (error) unreadable('readFollowUpContexts.meetings', error);
    for (const m of data ?? []) meetingLead.set(m.id, m.lead_id);
  }

  const leadOf = (s: Seq): string | null => (s.subject_type === 'lead' ? s.subject_id : s.subject_type === 'meeting' ? (meetingLead.get(s.subject_id) ?? null) : null);
  const leadIds = [...new Set(sequences.map(leadOf).filter((id): id is string => id !== null))];
  const proposalIds = sequences.filter((s) => s.subject_type === 'proposal').map((s) => s.subject_id);
  const directProjectIds = sequences.filter((s) => s.subject_type === 'project').map((s) => s.subject_id);

  // Proposal → opportunity.
  const proposalOpportunity = new Map<string, string>();
  if (proposalIds.length > 0) {
    const { data, error } = await supabase.schema('sales').from('proposals').select('id, opportunity_id').in('id', proposalIds);
    if (error) unreadable('readFollowUpContexts.proposals', error);
    for (const p of data ?? []) proposalOpportunity.set(p.id, p.opportunity_id);
  }

  // Lead → its newest opportunity; opportunity → client account.
  const opportunityIds = new Set<string>(proposalOpportunity.values());
  const leadOpportunity = new Map<string, string>();
  const opportunityClient = new Map<string, string | null>();
  if (leadIds.length > 0 || opportunityIds.size > 0) {
    let query = supabase.schema('sales').from('opportunities').select('id, lead_id, client_account_id, created_at').order('created_at', { ascending: false });
    const ors: string[] = [];
    if (leadIds.length > 0) ors.push(`lead_id.in.(${leadIds.join(',')})`);
    if (opportunityIds.size > 0) ors.push(`id.in.(${[...opportunityIds].join(',')})`);
    query = query.or(ors.join(','));
    const { data, error } = await query;
    if (error) unreadable('readFollowUpContexts.opportunities', error);
    for (const o of data ?? []) {
      opportunityClient.set(o.id, o.client_account_id);
      if (o.lead_id && !leadOpportunity.has(o.lead_id)) leadOpportunity.set(o.lead_id, o.id);
    }
  }

  // Opportunity → the project it became; direct project ids → their client.
  const allOpportunityIds = [...new Set([...opportunityIds, ...leadOpportunity.values()])];
  const projectByOpportunity = new Map<string, { id: string; name: string; client_account_id: string }>();
  const projectById = new Map<string, { id: string; name: string; client_account_id: string }>();
  if (allOpportunityIds.length > 0 || directProjectIds.length > 0) {
    let query = supabase.schema('projects').from('projects').select('id, name, client_account_id, opportunity_id').is('deleted_at', null);
    const ors: string[] = [];
    if (allOpportunityIds.length > 0) ors.push(`opportunity_id.in.(${allOpportunityIds.join(',')})`);
    if (directProjectIds.length > 0) ors.push(`id.in.(${directProjectIds.join(',')})`);
    query = query.or(ors.join(','));
    const { data, error } = await query;
    if (error) unreadable('readFollowUpContexts.projects', error);
    for (const p of data ?? []) {
      projectById.set(p.id, p);
      if (p.opportunity_id) projectByOpportunity.set(p.opportunity_id, p);
    }
  }

  const clientIds = new Set<string>();
  for (const c of opportunityClient.values()) if (c) clientIds.add(c);
  for (const p of projectById.values()) clientIds.add(p.client_account_id);
  const clientName = new Map<string, string>();
  if (clientIds.size > 0) {
    const { data, error } = await supabase.schema('core').from('client_accounts').select('id, name').in('id', [...clientIds]);
    if (error) unreadable('readFollowUpContexts.clients', error);
    for (const c of data ?? []) clientName.set(c.id, c.name);
  }

  for (const s of sequences) {
    const leadId = leadOf(s);
    const opportunityId = s.subject_type === 'proposal' ? (proposalOpportunity.get(s.subject_id) ?? null) : leadId ? (leadOpportunity.get(leadId) ?? null) : null;
    const project = s.subject_type === 'project' ? (projectById.get(s.subject_id) ?? null) : opportunityId ? (projectByOpportunity.get(opportunityId) ?? null) : null;
    const clientAccountId = project?.client_account_id ?? (opportunityId ? (opportunityClient.get(opportunityId) ?? null) : null);
    out.set(s.id, {
      leadId,
      clientAccountId,
      clientName: clientAccountId ? (clientName.get(clientAccountId) ?? null) : null,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
    });
  }
  return out;
}
