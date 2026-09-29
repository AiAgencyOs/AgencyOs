import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-031 — each change request's OWN invoice (migration 20261001120000),
 * plus the project's group thread for "Send quotation". Invoice rows are
 * read only for a role RLS lets read them; otherwise `visible: false` so
 * the panel says so rather than showing "no invoice".
 */
export type ChangeRequestInvoice = {
  id: string;
  number: string;
  status: string;
  currency: string;
  totalMinor: number;
  paidMinor: number;
  dueAt: string | null;
};

export type ChangeRequestInvoices = {
  visible: boolean;
  /** Keyed by change request id. */
  byRequest: Record<string, ChangeRequestInvoice>;
  /** Keyed by change request id — the invoice id even when the row is not visible. */
  invoiceIdByRequest: Record<string, string>;
  /** The project's client WhatsApp group thread, for sending a quotation from the request. */
  clientThreadId: string | null;
};

export async function readChangeRequestInvoices(projectId: string, options: { includeInvoices: boolean }): Promise<ChangeRequestInvoices> {
  const supabase = await createClient();
  const [{ data: rows, error }, { data: thread, error: threadError }] = await Promise.all([
    supabase.schema('projects').from('change_requests').select('id, invoice_id').eq('project_id', projectId).not('invoice_id', 'is', null),
    supabase.schema('crm').from('conversations').select('id').eq('project_id', projectId).eq('kind', 'project_group').neq('status', 'abandoned').maybeSingle(),
  ]);
  if (error) unreadable('readChangeRequestInvoices.requests', error);
  if (threadError) unreadable('readChangeRequestInvoices.thread', threadError);

  const invoiceIdByRequest: Record<string, string> = {};
  for (const r of rows ?? []) if (r.invoice_id) invoiceIdByRequest[r.id] = r.invoice_id;

  const byRequest: Record<string, ChangeRequestInvoice> = {};
  const ids = Object.values(invoiceIdByRequest);
  if (options.includeInvoices && ids.length > 0) {
    const { data: invoices, error: invoicesError } = await supabase
      .schema('finance')
      .from('invoices')
      .select('id, number, status, currency, total_minor, paid_minor, due_at')
      .in('id', ids);
    if (invoicesError) unreadable('readChangeRequestInvoices.invoices', invoicesError);
    const byId = new Map((invoices ?? []).map((i) => [i.id, i]));
    for (const [requestId, invoiceId] of Object.entries(invoiceIdByRequest)) {
      const inv = byId.get(invoiceId);
      if (inv) byRequest[requestId] = { id: inv.id, number: inv.number, status: inv.status, currency: inv.currency, totalMinor: inv.total_minor, paidMinor: inv.paid_minor, dueAt: inv.due_at };
    }
  }

  return { visible: options.includeInvoices, byRequest, invoiceIdByRequest, clientThreadId: thread?.id ?? null };
}
