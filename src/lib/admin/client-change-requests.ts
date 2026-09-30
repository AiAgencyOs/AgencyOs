import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Change-request charges on a client — SCR-016. Every change request on
 * the client's projects with the AMOUNT it was priced at: a paid change
 * carries a `proposal_id`, and that quotation's frozen total is the charge.
 * A change with no quotation yet is listed with no amount rather than an
 * estimate; a free change is listed at nothing, which is what it cost.
 */
export type ClientChangeRequest = {
  id: string;
  projectId: string;
  projectName: string;
  requested: string;
  classification: string | null;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  proposalId: string | null;
  proposalTitle: string | null;
  proposalVersion: number | null;
  proposalStatus: string | null;
  amountMinor: number | null;
  currency: string;
};

export async function listClientChangeRequests(projects: readonly { id: string; name: string; currency: string }[]): Promise<ClientChangeRequest[]> {
  if (projects.length === 0) return [];
  const supabase = await createClient();
  const byId = new Map(projects.map((p) => [p.id, p]));
  const { data, error } = await supabase
    .schema('projects')
    .from('change_requests')
    .select('id, project_id, requested, classification, status, created_at, decided_at, proposal_id')
    .in('project_id', projects.map((p) => p.id))
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) unreadable('listClientChangeRequests', error);
  const rows = data ?? [];
  const proposalIds = [...new Set(rows.map((r) => r.proposal_id).filter((id): id is string => id !== null))];
  const proposals = new Map<string, { title: string; version: number; status: string; total_minor: number; currency: string }>();
  if (proposalIds.length > 0) {
    const { data: ps, error: psError } = await supabase.schema('sales').from('proposals').select('id, title, version, status, total_minor, currency').in('id', proposalIds);
    if (psError) unreadable('listClientChangeRequests.proposals', psError);
    for (const p of ps ?? []) proposals.set(p.id, p);
  }
  return rows.map((r) => {
    const p = r.proposal_id ? (proposals.get(r.proposal_id) ?? null) : null;
    const project = byId.get(r.project_id);
    return {
      id: r.id,
      projectId: r.project_id,
      projectName: project?.name ?? 'Project',
      requested: r.requested,
      classification: r.classification,
      status: r.status,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      proposalId: r.proposal_id,
      proposalTitle: p?.title ?? null,
      proposalVersion: p?.version ?? null,
      proposalStatus: p?.status ?? null,
      amountMinor: p ? p.total_minor : r.classification === 'free_change' || r.classification === 'clarification' ? 0 : null,
      currency: p?.currency ?? project?.currency ?? 'INR',
    };
  });
}
