import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { toLadderProgress, type LadderProgress } from './ladder';
import { readBillingReadiness } from './service';

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
 * The claims against a project's invoices — Doc 15 §11, §12; G-272.
 *
 * One query for the whole project rather than one per invoice: the thing a
 * person is looking at is *"what has anybody said they paid, and what is still
 * unchecked"*, and that question does not stop at an invoice boundary.
 *
 * **Newest first, and unanswered first within that.** A queue of claims is
 * read to find the ones that still need somebody, and a settled one is there
 * for the record.
 */
export type PaymentClaim = {
  id: string;
  invoice_id: string;
  amount_minor: number;
  currency: string;
  method: string;
  reference: string | null;
  payer_name: string | null;
  paid_at: string | null;
  proof_url: string | null;
  status: string;
  submitted_at: string;
  verified_at: string | null;
  verification_evidence: string | null;
  rejected_reason: string | null;
  mismatch_note: string | null;
  payment_id: string | null;
};

export async function listPaymentClaims(projectId: string): Promise<PaymentClaim[]> {
  const supabase = await createClient();

  const { data: invoiceRows, error: invoiceError } = await supabase
    .schema('finance')
    .from('invoices')
    .select('id')
    .eq('project_id', projectId);

  // G-054 on the first half too: an unreadable invoice list would make the
  // claim list empty, and an empty claim queue is the screen saying "nothing
  // needs checking" — the most expensive false sentence this page can print.
  //
  // Named `invoiceError` rather than destructured twice, because the
  // read-failure meta-check counts guards against refusals and a second
  // `error` in one function would shadow the first.
  if (invoiceError) unreadable('listPaymentClaims.invoices', invoiceError);

  const ids = (invoiceRows ?? []).map((row) => row.id);
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .schema('finance')
    .from('payment_submissions')
    .select(
      'id, invoice_id, amount_minor, currency, method, reference, payer_name, paid_at, proof_url, status, submitted_at, verified_at, verification_evidence, rejected_reason, mismatch_note, payment_id',
    )
    .in('invoice_id', ids)
    .order('submitted_at', { ascending: false });

  if (error) unreadable('listPaymentClaims', error);
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
export type PendingPaymentClaim = PaymentClaim & {
  invoiceNumber: string;
  invoiceCurrency: string;
  projectId: string | null;
  projectName: string | null;
  clientAccountId: string;
  clientName: string | null;
};

/**
 * Every claim still awaiting a decision, across every project — SCR-054's
 * screen. `listPaymentClaims` above is scoped to one project's billing panel;
 * this is the org-wide financial gate queue Doc 15 §12 describes: an owner
 * should not have to open every project to find the claims nobody has
 * answered yet. `mismatch` stays in the queue deliberately — §6 calls it
 * "requires resolution", not settled.
 */
export async function listPendingPaymentClaims(limit = 200): Promise<PendingPaymentClaim[]> {
  const supabase = await createClient();

  const { data: claims, error: claimsError } = await supabase
    .schema('finance')
    .from('payment_submissions')
    .select(
      'id, invoice_id, amount_minor, currency, method, reference, payer_name, paid_at, proof_url, status, submitted_at, verified_at, verification_evidence, rejected_reason, mismatch_note, payment_id',
    )
    .in('status', ['pending_verification', 'mismatch'])
    .order('submitted_at', { ascending: true })
    .limit(limit);
  if (claimsError) unreadable('listPendingPaymentClaims.claims', claimsError);

  const claimRows = claims ?? [];
  if (claimRows.length === 0) return [];

  const invoiceIds = [...new Set(claimRows.map((c) => c.invoice_id))];
  const { data: invoices, error: invoicesError } = await supabase
    .schema('finance')
    .from('invoices')
    .select('id, number, currency, project_id, client_account_id')
    .in('id', invoiceIds);
  if (invoicesError) unreadable('listPendingPaymentClaims.invoices', invoicesError);
  const invoiceRows = invoices ?? [];

  const projectIds = [...new Set(invoiceRows.map((i) => i.project_id).filter((id): id is string => id !== null))];
  const clientIds = [...new Set(invoiceRows.map((i) => i.client_account_id))];

  const [{ data: projects, error: projectsError }, { data: clients, error: clientsError }] = await Promise.all([
    projectIds.length > 0
      ? supabase.schema('projects').from('projects').select('id, name').in('id', projectIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
    supabase.schema('core').from('client_accounts').select('id, name').in('id', clientIds),
  ]);
  if (projectsError) unreadable('listPendingPaymentClaims.projects', projectsError);
  if (clientsError) unreadable('listPendingPaymentClaims.clients', clientsError);

  const invoiceById = new Map(invoiceRows.map((i) => [i.id, i]));
  const projectNameById = new Map((projects ?? []).map((p) => [p.id, p.name]));
  const clientNameById = new Map((clients ?? []).map((c) => [c.id, c.name]));

  return claimRows.map((c) => {
    const invoice = invoiceById.get(c.invoice_id);
    return {
      ...c,
      invoiceNumber: invoice?.number ?? '—',
      invoiceCurrency: invoice?.currency ?? c.currency,
      projectId: invoice?.project_id ?? null,
      projectName: invoice?.project_id ? (projectNameById.get(invoice.project_id) ?? null) : null,
      clientAccountId: invoice?.client_account_id ?? '',
      clientName: invoice?.client_account_id ? (clientNameById.get(invoice.client_account_id) ?? null) : null,
    };
  });
}

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

/**
 * A project's billing profile and what is still missing — Finance §4.1–§4.3,
 * §16; G-275.
 *
 * A read, so a page may call it, and it goes through `readBillingReadiness`
 * rather than re-deriving anything: §16's *"request only missing fields"* and
 * §4.3's *"do not add GST merely because the agency has GST configuration"*
 * both live in `gstin.ts`, and a second copy here is a second thing to keep
 * honest.
 *
 * A failed read refuses. **"No billing mode confirmed" is the state that
 * blocks every invoice on the project** (G-259), so answering it for a read
 * that did not happen would tell somebody to confirm a mode they had already
 * confirmed.
 */
export type ProjectBilling = {
  mode: 'gst' | 'non_gst' | null;
  version: number | null;
  complete: boolean;
  missing: readonly string[];
  invalid: readonly { field: string; reason: string }[];
};

export async function readProjectBilling(projectId: string): Promise<ProjectBilling> {
  const supabase = await createClient();

  const readiness = await readBillingReadiness(projectId, supabase);

  // Flattened to the `{ value, error }` shape every other reader in this file
  // uses, so the one refusal below is guarded exactly once — the meta-test
  // counts guards against refusals, and a compound condition reads as neither.
  const { profile, error: billingError } = readiness.ok
    ? { profile: readiness.data, error: null }
    : { profile: null, error: { message: readiness.error.code } };

  if (billingError) unreadable('readProjectBilling', billingError);

  return {
    mode: profile?.mode ?? null,
    version: profile?.version ?? null,
    complete: profile?.complete ?? false,
    missing: profile?.missing ?? [],
    invalid: profile?.invalid ?? [],
  };
}

export type ExpenseRow = {
  id: string;
  projectId: string | null;
  category: string;
  vendor: string | null;
  description: string;
  currency: string;
  amountMinor: number;
  incurredOn: string;
  createdAt: string;
};

/**
 * Every recorded expense, most recent first — SCR-055. RLS already refuses
 * anyone but owner, ops_admin or the finance role (finance.expenses_select),
 * so this reader adds no scoping of its own; it exists only to shape the
 * row for the screen.
 */
export async function listExpenses(limit = 500): Promise<ExpenseRow[]> {
  const supabase = await createClient();

  const { data, error: expensesError } = await supabase
    .schema('finance')
    .from('expenses')
    .select('id, project_id, category, vendor, description, currency, amount_minor, incurred_on, created_at')
    .order('incurred_on', { ascending: false })
    .limit(limit);

  if (expensesError) unreadable('listExpenses', expensesError);

  return (data ?? []).map((e) => ({
    id: e.id,
    projectId: e.project_id,
    category: e.category,
    vendor: e.vendor,
    description: e.description,
    currency: e.currency,
    amountMinor: e.amount_minor,
    incurredOn: e.incurred_on,
    createdAt: e.created_at,
  }));
}

export type TaxInvoiceRow = {
  id: string;
  number: string;
  status: string;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  issuedAt: string | null;
};

/**
 * The invoice register with tax figures — SCR-056. Reports what was
 * already recorded at invoice creation (finance.invoices.tax_minor, set by
 * issueInvoice/generateMilestoneInvoice from the project's confirmed
 * billing mode — src/modules/finance/gstin.ts); this reader computes
 * nothing itself. Draft and void invoices are excluded: neither is money
 * that moved or was promised to the tax authority.
 */
export async function listTaxInvoices(limit = 500): Promise<TaxInvoiceRow[]> {
  const supabase = await createClient();

  const { data, error: invoicesError } = await supabase
    .schema('finance')
    .from('invoices')
    .select('id, number, status, currency, subtotal_minor, tax_minor, total_minor, issued_at')
    .not('status', 'in', '("draft","void")')
    .order('issued_at', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (invoicesError) unreadable('listTaxInvoices', invoicesError);

  return (data ?? []).map((i) => ({
    id: i.id,
    number: i.number,
    status: i.status,
    currency: i.currency,
    subtotalMinor: i.subtotal_minor,
    taxMinor: i.tax_minor,
    totalMinor: i.total_minor,
    issuedAt: i.issued_at,
  }));
}
