import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { InvoiceListItem } from './types';

/**
 * Reads the finance screens grew in gap pass 9 (SCR-050, 051, 053, 054).
 *
 * Kept beside `queries.ts` rather than inside it so the established readers
 * keep their signatures: `listInvoices(limit)` is called from six screens and
 * a filter argument on it would be six call sites changing for one. Every
 * read here refuses on failure (G-054) exactly as the readers next door do.
 */

export type InvoiceFilter = {
  /** Only invoices created in the last N days. */
  days?: number;
  clientId?: string;
  projectId?: string;
};

export type FilteredInvoice = InvoiceListItem & { client_account_id: string };

/** The invoice list with the overview's three filters applied at the database. */
export async function listInvoicesFiltered(filter: InvoiceFilter = {}, limit = 500): Promise<FilteredInvoice[]> {
  const supabase = await createClient();

  let query = supabase
    .schema('finance')
    .from('invoices')
    .select(
      'id, number, status, currency, total_minor, paid_minor, due_at, issued_at, project_id, milestone_id, client_account_id',
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  if (filter.days && Number.isFinite(filter.days) && filter.days > 0) {
    const since = new Date(Date.now() - filter.days * 86_400_000).toISOString();
    query = query.gte('created_at', since);
  }
  if (filter.clientId) query = query.eq('client_account_id', filter.clientId);
  if (filter.projectId) query = query.eq('project_id', filter.projectId);

  const { data, error } = await query;
  if (error) unreadable('listInvoicesFiltered', error);
  return data ?? [];
}

export type BillingClient = { id: string; name: string };

/**
 * The client accounts an invoice can be filtered by. A direct `core` read for
 * the reason `getClientAccountName` gives: core has no module of its own, and
 * PostgREST will not embed across schemas.
 */
export async function listBillingClients(): Promise<BillingClient[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('core')
    .from('client_accounts')
    .select('id, name')
    .order('name', { ascending: true })
    .limit(500);

  if (error) unreadable('listBillingClients', error);
  return data ?? [];
}

export type BillableMilestoneRow = {
  id: string;
  projectId: string;
  name: string;
  position: number;
  status: string;
  paymentPercent: number | null;
  amountMinor: number;
  currency: string;
};

/**
 * Every milestone across every project, for "create an invoice from an
 * eligible milestone" on `/invoices` (SCR-051). One read rather than one
 * `listPaymentPlan` per project; which of them is *eligible* is decided by
 * `milestoneInvoiceability` in schema.ts, the same rule the project page
 * applies, and never here.
 */
export async function listBillableMilestones(): Promise<BillableMilestoneRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('milestones')
    .select('id, project_id, name, position, status, payment_percent, amount_minor, currency')
    .order('position', { ascending: true })
    .limit(2000);

  if (error) unreadable('listBillableMilestones', error);

  return (data ?? []).map((m) => ({
    id: m.id,
    projectId: m.project_id,
    name: m.name,
    position: m.position,
    status: m.status,
    paymentPercent: m.payment_percent,
    amountMinor: m.amount_minor,
    currency: m.currency,
  }));
}

export type PaymentSubmissionRow = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  clientName: string | null;
  amountMinor: number;
  currency: string;
  method: string;
  reference: string | null;
  payerName: string | null;
  paidAt: string | null;
  proofUrl: string | null;
  status: string;
  submittedAt: string;
  verifiedAt: string | null;
  verifiedByName: string | null;
  verificationEvidence: string | null;
  rejectedReason: string | null;
  mismatchNote: string | null;
  paymentId: string | null;
};

const SUBMISSION_SELECT =
  'id, invoice_id, amount_minor, currency, method, reference, payer_name, paid_at, proof_url, status, submitted_at, verified_at, verified_by, verification_evidence, rejected_reason, mismatch_note, payment_id';

/**
 * Payment claims across every invoice — the queue's other half. `settled`
 * selects the claims that already have an answer (verified / rejected),
 * newest decision first — SCR-054's decision history; `all` is every claim,
 * for the payments screen's KPIs and drawer (SCR-053). The pending queue
 * itself stays `listPendingPaymentClaims` in queries.ts.
 */
export async function listPaymentSubmissions(
  scope: 'settled' | 'all',
  limit = 200,
): Promise<PaymentSubmissionRow[]> {
  const supabase = await createClient();

  const base = supabase.schema('finance').from('payment_submissions').select(SUBMISSION_SELECT).limit(limit);
  const query =
    scope === 'settled'
      ? base.in('status', ['verified', 'rejected']).order('verified_at', { ascending: false, nullsFirst: false })
      : base.order('submitted_at', { ascending: false });

  const { data: claims, error: claimsError } = await query;
  if (claimsError) unreadable('listPaymentSubmissions.claims', claimsError);
  const rows = claims ?? [];
  if (rows.length === 0) return [];

  const invoiceIds = [...new Set(rows.map((c) => c.invoice_id))];
  const { data: invoices, error: invoicesError } = await supabase
    .schema('finance')
    .from('invoices')
    .select('id, number, client_account_id')
    .in('id', invoiceIds);
  if (invoicesError) unreadable('listPaymentSubmissions.invoices', invoicesError);
  const invoiceById = new Map((invoices ?? []).map((i) => [i.id, i]));

  const clientIds = [...new Set((invoices ?? []).map((i) => i.client_account_id))];
  const verifierIds = [...new Set(rows.map((c) => c.verified_by).filter((id): id is string => id !== null))];

  const [{ data: clients, error: clientsError }, { data: users, error: usersError }] = await Promise.all([
    clientIds.length > 0
      ? supabase.schema('core').from('client_accounts').select('id, name').in('id', clientIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
    verifierIds.length > 0
      ? supabase.schema('core').from('users').select('id, full_name, email').in('id', verifierIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null; email: string }[], error: null }),
  ]);
  if (clientsError) unreadable('listPaymentSubmissions.clients', clientsError);
  if (usersError) unreadable('listPaymentSubmissions.users', usersError);

  const clientName = new Map((clients ?? []).map((c) => [c.id, c.name]));
  const userName = new Map((users ?? []).map((u) => [u.id, u.full_name ?? u.email]));

  return rows.map((c) => {
    const invoice = invoiceById.get(c.invoice_id);
    return {
      id: c.id,
      invoiceId: c.invoice_id,
      invoiceNumber: invoice?.number ?? '—',
      clientName: invoice ? (clientName.get(invoice.client_account_id) ?? null) : null,
      amountMinor: c.amount_minor,
      currency: c.currency,
      method: c.method,
      reference: c.reference,
      payerName: c.payer_name,
      paidAt: c.paid_at,
      proofUrl: c.proof_url,
      status: c.status,
      submittedAt: c.submitted_at,
      verifiedAt: c.verified_at,
      verifiedByName: c.verified_by ? (userName.get(c.verified_by) ?? c.verified_by.slice(0, 8)) : null,
      verificationEvidence: c.verification_evidence,
      rejectedReason: c.rejected_reason,
      mismatchNote: c.mismatch_note,
      paymentId: c.payment_id,
    };
  });
}
