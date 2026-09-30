import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { changeRequestInvoiceLines, invoiceChangeRequestSchema, invoiceTotals, type InvoiceChangeRequestInput } from './change-request-invoice-schema';
import { taxRateBpForMode } from './gstin';
import { invoiceNumberPrefix, nextInvoiceNumber, parseInvoiceSequence } from './schema';
import { readBillingReadiness } from './service';

const NUMBER_ATTEMPTS = 5;

/**
 * Raise an invoice for a paid change request — SCR-031 "Trigger finance"
 * (migration 20261001120000).
 *
 * `invoice.create` (owner, ops_admin). The same discipline as
 * `generateInvoiceFromMilestone`: the billing mode and profile must be
 * complete BEFORE a number is issued (Finance §16), the lines and the
 * number are computed here where they are tested, and the write is one
 * statement — `finance.create_change_request_invoice`, which calls the
 * milestone door with no milestone, links the invoice to the request and
 * audits `change_request.invoiced`. The proposal on the request (ADM-22)
 * is the price; there is no other.
 */
export async function invoiceChangeRequest(input: InvoiceChangeRequestInput): Promise<Result<{ invoiceId: string; number: string; created: boolean }>> {
  const parsed = invoiceChangeRequestSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');

  const context = await requireInternal();
  if (!can(context, 'invoice.create')) return err('FORBIDDEN', 'You do not have permission to raise invoices.');

  const supabase = await createClient();

  const { data: cr, error: crError } = await supabase
    .schema('projects')
    .from('change_requests')
    .select('id, project_id, requested, classification, status, proposal_id, invoice_id')
    .eq('id', parsed.data.changeRequestId)
    .maybeSingle();
  if (crError) {
    console.error(JSON.stringify({ level: 'error', scope: 'invoiceChangeRequest.cr', detail: crError.message }));
    return err('INTERNAL', 'The change request could not be read.');
  }
  if (!cr) return err('NOT_FOUND', 'That change request is not visible to you.');
  if (cr.classification !== 'paid_change') return err('CONFLICT', 'Only a change classified as a paid change is invoiced. Classify it first.');
  if (!cr.proposal_id) return err('CONFLICT', 'A paid change is priced by a quotation (ADM-22), and none is attached yet. Name one when deciding the request.');

  const [{ data: proposal, error: proposalError }, { data: project, error: projectError }] = await Promise.all([
    supabase.schema('sales').from('proposals').select('id, title, version, status, total_minor, currency').eq('id', cr.proposal_id).maybeSingle(),
    supabase.schema('projects').from('projects').select('id, name, currency').eq('id', cr.project_id).maybeSingle(),
  ]);
  if (proposalError || projectError) {
    console.error(JSON.stringify({ level: 'error', scope: 'invoiceChangeRequest.reads', detail: proposalError?.message ?? projectError?.message }));
    return err('INTERNAL', 'The quotation or the project could not be read.');
  }
  if (!proposal) return err('NOT_FOUND', 'The quotation that prices this change is not visible to you.');
  if (!project) return err('NOT_FOUND', 'That project is not visible to you.');
  if (proposal.total_minor <= 0) return err('CONFLICT', 'The quotation prices this change at zero, so there is nothing to invoice.');
  if (proposal.currency !== project.currency) {
    return err('CONFLICT', `The quotation is in ${proposal.currency} and the project bills in ${project.currency}. Align them before invoicing.`);
  }

  const readiness = await readBillingReadiness(cr.project_id, supabase);
  if (!readiness.ok) return readiness;
  if (readiness.data.mode === null) return err('CONFLICT', 'Confirm whether this project is billed with GST or without it before raising an invoice.');
  if (!readiness.data.complete) {
    const missing = readiness.data.missing.join(', ');
    return err('CONFLICT', `The billing details are not complete yet${missing ? ` — missing: ${missing}` : ''}.`);
  }
  const taxRateBp = taxRateBpForMode(readiness.data.mode);
  if (taxRateBp === null) return err('INTERNAL', 'The billing mode could not be resolved into a tax rate.');

  const lines = changeRequestInvoiceLines(
    { requested: cr.requested, proposalTitle: proposal.title, proposalVersion: proposal.version, totalMinor: proposal.total_minor, projectName: project.name },
    taxRateBp,
  );
  const totals = invoiceTotals(lines);

  const year = new Date().getUTCFullYear();
  const { data: highestRow } = await supabase
    .schema('finance')
    .from('invoices')
    .select('number')
    .like('number', `${invoiceNumberPrefix(year)}%`)
    .order('number', { ascending: false })
    .limit(1)
    .maybeSingle();
  const highest = parseInvoiceSequence(highestRow?.number, year);

  const dueAt = parsed.data.dueInDays === undefined ? null : new Date(Date.now() + parsed.data.dueInDays * 86_400_000).toISOString();

  for (let attempt = 0; attempt < NUMBER_ATTEMPTS; attempt += 1) {
    const number = nextInvoiceNumber(year, highest, attempt);
    const { data, error } = await supabase.schema('finance').rpc('create_change_request_invoice', {
      p_change_request_id: cr.id,
      p_number: number,
      p_currency: project.currency,
      p_subtotal_minor: totals.subtotalMinor,
      p_tax_minor: totals.taxMinor,
      p_total_minor: totals.totalMinor,
      p_lines: lines.map((l) => ({
        position: l.position,
        description: l.description,
        quantity: l.quantity,
        unit_price_minor: l.unitPriceMinor,
        amount_minor: l.amountMinor,
        tax_rate_bp: l.taxRateBp,
      })),
      ...(readiness.data.profileId ? { p_billing_profile_id: readiness.data.profileId } : {}),
      ...(dueAt ? { p_due_at: dueAt } : {}),
      ...(parsed.data.notes ? { p_notes: parsed.data.notes } : {}),
    });
    if (error) {
      console.error(JSON.stringify({ level: 'error', scope: 'invoiceChangeRequest', detail: error.message }));
      return err('INTERNAL', 'Could not create the invoice.');
    }
    const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; invoice_id?: string | null; number?: string | null } | undefined;
    switch (row?.outcome ?? 'no answer') {
      case 'created':
        return ok({ invoiceId: row!.invoice_id!, number: row!.number!, created: true });
      case 'already_invoiced':
        return ok({ invoiceId: row!.invoice_id!, number: row!.number!, created: false });
      case 'number_taken':
        continue;
      case 'not_billable':
        return err('CONFLICT', 'Only a change classified as a paid change is invoiced.');
      case 'wrong_state':
        return err('CONFLICT', 'This request is not in a state that can be billed — it must be classified, awaiting a decision, or approved.');
      case 'no_proposal':
        return err('CONFLICT', 'A paid change is priced by a quotation (ADM-22), and none is attached yet.');
      case 'no_lines':
        return err('CONFLICT', 'The invoice produced no lines.');
      case 'not_found':
        return err('NOT_FOUND', 'That change request is not visible to you.');
      default:
        return err('FORBIDDEN', 'You do not have permission to raise this invoice.');
    }
  }
  return err('CONFLICT', 'Could not allocate an invoice number. Please try again.');
}
