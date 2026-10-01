import 'server-only';

import { z } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { PAYMENT_ACCOUNT_FIELDS, PAYMENT_ACCOUNT_KIND_LABEL, type PaymentAccountKind } from './schema';
import { listPaymentAccounts, readInvoiceBillingProfile } from './queries';
import { verifiedOn } from './verified-basis';

/**
 * The invoice as a document — SCR-051, mirroring `quotationPdfForProposal`.
 *
 * Gated on `invoice.read`, which is what the invoice page gates on: a
 * download is a read wearing a Content-Disposition header. Reads under RLS,
 * maps the same rows the invoice page shows (billing profile, GST line,
 * receiving accounts) into the renderer's input, and renders. A draft renders
 * — reviewing one before issuing is the point — with the band and watermark
 * the renderer draws for anything not issued.
 */
export async function invoicePdfForInvoice(
  invoiceId: string,
): Promise<Result<{ bytes: Uint8Array; filename: string }>> {
  const idCheck = z.string().uuid().safeParse(invoiceId);
  if (!idCheck.success) return err('VALIDATION', 'Not an invoice id.');

  const context = await requireInternal();
  if (!can(context, 'invoice.read')) {
    return err('FORBIDDEN', 'You do not have permission to read invoices.');
  }

  const supabase = await createClient();

  const { data: invoice, error } = await supabase
    .schema('finance')
    .from('invoices')
    .select(
      'id, number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, verified_minor, issued_at, due_at, paid_at, created_at, notes, client_account_id, project_id, milestone_id',
    )
    .eq('id', idCheck.data)
    .maybeSingle();

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'invoicePdfForInvoice', detail: error.message }));
    return err('INTERNAL', 'The invoice could not be read.');
  }
  if (!invoice) return err('NOT_FOUND', 'Invoice not found.');

  const { data: items, error: itemsError } = await supabase
    .schema('finance')
    .from('invoice_items')
    .select('description, quantity, unit_price_minor, amount_minor, tax_rate_bp')
    .eq('invoice_id', invoice.id)
    .order('position');

  if (itemsError) {
    console.error(JSON.stringify({ level: 'error', scope: 'invoicePdfForInvoice', detail: itemsError.message }));
    return err('INTERNAL', 'The invoice could not be read.');
  }

  try {
    // The letterhead. Throwing rather than defaulting: a document branded
    // "AgencyOS" is worse than no document.
    const { data: org, error: orgError } = await supabase
      .schema('core')
      .from('organizations')
      .select('name, timezone, settings')
      .limit(1)
      .maybeSingle();
    if (orgError || !org) throw new Error(`the organization could not be read: ${orgError?.message ?? 'no row'}`);

    const [{ data: clientRows }, billing, accounts, project, milestone] = await Promise.all([
      // The name only, so the finance role can print the PDF too (decision 7, 2026-10-01).
      supabase.schema('finance').rpc('client_names', { p_ids: [invoice.client_account_id] }),
      readInvoiceBillingProfile(invoice.project_id),
      listPaymentAccounts(),
      invoice.project_id
        ? supabase.schema('projects').from('projects').select('name').eq('id', invoice.project_id).maybeSingle()
        : Promise.resolve({ data: null }),
      invoice.milestone_id
        ? supabase.schema('projects').from('milestones').select('name, position').eq('id', invoice.milestone_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const { numberingFrom } = await import('./numbering');
    const { renderInvoicePdf, invoicePdfFilename } = await import('@/lib/pdf/invoice');
    const { quotationContactLine } = await import('@/lib/pdf/quotation');

    const rendered = await renderInvoicePdf({
      organizationName: org.name,
      contactLine: quotationContactLine(org.settings),
      number: invoice.number,
      status: invoice.status,
      currency: invoice.currency,
      billedTo: {
        clientName: clientRows?.[0]?.name ?? null,
        legalName: billing?.legalName ?? null,
        gstin: billing?.gstin ?? null,
        billingState: billing?.billingState ?? null,
        billingAddress: billing?.billingAddress ?? null,
        mode: billing?.mode ?? null,
        version: billing?.version ?? null,
      },
      projectName: project.data?.name ?? null,
      milestoneLabel: milestone.data ? `Milestone ${milestone.data.position + 1}: ${milestone.data.name}` : null,
      items: (items ?? []).map((i) => ({
        description: i.description,
        quantity: Number(i.quantity),
        unitPriceMinor: i.unit_price_minor,
        amountMinor: i.amount_minor,
        taxRateBp: i.tax_rate_bp,
      })),
      subtotalMinor: invoice.subtotal_minor,
      taxMinor: invoice.tax_minor,
      totalMinor: invoice.total_minor,
      // Owner decision 8 (2026-10-01): what the client is shown as paid is what has been VERIFIED, the one basis (verified-basis.ts).
      paidMinor: verifiedOn(invoice),
      issuedAt: invoice.issued_at,
      dueAt: invoice.due_at,
      paidAt: invoice.paid_at,
      createdAt: invoice.created_at,
      // The invoice's own notes, then the owner's terms note (Settings › Finance) — printed on every invoice.
      notes: [invoice.notes, numberingFrom(org.settings as Record<string, unknown> | null).termsNote].filter((t): t is string => Boolean(t)).join('\n\n') || null,
      // Exactly the accounts the invoice page's "Pay into" card shows.
      receivingAccounts: accounts
        .filter((a) => a.status === 'active')
        .map((a) => ({
          label: a.label,
          kindLabel: PAYMENT_ACCOUNT_KIND_LABEL[a.kind as PaymentAccountKind] ?? a.kind,
          fields: PAYMENT_ACCOUNT_FIELDS[a.kind as PaymentAccountKind]
            .filter((f) => a.instructions[f.key])
            .map((f) => ({ label: f.label, value: a.instructions[f.key]! })),
        })),
      timeZone: org.timezone ?? 'UTC',
      reference: invoice.id,
    });

    return ok({ bytes: rendered.bytes, filename: invoicePdfFilename(invoice.number, invoice.status) });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown render failure';
    console.error(JSON.stringify({ level: 'error', scope: 'invoicePdfForInvoice', detail }));
    return err('INTERNAL', 'The invoice document could not be rendered.');
  }
}
