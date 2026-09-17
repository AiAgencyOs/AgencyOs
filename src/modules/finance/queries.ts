import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { toLadderProgress, type LadderProgress } from './ladder';

import type { InvoiceDetail, InvoiceItem, InvoiceListItem, InvoicePayment, InvoiceRefund} from './types';

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

  if (error) unreadable('listInvoices', error);

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

  if (error) unreadable('getInvoice', error);
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

  if (error) unreadable('getClientAccountName', error);
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

  if (error) unreadable('listInvoiceItems', error);
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
    .select('id, provider, provider_payment_id, amount_minor, currency, status, captured_at, verified_at')
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: true });

  if (error) unreadable('listInvoicePayments', error);
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

  if (error) unreadable('listProjectInvoices', error);
  return data ?? [];
}

/**
 * Refunds against one invoice — gap G-005.
 *
 * The approval state is joined in because it is the only thing that decides
 * whether the money may leave, and a refund row on its own cannot say. Newest
 * first: on this screen the thing somebody is looking for is what they just
 * asked for.
 */
export async function listRefunds(invoiceId: string): Promise<InvoiceRefund[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .from('refunds')
    .select('id, amount_minor, reason, status, provider_refund_id, recorded_at, created_at, approval_request_id')
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: false });

  if (error) unreadable('listRefunds', error);

  return data ?? [];
}

/**
 * What the business is actually holding for this invoice: captured payments
 * minus recorded refunds. The ceiling any further refund must fit inside, and
 * the number a form should show before somebody types one.
 */
export async function readNetReceived(invoiceId: string): Promise<number> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .rpc('net_received_minor', { p_invoice_id: invoiceId });

  if (error) unreadable('readNetReceived', error);

  return Number(data ?? 0);
}

/**
 * Where a project stands on Finance §12's ladder — G-268.
 *
 * A read, so it belongs here and a page may call it (ARCHITECTURE.md §3.2).
 * The derivation is **not** repeated: `readPaymentProgress` owns which
 * milestones count and how `phaseSevenGate` is applied, and a second copy of
 * that in a query is a second thing to keep honest.
 *
 * What changes at this boundary is only what a failed read becomes. The
 * service answers a `Result` because its callers can act on a failure; a
 * Server Component cannot, so G-054's rule applies and the read refuses.
 * **A project that could not be read must never render as a project at 0%.**
 */
export async function readPaymentLadder(projectId: string): Promise<LadderProgress> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('finance')
    .rpc('project_payment_progress', { p_project_id: projectId });

  if (error) unreadable('readPaymentLadder', error);

  return toLadderProgress((Array.isArray(data) ? data[0] : data) ?? {});
}

/**
 * Maintenance that was included with a project, and whether it has been
 * invoiced — Finance §9; G-269.
 *
 * Two reads rather than one join. `projects.maintenance_plans` and
 * `finance.invoices` are in different schemas and PostgREST will not resolve a
 * foreign key across schemas (PGRST200) — the same reason the invoice list
 * does not embed a client account name.
 *
 * Only `free_included` plans are returned. A paid plan is billed the ordinary
 * way and a plan nobody has classified is one somebody still has to look at;
 * offering either of them a ₹0 invoice button is offering to write off a bill.
 */
export type FreeMaintenanceCandidate = {
  planId: string;
  name: string;
  endsOn: string | null;
  invoiceNumber: string | null;
};

export async function listFreeMaintenance(projectId: string): Promise<FreeMaintenanceCandidate[]> {
  const supabase = await createClient();

  const { data: plans, error: planError } = await supabase
    .schema('projects')
    .from('maintenance_plans')
    .select('id, name, ends_on')
    .eq('project_id', projectId)
    .eq('entitlement', 'free_included')
    .order('created_at', { ascending: true });

  if (planError) unreadable('listFreeMaintenance.plans', planError);
  if ((plans ?? []).length === 0) return [];

  const { data: invoices, error: invoiceError } = await supabase
    .schema('finance')
    .from('invoices')
    .select('number, maintenance_plan_id, status')
    .in('maintenance_plan_id', (plans ?? []).map((plan) => plan.id));

  // A plan whose invoice could not be read is NOT a plan with no invoice: the
  // button would offer to raise a second zero-rupee document for one that
  // already exists.
  if (invoiceError) unreadable('listFreeMaintenance.invoices', invoiceError);

  const live = new Map(
    (invoices ?? [])
      // A voided invoice does not occupy the plan, the same rule the partial
      // unique index enforces.
      .filter((invoice) => invoice.status !== 'void')
      .map((invoice) => [invoice.maintenance_plan_id, invoice.number]),
  );

  return (plans ?? []).map((plan) => ({
    planId: plan.id,
    name: plan.name,
    endsOn: plan.ends_on,
    invoiceNumber: live.get(plan.id) ?? null,
  }));
}
