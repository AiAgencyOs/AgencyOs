import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { GstIdentity, GstrInvoice, GstrLine } from './gstr';

/**
 * Reads for the GSTR-1 / GSTR-3B exports — bucket E5. Every read refuses on
 * failure (G-054). `listGstrInvoices` is `listTaxReportInvoices` widened by
 * exactly what the return shapes need and nothing else: the recipient's
 * place-of-supply code, the free text it came from, the lines with their
 * rate, and void invoices (for the document-issue count only).
 */

/** The agency's own GST identity, from the three columns on its organization. */
export async function readGstIdentity(): Promise<GstIdentity> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('core')
    .from('organizations')
    .select('name, gstin, gst_state_code, default_sac')
    .limit(1)
    .maybeSingle();
  if (error) unreadable('readGstIdentity', error);
  return {
    gstin: data?.gstin ?? null,
    stateCode: data?.gst_state_code ?? null,
    defaultSac: data?.default_sac ?? null,
    legalName: data?.name ?? '',
  };
}

/**
 * Every non-draft invoice with what a return needs. Voids are included and
 * carry status 'void' so gstr.ts can count them as cancelled documents; the
 * page's own register (listTaxReportInvoices) still excludes them.
 */
export async function listGstrInvoices(limit = 2000): Promise<GstrInvoice[]> {
  const supabase = await createClient();

  const { data, error: invoicesError } = await supabase
    .schema('finance')
    .from('invoices')
    .select('id, number, status, currency, subtotal_minor, tax_minor, total_minor, issued_at, project_id')
    .neq('status', 'draft')
    .order('issued_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (invoicesError) unreadable('listGstrInvoices', invoicesError);

  const rows = data ?? [];
  const invoiceIds = rows.map((r) => r.id);
  const projectIds = [...new Set(rows.map((r) => r.project_id).filter((id): id is string => id !== null))];

  const profileByProject = new Map<string, { mode: 'gst' | 'non_gst'; gstin: string | null; stateCode: string | null; state: string | null }>();
  if (projectIds.length > 0) {
    const { data: profiles, error: profilesError } = await supabase
      .schema('finance')
      .from('billing_profiles')
      .select('project_id, mode, gstin, billing_state, billing_state_code')
      .in('project_id', projectIds)
      .eq('status', 'active');
    if (profilesError) unreadable('listGstrInvoices.profiles', profilesError);
    for (const p of profiles ?? []) {
      profileByProject.set(p.project_id, { mode: p.mode === 'gst' ? 'gst' : 'non_gst', gstin: p.gstin, stateCode: p.billing_state_code, state: p.billing_state });
    }
  }

  const linesByInvoice = new Map<string, GstrLine[]>();
  if (invoiceIds.length > 0) {
    const { data: items, error: itemsError } = await supabase
      .schema('finance')
      .from('invoice_items')
      .select('invoice_id, description, amount_minor, tax_rate_bp, position')
      .in('invoice_id', invoiceIds)
      .order('position', { ascending: true });
    if (itemsError) unreadable('listGstrInvoices.items', itemsError);
    for (const it of items ?? []) {
      const list = linesByInvoice.get(it.invoice_id) ?? [];
      list.push({ description: it.description, amountMinor: it.amount_minor, taxRateBp: it.tax_rate_bp });
      linesByInvoice.set(it.invoice_id, list);
    }
  }

  return rows.map((i) => {
    const profile = i.project_id ? profileByProject.get(i.project_id) : undefined;
    return {
      id: i.id,
      number: i.number,
      status: i.status,
      currency: i.currency,
      subtotalMinor: i.subtotal_minor,
      taxMinor: i.tax_minor,
      totalMinor: i.total_minor,
      issuedAt: i.issued_at,
      projectId: i.project_id,
      billingMode: profile?.mode ?? null,
      gstin: profile?.gstin ?? null,
      recipientStateCode: profile?.stateCode ?? null,
      billingState: profile?.state ?? null,
      lines: linesByInvoice.get(i.id) ?? [],
    };
  });
}
