import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What surrounds a change request — SCR-031.
 *
 * Three reads the classify/decide/apply surface never made:
 *
 *   · the payment gate. A paid change is decided against a proposal (ADM-22,
 *     `change_requests.proposal_id`), and the proposal's own state is what
 *     says whether the client has agreed to pay. `finance.invoices` carries
 *     no proposal column, so the invoice side of the gate is the project's
 *     invoice ledger, summarised — and read only when the caller's role can
 *     read invoices at all (RLS: admin or finance). For anybody else the
 *     gate says "not visible to your role" rather than "no invoice", which
 *     would be a claim about money made by a role that cannot see money;
 *   · the tasks an applied request produced. `resulting_scope_version_id` →
 *     its `scope_items.feature_id` → `tasks.feature_id`. The chain the
 *     schema already holds, walked once;
 *   · where a quotation for the request is drafted. Quotations are drafted
 *     on the lead (`quotation-panel.tsx`), so the door is the lead behind
 *     the project's opportunity — `projects.opportunity_id` →
 *     `sales.opportunities.lead_id`.
 */

export type ProposalGate = {
  id: string;
  title: string;
  version: number;
  status: string;
  totalMinor: number;
  currency: string;
};

export type InvoiceLedger = {
  /** Null when the caller's role cannot read invoices. */
  visible: boolean;
  byStatus: { status: string; count: number; totalMinor: number }[];
};

export type LinkedTask = { id: string; title: string; status: string; featureName: string };

/** Plain records rather than Maps: this crosses into a client component. */
export type ChangeRequestContext = {
  proposals: Record<string, ProposalGate>;
  invoices: InvoiceLedger;
  /** Keyed by change request id. */
  tasksByRequest: Record<string, LinkedTask[]>;
  /** The lead page where a quotation for this project is drafted, if the project has an opportunity. */
  quoteLeadId: string | null;
};

export async function readChangeRequestContext(
  projectId: string,
  options: { includeInvoices: boolean },
): Promise<ChangeRequestContext> {
  const supabase = await createClient();

  const [requests, project] = await Promise.all([
    supabase
      .schema('projects')
      .from('change_requests')
      .select('id, proposal_id, resulting_scope_version_id')
      .eq('project_id', projectId),
    supabase.schema('projects').from('projects').select('opportunity_id').eq('id', projectId).maybeSingle(),
  ]);
  if (requests.error) unreadable('readChangeRequestContext.requests', requests.error);
  if (project.error) unreadable('readChangeRequestContext.project', project.error);

  const rows = requests.data ?? [];

  // ── proposals ──────────────────────────────────────────────────────────
  const proposalIds = [...new Set(rows.map((r) => r.proposal_id).filter((id): id is string => id !== null))];
  const proposals = new Map<string, ProposalGate>();
  if (proposalIds.length > 0) {
    const { data, error } = await supabase
      .schema('sales')
      .from('proposals')
      .select('id, title, version, status, total_minor, currency')
      .in('id', proposalIds);
    if (error) unreadable('readChangeRequestContext.proposals', error);
    for (const p of data ?? []) {
      proposals.set(p.id, { id: p.id, title: p.title, version: p.version, status: p.status, totalMinor: p.total_minor, currency: p.currency });
    }
  }

  // ── invoices ───────────────────────────────────────────────────────────
  let invoices: InvoiceLedger = { visible: false, byStatus: [] };
  if (options.includeInvoices) {
    const { data, error } = await supabase
      .schema('finance')
      .from('invoices')
      .select('status, total_minor')
      .eq('project_id', projectId);
    if (error) unreadable('readChangeRequestContext.invoices', error);
    const byStatus = new Map<string, { count: number; totalMinor: number }>();
    for (const inv of data ?? []) {
      const entry = byStatus.get(inv.status) ?? { count: 0, totalMinor: 0 };
      entry.count += 1;
      entry.totalMinor += inv.total_minor;
      byStatus.set(inv.status, entry);
    }
    invoices = { visible: true, byStatus: [...byStatus].map(([status, v]) => ({ status, ...v })) };
  }

  // ── tasks through the resulting scope version ──────────────────────────
  const tasksByRequest = new Map<string, LinkedTask[]>();
  const resultingIds = rows.map((r) => r.resulting_scope_version_id).filter((id): id is string => id !== null);
  if (resultingIds.length > 0) {
    const { data: items, error: itemsError } = await supabase
      .schema('projects')
      .from('scope_items')
      .select('scope_version_id, feature_id')
      .in('scope_version_id', resultingIds)
      .not('feature_id', 'is', null);
    if (itemsError) unreadable('readChangeRequestContext.scopeItems', itemsError);

    const featureIds = [...new Set((items ?? []).map((i) => i.feature_id).filter((id): id is string => id !== null))];
    if (featureIds.length > 0) {
      const [features, tasks] = await Promise.all([
        supabase.schema('projects').from('features').select('id, name').in('id', featureIds),
        supabase.schema('projects').from('tasks').select('id, title, status, feature_id').in('feature_id', featureIds).order('created_at', { ascending: true }),
      ]);
      if (features.error) unreadable('readChangeRequestContext.features', features.error);
      if (tasks.error) unreadable('readChangeRequestContext.tasks', tasks.error);

      const featureName = new Map((features.data ?? []).map((f) => [f.id, f.name]));
      const featuresByVersion = new Map<string, Set<string>>();
      for (const i of items ?? []) {
        if (!i.feature_id) continue;
        const set = featuresByVersion.get(i.scope_version_id) ?? new Set<string>();
        set.add(i.feature_id);
        featuresByVersion.set(i.scope_version_id, set);
      }
      for (const r of rows) {
        if (!r.resulting_scope_version_id) continue;
        const features = featuresByVersion.get(r.resulting_scope_version_id);
        if (!features) continue;
        tasksByRequest.set(
          r.id,
          (tasks.data ?? [])
            .filter((t) => t.feature_id !== null && features.has(t.feature_id))
            .map((t) => ({ id: t.id, title: t.title, status: t.status, featureName: featureName.get(t.feature_id ?? '') ?? '' })),
        );
      }
    }
  }

  // ── the quotation door ─────────────────────────────────────────────────
  let quoteLeadId: string | null = null;
  const opportunityId = project.data?.opportunity_id ?? null;
  if (opportunityId) {
    const { data, error } = await supabase.schema('sales').from('opportunities').select('lead_id').eq('id', opportunityId).maybeSingle();
    if (error) unreadable('readChangeRequestContext.opportunity', error);
    quoteLeadId = data?.lead_id ?? null;
  }

  return {
    proposals: Object.fromEntries(proposals),
    invoices,
    tasksByRequest: Object.fromEntries(tasksByRequest),
    quoteLeadId,
  };
}
