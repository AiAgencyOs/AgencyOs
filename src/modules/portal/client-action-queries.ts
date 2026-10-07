import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Two client-safe reads (Phase 7c): the things the agency asked the CLIENT to do, and the client's financial statement. Every read is a database function that
 * filters by the caller's own client account and exposes no internal column; nothing here widens it. A failed read is `unreadable`, never "nothing asked" or
 * "nothing owed". The statement states FACTS (what was invoiced, what a person verified as received, what is outstanding) and changes no amount.
 */

type Row = Record<string, unknown>;
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

async function projectsRpc(): Promise<Rpc> {
  const supabase = await createClient();
  return (fn, args) => (supabase.schema('projects') as unknown as { rpc: Rpc }).rpc(fn, args);
}

const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export type ClientActionRequest = { id: string; kind: string; title: string; instructions: string; dueAt: string; status: string; overdue: boolean; submittedAt: string | null; returnedNote: string | null; confirmedAt: string | null };

export async function readClientActionRequests(projectId: string): Promise<ClientActionRequest[]> {
  const rpc = await projectsRpc();
  const { data, error } = await rpc('client_action_requests_for_client', { p_project_id: projectId });
  if (error) unreadable('readClientActionRequests', error);
  return rows(data).map((r) => ({
    id: String(r.request_id),
    kind: String(r.kind),
    title: String(r.title),
    instructions: String(r.instructions),
    dueAt: String(r.due_at),
    status: String(r.status),
    overdue: r.overdue === true,
    submittedAt: str(r.submitted_at),
    returnedNote: str(r.returned_note),
    confirmedAt: str(r.confirmed_at),
  }));
}

export type StatementInvoice = {
  invoiceId: string;
  number: string;
  projectName: string | null;
  status: string;
  currency: string;
  totalMinor: number;
  verifiedMinor: number;
  recordedUnverifiedMinor: number;
  outstandingMinor: number;
  issuedAt: string | null;
  dueAt: string | null;
  overdue: boolean;
};
export type StatementPayment = { paymentId: string; invoiceNumber: string; amountMinor: number; currency: string; verifiedAt: string; receiptNumber: string | null };
export type StatementTotals = { currency: string; invoicedMinor: number; verifiedMinor: number; outstandingMinor: number };

export async function readClientStatement(projectId: string | null): Promise<{ invoices: StatementInvoice[]; payments: StatementPayment[]; totals: StatementTotals[] }> {
  const rpc = await projectsRpc();
  const args = { p_project_id: projectId };
  const invoices = await rpc('client_financial_statement', args);
  if (invoices.error) unreadable('readClientStatement.invoices', invoices.error);
  const payments = await rpc('client_financial_statement_payments', args);
  if (payments.error) unreadable('readClientStatement.payments', payments.error);
  const totals = await rpc('client_financial_statement_totals', args);
  if (totals.error) unreadable('readClientStatement.totals', totals.error);
  return {
    invoices: rows(invoices.data).map((r) => ({
      invoiceId: String(r.invoice_id),
      number: String(r.number),
      projectName: str(r.project_name),
      status: String(r.status),
      currency: String(r.currency),
      totalMinor: Number(r.total_minor),
      verifiedMinor: Number(r.verified_minor),
      recordedUnverifiedMinor: Number(r.recorded_unverified_minor),
      outstandingMinor: Number(r.outstanding_minor),
      issuedAt: str(r.issued_at),
      dueAt: str(r.due_at),
      overdue: r.overdue === true,
    })),
    payments: rows(payments.data).map((r) => ({
      paymentId: String(r.payment_id),
      invoiceNumber: String(r.invoice_number),
      amountMinor: Number(r.amount_minor),
      currency: String(r.currency),
      verifiedAt: String(r.verified_at),
      receiptNumber: str(r.receipt_number),
    })),
    totals: rows(totals.data).map((r) => ({ currency: String(r.currency), invoicedMinor: Number(r.invoiced_minor), verifiedMinor: Number(r.verified_minor), outstandingMinor: Number(r.outstanding_minor) })),
  };
}
