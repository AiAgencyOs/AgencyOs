import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { ProjectPayment } from './project-finance';

/**
 * Every payment against a project's invoices (newest first), with the invoice
 * number and, where a payment claim was settled by it, the method the payer
 * named. Also the tax the live invoices carry. RLS is the boundary.
 */
export async function readProjectPayments(projectId: string): Promise<{ payments: ProjectPayment[]; taxMinor: number }> {
  const supabase = await createClient();
  const invoices = await supabase.schema('finance').from('invoices').select('id, number, status, tax_minor').eq('project_id', projectId);
  if (invoices.error) unreadable('readProjectPayments.invoices', invoices.error);
  const rows = invoices.data ?? [];
  const taxMinor = rows.filter((i) => i.status !== 'void').reduce((n, i) => n + (i.tax_minor ?? 0), 0);
  if (rows.length === 0) return { payments: [], taxMinor };

  const ids = rows.map((i) => i.id);
  const numberOf = new Map(rows.map((i) => [i.id, i.number]));
  const [payments, claims] = await Promise.all([
    supabase.schema('finance').from('payments').select('id, invoice_id, amount_minor, currency, status, provider, captured_at, created_at').in('invoice_id', ids).order('created_at', { ascending: false }).limit(200),
    supabase.schema('finance').from('payment_submissions').select('payment_id, method').in('invoice_id', ids).not('payment_id', 'is', null),
  ]);
  if (payments.error) unreadable('readProjectPayments.payments', payments.error);
  if (claims.error) unreadable('readProjectPayments.claims', claims.error);
  const methodOf = new Map((claims.data ?? []).map((c) => [c.payment_id as string, c.method]));

  return {
    taxMinor,
    payments: (payments.data ?? []).map((p) => ({
      id: p.id,
      invoiceId: p.invoice_id,
      invoiceNumber: numberOf.get(p.invoice_id) ?? null,
      amountMinor: p.amount_minor,
      currency: p.currency,
      status: p.status,
      provider: p.provider,
      method: methodOf.get(p.id) ?? null,
      capturedAt: p.captured_at,
      createdAt: p.created_at,
    })),
  };
}
