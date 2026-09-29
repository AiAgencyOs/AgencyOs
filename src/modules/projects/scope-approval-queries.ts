import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/** SCR-030 — the approval evidence recorded on each of a project's scope versions. */
export type ScopeApproval = { scopeVersionId: string; approvedBy: string | null; approvedAt: string | null; evidenceUrl: string | null; note: string | null };

export async function readScopeApprovals(projectId: string): Promise<Record<string, ScopeApproval>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('scope_versions')
    .select('id, approved_by, approved_at, approval_evidence_url, approval_note')
    .eq('project_id', projectId);
  if (error) unreadable('readScopeApprovals', error);
  const out: Record<string, ScopeApproval> = {};
  for (const r of data ?? []) {
    out[r.id] = { scopeVersionId: r.id, approvedBy: r.approved_by, approvedAt: r.approved_at, evidenceUrl: r.approval_evidence_url, note: r.approval_note };
  }
  return out;
}
