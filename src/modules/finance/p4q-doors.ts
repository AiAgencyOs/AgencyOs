import type { createAdminClient } from '@/lib/db/admin';
import { looseSchema } from '@/lib/p13/loose-client';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * W-F1 / W-F2: the two finance doors that stop Finance from guessing.
 *
 *   bindCommercialBaseline        `finance.p4q_bind_commercial_baseline`: each milestone of a project records the active scope version and the budget it was
 *                                 priced against, so a later invoice can be told apart from a stale one. With no active scope or no budget it never invents a
 *                                 baseline: it opens a billing clarification for a person.
 *   openBillingClarification      `finance.p4q_open_billing_clarification`: billing data missing or unclear (no confirmed mode, no GSTIN, no address) becomes
 *                                 one open finance exception naming what is missing, instead of only a failed job nobody reads.
 *
 * Both are idempotent in the database and best effort here: the caller's own result (a started phase, a refused invoice) is unchanged, and a door that cannot
 * be reached is logged at error level.
 */
async function call(admin: Admin, fn: string, args: Record<string, unknown>, scope: string): Promise<string> {
  try {
    const { data, error } = await looseSchema(admin as never, 'finance').rpc(fn, args);
    if (error) {
      console.error(JSON.stringify({ level: 'error', scope, detail: error.message }));
      return 'unavailable';
    }
    const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | null | undefined;
    return row?.outcome ?? 'no answer';
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope, detail: e instanceof Error ? e.message : 'unknown' }));
    return 'unavailable';
  }
}

export const bindCommercialBaseline = (admin: Admin, projectId: string): Promise<string> =>
  call(admin, 'p4q_bind_commercial_baseline', { p_project_id: projectId }, 'p4q.finance.baseline');

export function openBillingClarification(admin: Admin, projectId: string, readiness: { missing: readonly string[]; invalid: readonly { field: string }[] }): Promise<string> {
  const missing = [...new Set([...readiness.missing, ...readiness.invalid.map((i) => i.field)])];
  return call(admin, 'p4q_open_billing_clarification', { p_project_id: projectId, p_missing: missing.length > 0 ? missing : ['billing_profile'] }, 'p4q.finance.clarification');
}

/**
 * W-F5 (P4-FIN-042/057): the client was told, on WhatsApp, that a payment is verified. Each receipt of that invoice gets a delivery record of its own
 * (`finance.p4q_record_receipt_delivery`), apart from the payment, with the evidence that something really went out (the message id, or the fact that the
 * acknowledgement had already been sent). The message is the acknowledgement text; the receipt document itself is read from the portal, and the evidence says
 * which of the two this record is, so it never claims a document was delivered that was not.
 */
export async function recordReceiptAcknowledgements(
  admin: Admin,
  input: { organizationId: string; invoiceId: string; messageId: string | null },
): Promise<{ recorded: number; failed: number }> {
  const finance = looseSchema(admin as never, 'finance');
  const { data, error } = await finance.from('receipts').select('id').eq('invoice_id', input.invoiceId).eq('organization_id', input.organizationId);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'p4q.finance.receipts', detail: error.message }));
    return { recorded: 0, failed: 1 };
  }
  const evidence = input.messageId
    ? `payment acknowledgement message ${input.messageId} (text notice; the receipt document is in the portal)`
    : 'payment acknowledgement already sent on this thread (text notice; the receipt document is in the portal)';
  let recorded = 0;
  let failed = 0;
  for (const receipt of Array.isArray(data) ? (data as Array<{ id: string }>) : []) {
    const outcome = await call(admin, 'p4q_record_receipt_delivery', { p_receipt_id: receipt.id, p_channel: 'whatsapp', p_state: 'sent', p_evidence: evidence }, 'p4q.finance.receipt_delivery');
    if (outcome === 'recorded' || outcome === 'unchanged') recorded += 1;
    else failed += 1;
  }
  return { recorded, failed };
}
