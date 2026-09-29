import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The finance gate queue — SCR-001 "Finance gate queue" (bucket F, stream
 * F-A). The dashboard had a "Payments to verify" tile and nothing that said
 * WHICH milestones were holding a project: a milestone invoice that is
 * issued and unpaid blocks the phase behind it (Doc 15 §12 — the financial
 * gate). This reads exactly those invoices, with the milestone and project
 * they gate, so the card lists them beside the claims awaiting a decision
 * (`listPendingPaymentClaims`, read by the page from the finance module).
 *
 * Lives in `lib/admin` because the page composes it with a module read and
 * `lib/` may not import `modules/` (ARCHITECTURE.md §3.2). A failed read
 * refuses: "no gate" and "could not read the gate" are different sentences.
 */

/** Issued and not yet settled — the two statuses in which a milestone invoice holds its phase. */
const UNPAID = ['issued', 'overdue', 'partially_paid'];

export type UnpaidMilestoneInvoice = {
  invoiceId: string;
  number: string;
  status: string;
  currency: string;
  totalMinor: number;
  paidMinor: number;
  dueAt: string | null;
  projectId: string | null;
  projectName: string | null;
  milestoneName: string | null;
  milestonePosition: number | null;
};

export async function listUnpaidMilestoneInvoices(limit = 25): Promise<UnpaidMilestoneInvoice[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('finance')
    .from('invoices')
    .select('id, number, status, currency, total_minor, paid_minor, due_at, project_id, milestone_id')
    .not('milestone_id', 'is', null)
    .in('status', UNPAID)
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(limit);
  if (error) unreadable('listUnpaidMilestoneInvoices', error);

  const rows = data ?? [];
  const milestoneIds = [...new Set(rows.map((r) => r.milestone_id).filter((id): id is string => id !== null))];
  const projectIds = [...new Set(rows.map((r) => r.project_id).filter((id): id is string => id !== null))];

  const [{ data: milestones, error: mError }, { data: projects, error: pError }] = await Promise.all([
    milestoneIds.length > 0
      ? supabase.schema('projects').from('milestones').select('id, name, position').in('id', milestoneIds)
      : Promise.resolve({ data: [] as { id: string; name: string; position: number }[], error: null }),
    projectIds.length > 0
      ? supabase.schema('projects').from('projects').select('id, name').in('id', projectIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
  ]);
  if (mError) unreadable('listUnpaidMilestoneInvoices.milestones', mError);
  if (pError) unreadable('listUnpaidMilestoneInvoices.projects', pError);

  const milestoneById = new Map((milestones ?? []).map((m) => [m.id, m]));
  const projectById = new Map((projects ?? []).map((p) => [p.id, p.name]));

  return rows.map((r) => {
    const m = r.milestone_id ? milestoneById.get(r.milestone_id) : undefined;
    return {
      invoiceId: r.id,
      number: r.number,
      status: r.status,
      currency: r.currency,
      totalMinor: r.total_minor,
      paidMinor: r.paid_minor,
      dueAt: r.due_at,
      projectId: r.project_id,
      projectName: r.project_id ? (projectById.get(r.project_id) ?? null) : null,
      milestoneName: m?.name ?? null,
      milestonePosition: m?.position ?? null,
    };
  });
}
