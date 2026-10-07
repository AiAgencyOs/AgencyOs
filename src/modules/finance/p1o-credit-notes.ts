import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { asRows, firstRow, text, userRpc, whole } from '@/lib/db/p1o-rpc';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

/**
 * Credit notes: an issued invoice is corrected by a document the owner approved (migration 20261127300000, P2-FIN-038, P4-FIN-021).
 * A credit note does not edit the invoice, refund anything or file anything; it is the record of a reduction, with its tax portion shown for whoever files.
 * Requesting and issuing are people's acts: the service role is refused by the database, and issuing waits for the owner's approval.
 */

const SAY: Record<string, string> = {
  needs_a_person: 'A credit note is requested and issued by a person; an automation cannot.',
  forbidden: 'Only an administrator or a finance member of this organisation can do that.',
  not_found: 'That invoice or credit note no longer exists.',
  non_positive: 'The amount must be more than nothing.',
  bad_tax_portion: 'The tax portion cannot be negative or larger than the credit.',
  missing_reason: 'A reason is required (at least a few words): it is printed on the record.',
  not_an_issued_invoice: 'Only an issued invoice can be credited. A draft is simply not issued.',
  exceeds_invoice: 'That is more than the invoice still has room for (other credit notes, including pending ones, count).',
  no_policy: 'No approval policy names who decides a credit note. Set one before requesting.',
  policy_must_name_the_owner: 'The policy for credit notes must name the owner.',
  not_approved: 'The owner has not approved it yet.',
  invoice_no_longer_issued: 'The invoice is no longer issued.',
  not_issued: 'Issue the credit note before linking a replacement.',
  already_linked: 'A replacement is already linked.',
  unknown_invoice: 'That invoice does not belong to this organisation.',
  not_a_replacement: 'A replacement must be a different, non-void invoice for the same client.',
};

export type CreditNote = {
  id: string; invoiceId: string; invoiceNumber: string | null; number: string | null; amountMinor: number; taxMinor: number; reason: string;
  status: 'requested' | 'issued'; approvalRequestId: string | null; replacementInvoiceId: string | null; issuedAt: string | null; createdAt: string;
};

export async function listCreditNotes(): Promise<CreditNote[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('finance' as never)
    .from('p1o_credit_notes' as never)
    .select('id, invoice_id, number, amount_minor, tax_minor, reason, status, approval_request_id, replacement_invoice_id, issued_at, created_at, invoices:invoice_id(number)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) unreadable('listCreditNotes', error);
  return (asRows(data) as Array<Record<string, unknown>>).map((r) => {
    const inv = r.invoices as { number?: string } | Array<{ number?: string }> | null;
    return {
      id: String(r.id), invoiceId: String(r.invoice_id), invoiceNumber: Array.isArray(inv) ? (inv[0]?.number ?? null) : (inv?.number ?? null), number: text(r.number),
      amountMinor: whole(r.amount_minor), taxMinor: whole(r.tax_minor), reason: String(r.reason), status: r.status === 'issued' ? 'issued' : 'requested',
      approvalRequestId: text(r.approval_request_id), replacementInvoiceId: text(r.replacement_invoice_id), issuedAt: text(r.issued_at), createdAt: String(r.created_at),
    };
  });
}

export async function readInvoiceNet(invoiceId: string): Promise<{ invoicedMinor: number; creditedMinor: number; netMinor: number; pendingCreditMinor: number } | null> {
  const rpc = await userRpc('finance');
  const { data, error } = await rpc('p1o_invoice_net_after_credits', { p_invoice_id: invoiceId });
  if (error) unreadable('readInvoiceNet', error);
  const r = firstRow(data);
  return r ? { invoicedMinor: whole(r.invoiced_minor), creditedMinor: whole(r.credited_minor), netMinor: whole(r.net_minor), pendingCreditMinor: whole(r.pending_credit_minor) } : null;
}

async function gate(): Promise<Result<true>> {
  const context = await requireInternal();
  if (!can(context, 'invoice.issue')) return err('FORBIDDEN', 'Your role cannot raise or issue a credit note.');
  return ok(true);
}

export async function requestCreditNote(input: { invoiceId: string; amountMinor: number; taxMinor: number; reason: string }): Promise<Result<{ creditNoteId: string; remainingMinor: number }>> {
  const g = await gate();
  if (!g.ok) return g;
  const rpc = await userRpc('finance');
  const { data, error } = await rpc('p1o_request_credit_note', { p_invoice_id: input.invoiceId, p_amount_minor: input.amountMinor, p_tax_minor: input.taxMinor, p_reason: input.reason });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'requestCreditNote', detail: error.message }));
    return err('INTERNAL', 'Could not request the credit note.');
  }
  const r = firstRow(data);
  const outcome = String(r?.outcome ?? '');
  if (outcome === 'requested') return ok({ creditNoteId: String(r?.credit_note_id), remainingMinor: whole(r?.creditable_minor) });
  return err(outcome === 'forbidden' || outcome === 'needs_a_person' ? 'FORBIDDEN' : 'VALIDATION', SAY[outcome] ?? 'The database refused that.');
}

export async function issueCreditNote(creditNoteId: string): Promise<Result<{ number: string }>> {
  const g = await gate();
  if (!g.ok) return g;
  const rpc = await userRpc('finance');
  const { data, error } = await rpc('p1o_issue_credit_note', { p_credit_note_id: creditNoteId });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'issueCreditNote', detail: error.message }));
    return err('INTERNAL', 'Could not issue the credit note.');
  }
  const r = firstRow(data);
  const outcome = String(r?.outcome ?? '');
  if (outcome === 'issued' || outcome === 'already_issued') return ok({ number: String(r?.number) });
  return err(outcome === 'forbidden' || outcome === 'needs_a_person' ? 'FORBIDDEN' : 'VALIDATION', SAY[outcome] ?? 'The database refused that.');
}

export async function linkReplacementInvoice(creditNoteId: string, invoiceId: string): Promise<Result<string>> {
  const g = await gate();
  if (!g.ok) return g;
  const rpc = await userRpc('finance');
  const { data, error } = await rpc('p1o_link_replacement_invoice', { p_credit_note_id: creditNoteId, p_invoice_id: invoiceId });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'linkReplacementInvoice', detail: error.message }));
    return err('INTERNAL', 'Could not link the replacement.');
  }
  const outcome = String(firstRow(data)?.outcome ?? '');
  return outcome === 'linked' ? ok('Linked.') : err('VALIDATION', SAY[outcome] ?? 'The database refused that.');
}
