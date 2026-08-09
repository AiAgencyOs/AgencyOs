import 'server-only';

import { createClient } from '@/lib/db/server';

import type { InvoiceDetail, InvoiceItem, InvoiceListItem, InvoicePayment } from './types';

/**
 * Reads for the finance module. Pure, RLS-scoped, safe in Server Components
 * (ARCHITECTURE.md §3.2). See the note in crm/queries.ts on why there is no
 * organization_id predicate here.
 *
 * The client account name is deliberately not embedded: client_accounts lives
 * in `core`, and PostgREST will not resolve a foreign key across schemas
 * (PGRST200). Joining it needs either a finance-side view or a second query,
 * and the list does not currently need the name enough to justify either.
 *
 * These reads are also what the client portal will use unchanged: the
 * invoices_select policy already hides drafts from client roles, so a portal
 * page calling listInvoices() sees issued invoices and nothing else without a
 * single extra predicate here.
 */

const LIST_SELECT =
  'id, number, status, currency, total_minor, paid_minor, due_at, issued_at, project_id, milestone_id';
const DETAIL_SELECT = `${LIST_SELECT}, client_account_id, subtotal_minor, tax_minor, paid_at, notes, created_at`;

export async function listInvoices(limit = 100): Promise<InvoiceListItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .from('invoices')
    .select(LIST_SELECT)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'listInvoices', detail: error.message }));
    return [];
  }

  return data ?? [];
}

export async function getInvoice(invoiceId: string): Promise<InvoiceDetail | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .from('invoices')
    .select(DETAIL_SELECT)
    .eq('id', invoiceId)
    .maybeSingle();

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'getInvoice', detail: error.message }));
    return null;
  }
  return data;
}

/**
 * The billed client's name.
 *
 * A second query rather than an embed, for the PGRST200 reason above, and a
 * direct read of a `core` table because core has no module of its own to own
 * it (ARCHITECTURE.md §2) — sales/service.ts already writes it directly for
 * the same reason. RLS scopes it to the organization either way.
 *
 * Worth the round trip here and not on the list: an invoice page that does not
 * say who is being billed is not an invoice page.
 */
export async function getClientAccountName(clientAccountId: string): Promise<string | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('core')
    .from('client_accounts')
    .select('name')
    .eq('id', clientAccountId)
    .maybeSingle();

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'getClientAccountName', detail: error.message }),
    );
    return null;
  }
  return data?.name ?? null;
}

export async function listInvoiceItems(invoiceId: string): Promise<InvoiceItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .from('invoice_items')
    .select('id, position, description, quantity, unit_price_minor, amount_minor, tax_rate_bp')
    .eq('invoice_id', invoiceId)
    .order('position', { ascending: true });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'listInvoiceItems', detail: error.message }),
    );
    return [];
  }
  return data ?? [];
}

/**
 * Payments recorded against an invoice — the audit trail behind `paid_minor`.
 *
 * Shown next to the invoice on purpose: "paid" as a status is a summary, and a
 * summary of money should always be one click from the receipts it summarises.
 */
export async function listInvoicePayments(invoiceId: string): Promise<InvoicePayment[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .from('payments')
    .select('id, provider, provider_payment_id, amount_minor, currency, status, captured_at')
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'listInvoicePayments', detail: error.message }),
    );
    return [];
  }
  return data ?? [];
}

/**
 * Every invoice raised against a project, for the milestone billing view.
 *
 * Returned as a flat list rather than a map keyed by milestone so the caller
 * decides how to index it; the project page pairs it with the payment plan it
 * has already loaded.
 */
export async function listProjectInvoices(projectId: string): Promise<InvoiceListItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .from('invoices')
    .select(LIST_SELECT)
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'listProjectInvoices', detail: error.message }),
    );
    return [];
  }
  return data ?? [];
}
