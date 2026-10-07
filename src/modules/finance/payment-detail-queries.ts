import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * One payment, with everything that backs or qualifies it — PDF SCR-053
 * "Payment detail · Proof/evidence · Invoice match · Reconciliation notes".
 * Every read refuses on failure (G-054): a payment whose claim could not be
 * read must not render as a payment with no evidence.
 */

export type PaymentDetail = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceStatus: string;
  invoiceTotalMinor: number;
  invoiceVerifiedMinor: number;
  projectId: string | null;
  clientName: string | null;
  provider: string;
  reference: string;
  amountMinor: number;
  currency: string;
  status: string;
  capturedAt: string | null;
  verifiedAt: string | null;
  verifiedByName: string | null;
  receipt: { id: string; number: string; issuedAt: string } | null;
  /** The claims that became or describe this payment: by `payment_id`, or by the same reference on the same invoice. */
  claims: {
    id: string;
    status: string;
    method: string;
    reference: string | null;
    payerName: string | null;
    proofUrl: string | null;
    proofFileName: string | null;
    submittedAt: string;
    verificationEvidence: string | null;
    rejectedReason: string | null;
    mismatchNote: string | null;
    evidenceRequestNote: string | null;
  }[];
  /** Reconciliation lines that point at this payment, and bank lines that agree with it. */
  reconciliation: { id: string; statementDate: string; statementLine: string; finding: string; reason: string | null }[];
  bankLines: { id: string; statementDate: string; description: string; reference: string | null; amountMinor: number; status: string }[];
};

export async function getPaymentDetail(paymentId: string): Promise<PaymentDetail | null> {
  const supabase = await createClient();

  const { data: p, error } = await supabase
    .schema('finance')
    .from('payments')
    .select('id, invoice_id, provider, provider_payment_id, amount_minor, currency, status, captured_at, verified_at, verified_by')
    .eq('id', paymentId)
    .maybeSingle();
  if (error) unreadable('getPaymentDetail.payment', error);
  if (!p) return null;

  const { data: invoice, error: invoiceError } = await supabase
    .schema('finance')
    .from('invoices')
    .select('number, status, total_minor, verified_minor, project_id, client_account_id')
    .eq('id', p.invoice_id)
    .maybeSingle();
  if (invoiceError) unreadable('getPaymentDetail.invoice', invoiceError);

  const [clientRes, verifierRes, receiptRes, claimsRes, itemsRes] = await Promise.all([
    invoice
      ? supabase.schema('finance').rpc('client_names', { p_ids: [invoice.client_account_id] })
      : Promise.resolve({ data: null, error: null }),
    p.verified_by
      ? supabase.schema('core').from('users').select('full_name, email').eq('id', p.verified_by).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    // `finance.receipts` postdates the generated types (see queries.ts listReceipts), hence the casts.
    supabase.schema('finance').from('receipts' as never).select('id, number, issued_at').eq('payment_id' as never, p.id).maybeSingle(),
    supabase
      .schema('finance')
      .from('payment_submissions')
      .select('id, status, method, reference, payer_name, proof_url, proof_file_name, submitted_at, verification_evidence, rejected_reason, mismatch_note, evidence_request_note, payment_id')
      .eq('invoice_id', p.invoice_id)
      .order('submitted_at', { ascending: false }),
    supabase
      .schema('finance')
      .from('reconciliation_items')
      .select('id, statement_date, statement_line, finding, reason')
      .eq('payment_id', p.id)
      .order('statement_date', { ascending: false }),
  ]);
  if (clientRes.error) unreadable('getPaymentDetail.client', clientRes.error);
  if (verifierRes.error) unreadable('getPaymentDetail.verifier', verifierRes.error);
  if (receiptRes.error) unreadable('getPaymentDetail.receipt', receiptRes.error);
  if (claimsRes.error) unreadable('getPaymentDetail.claims', claimsRes.error);
  if (itemsRes.error) unreadable('getPaymentDetail.reconciliation', itemsRes.error);

  const receipt = receiptRes.data as { id: string; number: string; issued_at: string } | null;
  const reference = p.provider_payment_id.includes(':') ? p.provider_payment_id.slice(p.provider_payment_id.indexOf(':') + 1) : p.provider_payment_id;
  const claims = (claimsRes.data ?? []).filter(
    (c) => c.payment_id === p.id || (c.reference !== null && c.reference.trim().toUpperCase() === reference.trim().toUpperCase()),
  );

  // Bank lines that agree on amount or reference — a reading, never a match.
  const { data: lines, error: linesError } = await supabase
    .schema('finance')
    .from('bank_statement_lines')
    .select('id, statement_date, description, reference, amount_minor, status')
    .or(`amount_minor.eq.${p.amount_minor},reference.eq.${reference.replace(/[,()]/g, ' ')}`)
    .order('statement_date', { ascending: false })
    .limit(10);
  if (linesError) unreadable('getPaymentDetail.bankLines', linesError);

  return {
    id: p.id,
    invoiceId: p.invoice_id,
    invoiceNumber: invoice?.number ?? '—',
    invoiceStatus: invoice?.status ?? 'unknown',
    invoiceTotalMinor: invoice?.total_minor ?? 0,
    invoiceVerifiedMinor: invoice?.verified_minor ?? 0,
    projectId: invoice?.project_id ?? null,
    clientName: clientRes.data?.[0]?.name ?? null,
    provider: p.provider,
    reference,
    amountMinor: p.amount_minor,
    currency: p.currency,
    status: p.status,
    capturedAt: p.captured_at,
    verifiedAt: p.verified_at,
    verifiedByName: verifierRes.data ? (verifierRes.data.full_name || verifierRes.data.email) : null,
    receipt: receipt ? { id: receipt.id, number: receipt.number, issuedAt: receipt.issued_at } : null,
    claims: claims.map((c) => ({
      id: c.id,
      status: c.status,
      method: c.method,
      reference: c.reference,
      payerName: c.payer_name,
      proofUrl: c.proof_url,
      proofFileName: c.proof_file_name,
      submittedAt: c.submitted_at,
      verificationEvidence: c.verification_evidence,
      rejectedReason: c.rejected_reason,
      mismatchNote: c.mismatch_note,
      evidenceRequestNote: c.evidence_request_note,
    })),
    reconciliation: (itemsRes.data ?? []).map((i) => ({ id: i.id, statementDate: i.statement_date, statementLine: i.statement_line, finding: i.finding, reason: i.reason })),
    bankLines: (lines ?? []).map((l) => ({ id: l.id, statementDate: l.statement_date, description: l.description, reference: l.reference, amountMinor: Number(l.amount_minor), status: l.status })),
  };
}
