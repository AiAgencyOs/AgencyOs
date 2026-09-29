import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-016 — the client's commercial timeline: accepted quotation → payment
 * milestones → invoices → payments, one dated feed across every project the
 * client has. Each entry is read from the module that owns it and dated by
 * that module's own column, never restated: a quotation by `decided_at`, a
 * milestone by `met_at` (or `due_on` while it is still ahead), an invoice by
 * `issued_at` (or `created_at` for a draft), a payment by `captured_at`.
 *
 * Nothing is invented for a stage that has not happened — a milestone with
 * no date is listed undated at the end rather than given one.
 */

export type CommercialEvent = {
  id: string;
  /** ISO instant or `YYYY-MM-DD`; null when the stage carries no date yet. */
  at: string | null;
  kind: 'quotation' | 'milestone' | 'invoice' | 'payment';
  title: string;
  detail: string | null;
  status: string;
  amountMinor: number | null;
  currency: string;
  projectId: string | null;
  projectName: string | null;
  href: string | null;
};

export async function readClientCommercialTimeline(input: {
  clientAccountId: string;
  projects: { id: string; name: string; proposalId: string | null }[];
}): Promise<CommercialEvent[]> {
  const supabase = await createClient();
  const projectIds = input.projects.map((p) => p.id);
  const projectNameById = new Map(input.projects.map((p) => [p.id, p.name]));
  const projectByProposal = new Map(
    input.projects.filter((p) => p.proposalId !== null).map((p) => [p.proposalId as string, p]),
  );
  const proposalIds = [...projectByProposal.keys()];

  const [proposals, milestones, invoices] = await Promise.all([
    proposalIds.length > 0
      ? supabase
          .schema('sales')
          .from('proposals')
          .select('id, title, version, status, total_minor, currency, decided_at, sent_at, created_at')
          .in('id', proposalIds)
      : Promise.resolve({ data: [], error: null }),
    projectIds.length > 0
      ? supabase
          .schema('projects')
          .from('milestones')
          .select('id, project_id, name, position, status, amount_minor, currency, due_on, met_at, payment_percent')
          .in('project_id', projectIds)
          .order('position', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    supabase
      .schema('finance')
      .from('invoices')
      .select('id, number, status, total_minor, paid_minor, currency, issued_at, created_at, due_at, project_id, milestone_id')
      .eq('client_account_id', input.clientAccountId),
  ]);
  if (proposals.error) unreadable('readClientCommercialTimeline.proposals', proposals.error);
  if (milestones.error) unreadable('readClientCommercialTimeline.milestones', milestones.error);
  if (invoices.error) unreadable('readClientCommercialTimeline.invoices', invoices.error);

  const invoiceRows = invoices.data ?? [];
  const invoiceIds = invoiceRows.map((i) => i.id);
  const payments =
    invoiceIds.length > 0
      ? await supabase
          .schema('finance')
          .from('payments')
          .select('id, invoice_id, amount_minor, currency, status, provider, captured_at, verified_at, created_at')
          .in('invoice_id', invoiceIds)
      : { data: [], error: null };
  if (payments.error) unreadable('readClientCommercialTimeline.payments', payments.error);

  const events: CommercialEvent[] = [];

  for (const p of proposals.data ?? []) {
    const project = projectByProposal.get(p.id);
    events.push({
      id: `proposal-${p.id}`,
      at: p.decided_at ?? p.sent_at ?? p.created_at,
      kind: 'quotation',
      title: `${p.title} (v${p.version})`,
      detail: p.status === 'accepted' ? 'Quotation accepted' : `Quotation ${p.status.replace(/_/g, ' ')}`,
      status: p.status,
      amountMinor: p.total_minor,
      currency: p.currency,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      href: '/quotations',
    });
  }

  const invoiceByMilestone = new Map(
    invoiceRows.filter((i) => i.milestone_id && i.status !== 'void').map((i) => [i.milestone_id as string, i]),
  );

  for (const m of milestones.data ?? []) {
    const billed = invoiceByMilestone.get(m.id);
    events.push({
      id: `milestone-${m.id}`,
      at: m.met_at ?? m.due_on,
      kind: 'milestone',
      title: m.name,
      detail:
        m.met_at
          ? 'Milestone met'
          : m.due_on
            ? `Milestone due · ${m.status.replace(/_/g, ' ')}`
            : `Milestone ${m.status.replace(/_/g, ' ')}`,
      status: billed ? `${m.status} · invoiced ${billed.number}` : m.status,
      amountMinor: m.payment_percent === null ? null : m.amount_minor,
      currency: m.currency,
      projectId: m.project_id,
      projectName: projectNameById.get(m.project_id) ?? null,
      href: `/projects/${m.project_id}`,
    });
  }

  const invoiceNumberById = new Map(invoiceRows.map((i) => [i.id, i.number]));
  for (const i of invoiceRows) {
    events.push({
      id: `invoice-${i.id}`,
      at: i.issued_at ?? i.created_at,
      kind: 'invoice',
      title: i.number,
      detail: i.issued_at ? 'Invoice issued' : 'Invoice drafted',
      status: i.status,
      amountMinor: i.total_minor,
      currency: i.currency,
      projectId: i.project_id,
      projectName: i.project_id ? (projectNameById.get(i.project_id) ?? null) : null,
      href: `/invoices/${i.id}`,
    });
  }

  for (const p of payments.data ?? []) {
    const invoiceId = p.invoice_id;
    const invoice = invoiceRows.find((i) => i.id === invoiceId);
    events.push({
      id: `payment-${p.id}`,
      at: p.captured_at ?? p.created_at,
      kind: 'payment',
      title: `Payment on ${invoiceNumberById.get(invoiceId) ?? 'invoice'}`,
      detail: p.verified_at ? `Verified · ${p.provider}` : `${p.status.replace(/_/g, ' ')} · ${p.provider}`,
      status: p.status,
      amountMinor: p.amount_minor,
      currency: p.currency,
      projectId: invoice?.project_id ?? null,
      projectName: invoice?.project_id ? (projectNameById.get(invoice.project_id) ?? null) : null,
      href: `/invoices/${invoiceId}`,
    });
  }

  // Newest first; undated stages sink to the end.
  events.sort((a, b) => {
    if (a.at === null && b.at === null) return 0;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return b.at.localeCompare(a.at);
  });

  return events;
}
