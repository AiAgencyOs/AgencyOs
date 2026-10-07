import { looseSchema } from '@/lib/p13/loose-client';

/**
 * W-F3 (P4-FIN-020/079): which receiving accounts an invoice document shows.
 *
 * When an invoice is issued the database keeps a snapshot of the accounts that were active (`finance.p4q_payment_instruction_snapshots`). The PDF, the WhatsApp
 * message and the invoice page used to print whatever is active NOW, so an account added after issue appeared on an invoice that never named it. The rule here:
 *
 *   - the accounts printed are the snapshot's accounts that are STILL active, with their CURRENT details (the snapshot itself is masked, and a client must be sent
 *     to a working account, never to a closed one);
 *   - if none of the snapshot's accounts is active any more, or the invoice has no snapshot (a draft, an invoice issued before the snapshot existed, or a reader
 *     the snapshot's row security does not admit), the active accounts are shown exactly as before.
 *
 * What changed since issue is shown to staff beside it (`readInvoicePaymentSnapshot`), not hidden.
 */
export function accountsOnInvoice<T extends { id: string; status: string }>(accounts: readonly T[], snapshotAccountIds: readonly string[] | null): T[] {
  const active = accounts.filter((a) => a.status === 'active');
  if (!snapshotAccountIds || snapshotAccountIds.length === 0) return active;
  const onInvoice = active.filter((a) => snapshotAccountIds.includes(a.id));
  return onInvoice.length > 0 ? onInvoice : active;
}

/** The ids of the accounts an invoice was issued with, or null when there is no snapshot to read (or it could not be read: the documents then print as before). */
export async function readSnapshotAccountIds(client: unknown, invoiceId: string): Promise<string[] | null> {
  try {
    const { data, error } = await looseSchema(client as never, 'finance').from('p4q_payment_instruction_snapshots').select('accounts').eq('invoice_id', invoiceId).maybeSingle();
    if (error) {
      console.error(JSON.stringify({ level: 'error', scope: 'p4q.snapshotAccounts', invoice: invoiceId, detail: error.message }));
      return null;
    }
    const accounts = (data as { accounts?: unknown } | null)?.accounts;
    if (!Array.isArray(accounts)) return null;
    return accounts.map((a) => (a as { accountId?: unknown })?.accountId).filter((id): id is string => typeof id === 'string');
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'p4q.snapshotAccounts', invoice: invoiceId, detail: e instanceof Error ? e.message : 'unknown' }));
    return null;
  }
}
