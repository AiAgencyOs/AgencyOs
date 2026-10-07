import 'server-only';

import { createClient } from '@/lib/db/server';
import { asRows, looseSchema } from '@/lib/p13/loose-client';
import { unreadable } from '@/lib/result';

/**
 * Lead 360 (P1-BLUEPRINT-010) tabs that did not exist: Negotiation, Tasks (agent work) and Audit. Plain reads of rows the caller's RLS already lets them see;
 * `src/lib/db/types.ts` is stale for some of these tables, so they go through the narrow loose view and each field is validated here. A failed read is
 * reported (`unreadable`), never shown as "nothing here".
 */

export type LeadObjection = { id: string; round: number; kind: string; concern: string; response: string | null; outcome: string | null; nextAction: string | null; at: string };

export async function readLeadObjections(leadId: string): Promise<LeadObjection[]> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'sales')
    .from('objections')
    .select('id, round, kind, concern, response, outcome, next_action, created_at')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) unreadable('readLeadObjections', error);
  return asRows(data).map((r) => ({
    id: String(r.id),
    round: Number(r.round) || 0,
    kind: String(r.kind),
    concern: String(r.concern),
    response: r.response ? String(r.response) : null,
    outcome: r.outcome ? String(r.outcome) : null,
    nextAction: r.next_action ? String(r.next_action) : null,
    at: String(r.created_at),
  }));
}

export type LeadAgentTask = { id: string; fromAgent: string; toAgent: string; status: string; priority: string; objective: string; blocker: string | null; uncertain: boolean; createdAt: string };

/** The agent work that names this lead, its deal or one of its quotations. Two reads, merged and de-duplicated. */
export async function readLeadAgentTasks(input: { leadId: string; opportunityId: string | null; proposalIds: readonly string[] }): Promise<LeadAgentTask[]> {
  const supabase = await createClient();
  const handoffs = looseSchema(supabase, 'ai');
  const columns = 'id, from_agent, to_agent, status, priority, objective, blocker, side_effect_uncertain, created_at';
  const subjectIds = [input.leadId, ...(input.opportunityId ? [input.opportunityId] : [])];
  const bySubject = await handoffs.from('handoffs').select(columns).in('subject_id', subjectIds).order('created_at', { ascending: false }).limit(50);
  if (bySubject.error) unreadable('readLeadAgentTasks.subject', bySubject.error);
  let byProposal: Record<string, unknown>[] = [];
  if (input.proposalIds.length > 0) {
    const res = await handoffs.from('handoffs').select(columns).in('bound_proposal_id', input.proposalIds).order('created_at', { ascending: false }).limit(50);
    if (res.error) unreadable('readLeadAgentTasks.proposal', res.error);
    byProposal = asRows(res.data);
  }
  const seen = new Set<string>();
  return [...asRows(bySubject.data), ...byProposal]
    .filter((r) => (seen.has(String(r.id)) ? false : (seen.add(String(r.id)), true)))
    .map((r) => ({
      id: String(r.id),
      fromAgent: String(r.from_agent),
      toAgent: String(r.to_agent),
      status: String(r.status),
      priority: String(r.priority),
      objective: String(r.objective),
      blocker: r.blocker ? String(r.blocker) : null,
      uncertain: r.side_effect_uncertain === true,
      createdAt: String(r.created_at),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50);
}

export type LeadAuditRow = { id: number; action: string; subjectType: string; actorType: string; at: string; correlationId: string | null };

/** The audit entries whose subject is this lead, its deal, its quotations or its conversations. Owner and ops admin only (the table's own RLS). */
export async function readLeadAudit(subjectIds: readonly string[]): Promise<LeadAuditRow[]> {
  if (subjectIds.length === 0) return [];
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'audit')
    .from('audit_log')
    .select('id, action, subject_type, actor_type, created_at, correlation_id')
    .in('subject_id', subjectIds)
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) unreadable('readLeadAudit', error);
  return asRows(data).map((r) => ({
    id: Number(r.id),
    action: String(r.action),
    subjectType: String(r.subject_type),
    actorType: String(r.actor_type),
    at: String(r.created_at),
    correlationId: r.correlation_id ? String(r.correlation_id) : null,
  }));
}
