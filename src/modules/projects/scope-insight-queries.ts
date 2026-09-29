import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What the scope tab could not say about its own baseline — SCR-030.
 *
 * Three reads, each over columns the product has written for weeks and
 * shown nowhere on this tab:
 *
 *   · the quotation a baseline descends from —
 *     `scope_versions.requirement_version_id` → `sales.proposals` citing the
 *     same requirement version. A baseline that cannot name its quote is a
 *     list nobody can check against what was priced;
 *   · drift — the change requests that were approved or applied against the
 *     ACTIVE baseline, and (when the open draft was opened by one of them,
 *     `scope_versions.change_request_id`) the item-level difference between
 *     what is frozen and what is about to replace it;
 *   · the revision allowance — `phase_three.client_revision_count/limit` and
 *     `phase_four.ui_/prototype_revision_count/limit`, read as stored. The
 *     database refuses the round past the limit (20260918160000); this only
 *     shows how close the project is.
 *
 * Nothing here decides anything. The freeze checklist on the page is built
 * from `readScopeBaseline` and `readChangeRequests`, both of which the tab
 * already read, so it lives in the page rather than here.
 */

export type ScopeQuoteLink = {
  scopeVersionId: string;
  requirementVersionId: string | null;
  proposals: { id: string; title: string; version: number; status: string }[];
};

export async function readScopeQuoteLinks(projectId: string): Promise<ScopeQuoteLink[]> {
  const supabase = await createClient();

  const { data: versions, error: versionsError } = await supabase
    .schema('projects')
    .from('scope_versions')
    .select('id, requirement_version_id')
    .eq('project_id', projectId);
  if (versionsError) unreadable('readScopeQuoteLinks.versions', versionsError);

  const requirementIds = [...new Set((versions ?? []).map((v) => v.requirement_version_id).filter((id): id is string => id !== null))];
  const proposalsByRequirement = new Map<string, ScopeQuoteLink['proposals']>();
  if (requirementIds.length > 0) {
    const { data: proposals, error: proposalsError } = await supabase
      .schema('sales')
      .from('proposals')
      .select('id, title, version, status, requirement_version_id')
      .in('requirement_version_id', requirementIds)
      .order('version', { ascending: false });
    if (proposalsError) unreadable('readScopeQuoteLinks.proposals', proposalsError);
    for (const p of proposals ?? []) {
      if (!p.requirement_version_id) continue;
      const list = proposalsByRequirement.get(p.requirement_version_id) ?? [];
      list.push({ id: p.id, title: p.title, version: p.version, status: p.status });
      proposalsByRequirement.set(p.requirement_version_id, list);
    }
  }

  return (versions ?? []).map((v) => ({
    scopeVersionId: v.id,
    requirementVersionId: v.requirement_version_id,
    proposals: v.requirement_version_id ? (proposalsByRequirement.get(v.requirement_version_id) ?? []) : [],
  }));
}

export type ScopeDrift = {
  /** Change requests approved or applied against the active baseline. */
  appliedRequests: { id: string; requested: string; status: string; classification: string | null; resultingVersion: number | null }[];
  /** The change request that opened the current draft, if one did. */
  draftOpenedBy: { id: string; requested: string } | null;
  /** Item titles in the draft that the active baseline does not have. */
  added: string[];
  /** Item titles on the active baseline that the draft drops. */
  removed: string[];
};

