import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import {
  milestoneInvoiceability,
  nextUnlockedMilestone,
  type InvoiceStatus,
  type MilestoneBillingEntry,
} from './schema';

/**
 * Which milestone each project could be invoiced for next — the same rule the
 * project page applies (`nextUnlockedMilestone` over the live plan and its
 * non-void invoices), read once for many projects so the client page (SCR-016)
 * and the plan page (SCR-023) can offer "generate invoice" for exactly the
 * milestone the project page would, and never a different one.
 *
 * `eligible` is `milestoneInvoiceability`'s verdict on that milestone: the
 * button is rendered only when it is clear to bill, and the reason is shown
 * when it is not, so the page never offers a door the service will refuse.
 */

export type EligibleMilestone = {
  projectId: string;
  milestoneId: string;
  name: string;
  status: string;
  amountMinor: number;
  currency: string;
  paymentPercent: number | null;
  dueOn: string | null;
  eligible: boolean;
  reason: string | null;
};

export async function listEligibleMilestones(projectIds: string[]): Promise<EligibleMilestone[]> {
  if (projectIds.length === 0) return [];
  const supabase = await createClient();

  const [milestones, invoices] = await Promise.all([
    supabase
      .schema('projects')
      .from('milestones')
      .select('id, project_id, name, status, position, amount_minor, currency, payment_percent, due_on')
      .in('project_id', projectIds)
      .order('position', { ascending: true }),
    supabase
      .schema('finance')
      .from('invoices')
      .select('project_id, milestone_id, status')
      .in('project_id', projectIds),
  ]);
  if (milestones.error) unreadable('listEligibleMilestones.milestones', milestones.error);
  if (invoices.error) unreadable('listEligibleMilestones.invoices', invoices.error);

  const liveStatusByMilestone = new Map<string, InvoiceStatus>();
  for (const invoice of invoices.data ?? []) {
    if (invoice.status === 'void' || invoice.milestone_id === null) continue;
    liveStatusByMilestone.set(invoice.milestone_id, invoice.status as InvoiceStatus);
  }

  const byProject = new Map<string, NonNullable<typeof milestones.data>>();
  for (const m of milestones.data ?? []) {
    const list = byProject.get(m.project_id) ?? [];
    list.push(m);
    byProject.set(m.project_id, list);
  }

  const result: EligibleMilestone[] = [];
  for (const [projectId, rows] of byProject) {
    const entries: MilestoneBillingEntry[] = rows.map((m) => ({
      milestoneId: m.id,
      position: m.position,
      paymentPercent: m.payment_percent === null ? null : Number(m.payment_percent),
      invoiceStatus: liveStatusByMilestone.get(m.id) ?? null,
    }));
    const next = nextUnlockedMilestone(entries);
    if (!next) continue;
    const milestone = rows.find((m) => m.id === next.milestoneId);
    if (!milestone) continue;

    // Already invoiced (draft or issued) is not "eligible to generate": the
    // service would answer with the existing number, and offering the button
    // would promise a second bill that cannot exist.
    const alreadyBilled = liveStatusByMilestone.has(milestone.id);
    const verdict = milestoneInvoiceability({
      status: milestone.status,
      amountMinor: milestone.amount_minor,
      paymentPercent: next.paymentPercent,
    });

    result.push({
      projectId,
      milestoneId: milestone.id,
      name: milestone.name,
      status: milestone.status,
      amountMinor: milestone.amount_minor,
      currency: milestone.currency,
      paymentPercent: next.paymentPercent,
      dueOn: milestone.due_on,
      eligible: verdict.ok && !alreadyBilled,
      reason: alreadyBilled
        ? 'Already invoiced — the bill is awaiting payment.'
        : verdict.ok
          ? null
          : verdict.reason,
    });
  }

  return result;
}
