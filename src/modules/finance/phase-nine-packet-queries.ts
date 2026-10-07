import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { listRecentBankLines } from './bank-import-queries';
import { crossCheckClaim } from './claim-queue';
import { buildVerificationPacket, type PacketAccountCheck, type PacketException, type VerificationPacket } from './phase-nine-verification-packet';

/**
 * The reads behind the verification packet (read only). Every read refuses on failure (G-054): a claim whose exceptions or account check could not be
 * read must not render as a claim with none. Nothing here writes, verifies, rejects or sends.
 */

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);

/** The packet for one payment submission, or null when it is not visible to the caller (another organization, or a role that reads no finance). */
export async function readVerificationPacket(submissionId: string): Promise<VerificationPacket | null> {
  const supabase = await createClient();

  const sub = await supabase
    .schema('finance')
    .from('payment_submissions')
    .select('id, invoice_id, account_id, status, amount_minor, currency, method, reference, payer_name, paid_at, submitted_at, proof_url, proof_file_name, proof_storage_path')
    .eq('id', submissionId)
    .maybeSingle();
  if (sub.error) unreadable('readVerificationPacket.submission', sub.error);
  if (!sub.data) return null;
  const s = sub.data as Row;

  const invoice = await supabase
    .schema('finance')
    .from('invoices')
    .select('number, status, currency, total_minor, verified_minor, due_at, project_id, client_account_id')
    .eq('id', String(s.invoice_id))
    .maybeSingle();
  if (invoice.error) unreadable('readVerificationPacket.invoice', invoice.error);
  if (!invoice.data) return null;
  const inv = invoice.data as Row;

  const [client, project, others, exceptions, check, account, lines] = await Promise.all([
    supabase.schema('finance').rpc('client_names', { p_ids: [String(inv.client_account_id)] }),
    str(inv.project_id) ? supabase.schema('projects').from('projects').select('name').eq('id', String(inv.project_id)).maybeSingle() : Promise.resolve({ data: null, error: null }),
    supabase.schema('finance').from('payment_submissions').select('id, status, reference, amount_minor').eq('invoice_id', String(s.invoice_id)).neq('id', submissionId).limit(50),
    supabase.schema('finance').from('finance_exceptions' as never).select('id, kind, blocking, reason').eq('invoice_id' as never, String(s.invoice_id) as never).eq('state' as never, 'open' as never).limit(50),
    supabase.schema('finance').from('payment_account_checks' as never).select('outcome, client_name').eq('submission_id' as never, submissionId as never).maybeSingle(),
    str(s.account_id) ? supabase.schema('finance').from('payment_accounts').select('label').eq('id', String(s.account_id)).maybeSingle() : Promise.resolve({ data: null, error: null }),
    listRecentBankLines(500),
  ]);
  if (client.error) unreadable('readVerificationPacket.client', client.error);
  if (project.error) unreadable('readVerificationPacket.project', project.error);
  if (others.error) unreadable('readVerificationPacket.others', others.error);
  if (exceptions.error) unreadable('readVerificationPacket.exceptions', exceptions.error);
  if (check.error) unreadable('readVerificationPacket.check', check.error);
  if (account.error) unreadable('readVerificationPacket.account', account.error);

  const checkRow = check.data as Row | null;
  const accountCheck: PacketAccountCheck = checkRow
    ? { outcome: (['consistent', 'payer_differs', 'account_not_active', 'both'].includes(String(checkRow.outcome)) ? String(checkRow.outcome) : 'both') as 'consistent' | 'payer_differs' | 'account_not_active' | 'both', clientName: String(checkRow.client_name ?? '') }
    : null;
  const openExceptions: PacketException[] = ((exceptions.data ?? []) as Row[]).map((e) => ({ id: String(e.id), kind: String(e.kind), blocking: e.blocking === true, reason: String(e.reason ?? '') }));
  const bankLines = lines.map((l) => ({ id: l.id, statementDate: l.statementDate, description: l.description, reference: l.reference, amountMinor: l.amountMinor, status: l.status }));

  return buildVerificationPacket({
    claim: {
      id: String(s.id), status: String(s.status), amountMinor: num(s.amount_minor), currency: String(s.currency ?? 'INR'), method: String(s.method), reference: str(s.reference), payerName: str(s.payer_name),
      paidAt: str(s.paid_at), submittedAt: String(s.submitted_at), hasProof: str(s.proof_url) !== null || str(s.proof_storage_path) !== null || str(s.proof_file_name) !== null,
      receivingAccountLabel: account.data ? str((account.data as Row).label) : null,
    },
    invoice: { number: String(inv.number), status: String(inv.status), currency: String(inv.currency ?? 'INR'), totalMinor: num(inv.total_minor), verifiedMinor: num(inv.verified_minor), dueAt: str(inv.due_at) },
    clientName: str((client.data as { name?: string }[] | null)?.[0]?.name),
    projectName: project.data ? str((project.data as Row).name) : null,
    otherClaims: ((others.data ?? []) as Row[]).map((o) => ({ id: String(o.id), status: String(o.status), reference: str(o.reference), amountMinor: num(o.amount_minor) })),
    crossCheck: crossCheckClaim({ reference: str(s.reference), amountMinor: num(s.amount_minor) }, bankLines),
    openExceptions,
    accountCheck,
  });
}
