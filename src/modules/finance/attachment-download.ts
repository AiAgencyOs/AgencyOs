import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { signFinanceAttachment, type FinanceAttachmentKind } from './attachment';

/**
 * The door behind /api/finance/attachment/<kind>/<id>: an internal reader with
 * `invoice.read` (owner, ops_admin, finance), the row read under RLS, the
 * object signed under the reader's own session.
 */
export async function resolveFinanceAttachmentUrl(kind: string, id: string): Promise<Result<{ url: string }>> {
  if (kind !== 'claim-proof' && kind !== 'expense-receipt') return err('VALIDATION', 'Unknown kind of attachment.');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return err('VALIDATION', 'Invalid file.');
  const context = await requireInternal();
  if (!can(context, 'invoice.read')) return err('FORBIDDEN', 'You do not have permission to read finance files.');

  const supabase = await createClient();
  const which: FinanceAttachmentKind = kind;
  const { data, error } =
    which === 'claim-proof'
      ? await supabase.schema('finance').from('payment_submissions').select('proof_storage_path').eq('id', id).maybeSingle()
      : await supabase.schema('finance').from('expenses').select('receipt_storage_path').eq('id', id).maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'resolveFinanceAttachmentUrl', detail: error.message }));
    return err('INTERNAL', 'Could not read the record.');
  }
  const path = data ? ('proof_storage_path' in data ? data.proof_storage_path : data.receipt_storage_path) : null;
  if (!path) return err('NOT_FOUND', 'No uploaded file on that record.');

  const signed = await signFinanceAttachment(supabase, path);
  return signed.ok ? ok(signed.data) : signed;
}