export async function readScopeDrift(projectId: string): Promise<ScopeDrift | null> {
  const supabase = await createClient();

  const { data: versions, error: versionsError } = await supabase
    .schema('projects')
    .from('scope_versions')
    .select('id, version, status, change_request_id')
    .eq('project_id', projectId)
    .in('status', ['active', 'draft']);
  if (versionsError) unreadable('readScopeDrift.versions', versionsError);

  const active = (versions ?? []).find((v) => v.status === 'active');
  if (!active) return null;
  const draft = (versions ?? []).find((v) => v.status === 'draft') ?? null;

  const { data: requests, error: requestsError } = await supabase
    .schema('projects')
    .from('change_requests')
    .select('id, requested, status, classification, resulting_scope_version_id')
    .eq('scope_version_id', active.id)
    .in('status', ['approved', 'implemented']);
  if (requestsError) unreadable('readScopeDrift.requests', requestsError);

  const resultingIds = (requests ?? []).map((r) => r.resulting_scope_version_id).filter((id): id is string => id !== null);
  const versionNumber = new Map<string, number>();
  if (resultingIds.length > 0) {
    const { data: resulting, error: resultingError } = await supabase
      .schema('projects')
      .from('scope_versions')
      .select('id, version')
      .in('id', resultingIds);
    if (resultingError) unreadable('readScopeDrift.resulting', resultingError);
    for (const v of resulting ?? []) versionNumber.set(v.id, v.version);
  }

  let draftOpenedBy: ScopeDrift['draftOpenedBy'] = null;
  let added: string[] = [];
  let removed: string[] = [];
  if (draft) {
    if (draft.change_request_id) {
      const { data: opener, error: openerError } = await supabase
        .schema('projects')
        .from('change_requests')
        .select('id, requested')
        .eq('id', draft.change_request_id)
        .maybeSingle();
      if (openerError) unreadable('readScopeDrift.opener', openerError);
      draftOpenedBy = opener ? { id: opener.id, requested: opener.requested } : null;
    }

    const { data: items, error: itemsError } = await supabase
      .schema('projects')
      .from('scope_items')
      .select('scope_version_id, title, inclusion')
      .in('scope_version_id', [active.id, draft.id]);
    if (itemsError) unreadable('readScopeDrift.items', itemsError);

    const key = (i: { title: string; inclusion: string }) => `${i.title.trim().toLowerCase()}|${i.inclusion}`;
    const activeKeys = new Map((items ?? []).filter((i) => i.scope_version_id === active.id).map((i) => [key(i), i.title]));
    const draftKeys = new Map((items ?? []).filter((i) => i.scope_version_id === draft.id).map((i) => [key(i), i.title]));
    added = [...draftKeys].filter(([k]) => !activeKeys.has(k)).map(([, title]) => title);
    removed = [...activeKeys].filter(([k]) => !draftKeys.has(k)).map(([, title]) => title);
  }

  return {
    appliedRequests: (requests ?? []).map((r) => ({
      id: r.id,
      requested: r.requested,
      status: r.status,
      classification: r.classification,
      resultingVersion: r.resulting_scope_version_id ? (versionNumber.get(r.resulting_scope_version_id) ?? null) : null,
    })),
    draftOpenedBy,
    added,
    removed,
  };
}

export type RevisionAllowance = {
  design: { used: number; limit: number } | null;
  ui: { used: number; limit: number } | null;
  prototype: { used: number; limit: number } | null;
};

export async function readRevisionAllowance(projectId: string): Promise<RevisionAllowance> {
  const supabase = await createClient();

  const [three, four] = await Promise.all([
    supabase
      .schema('projects')
      .from('phase_three')
      .select('client_revision_count, client_revision_limit')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // `projects.phase_four` post-dates the generated types; the row is typed
    // by hand from `readPhaseFourOverview`'s own select.
    supabase
      .schema('projects')
      .from('phase_four')
      .select('ui_revision_count, ui_revision_limit, prototype_revision_count, prototype_revision_limit')
      .eq('project_id', projectId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (three.error) unreadable('readRevisionAllowance.phaseThree', three.error);
  if (four.error) unreadable('readRevisionAllowance.phaseFour', four.error);

  const fourRow = four.data as {
    ui_revision_count: number;
    ui_revision_limit: number;
    prototype_revision_count: number;
    prototype_revision_limit: number;
  } | null;

  return {
    design: three.data ? { used: three.data.client_revision_count, limit: three.data.client_revision_limit } : null,
    ui: fourRow ? { used: fourRow.ui_revision_count, limit: fourRow.ui_revision_limit } : null,
    prototype: fourRow ? { used: fourRow.prototype_revision_count, limit: fourRow.prototype_revision_limit } : null,
  };
}
