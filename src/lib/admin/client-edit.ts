import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

/**
 * The client edit door — SCR-014/015 (`core.update_client_account`,
 * migration 20261001110000). Beside `client-ownership.ts` for the same
 * reason that file exists: `core.client_accounts` has no owning module.
 *
 * `project.write` is the capability, matching the owner/tags door and
 * "Add client": may add operational detail to a client I can see. The
 * database function checks the session again, `client_accounts_write`
 * decides on the row, the GSTIN's shape/state/checksum and the PAN's shape
 * are refused there (a checksum that passes is still not a registration
 * that is real), and the change is audited as `client_account.details_updated`.
 */

export { updateClientAccountSchema, type UpdateClientAccountInput } from './client-edit-schema';
import { updateClientAccountSchema, type UpdateClientAccountInput } from './client-edit-schema';

export async function updateClientAccount(input: UpdateClientAccountInput): Promise<Result<{ outcome: 'updated' | 'unchanged' }>> {
  const parsed = updateClientAccountSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid client details.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to edit clients.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('update_client_account', {
    p_client_account_id: parsed.data.clientAccountId,
    p_name: parsed.data.name,
    p_legal_name: parsed.data.legalName || null,
    p_gstin: parsed.data.gstin || null,
    p_pan: parsed.data.pan || null,
    p_billing_address: parsed.data.billingAddress || null,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'updateClientAccount', detail: error.message }));
    return err('INTERNAL', 'Could not save the client.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'updated':
      return ok({ outcome: 'updated' });
    case 'unchanged':
      return ok({ outcome: 'unchanged' });
    case 'not_found':
      return err('NOT_FOUND', 'Client not found.');
    case 'no_name':
      return err('VALIDATION', 'A client needs a name.');
    case 'bad_gstin':
      return err('VALIDATION', 'That GSTIN does not check out: the state code or the check character is wrong. A typo is refused here rather than by the client’s accountant.');
    case 'bad_pan':
      return err('VALIDATION', 'A PAN is 5 letters, 4 digits, 1 letter.');
    case 'gstin_pan_mismatch':
      return err('VALIDATION', 'The PAN inside the GSTIN (characters 3–12) does not match the PAN typed.');
    default:
      return err('FORBIDDEN', 'You do not have permission to edit clients.');
  }
}

/** The editable identity of one client, for the form's defaults. */
export type ClientIdentity = { id: string; name: string; legalName: string | null; gstin: string | null; pan: string | null; billingAddress: string | null };

export async function readClientIdentity(clientAccountId: string): Promise<ClientIdentity | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('client_accounts').select('id, name, legal_name, gstin, pan, billing_address').eq('id', clientAccountId).maybeSingle();
  if (error) unreadable('readClientIdentity', error);
  if (!data) return null;
  return { id: data.id, name: data.name, legalName: data.legal_name, gstin: data.gstin, pan: data.pan, billingAddress: data.billing_address };
}
