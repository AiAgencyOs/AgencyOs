'use server';

import { revalidatePath } from 'next/cache';

import { updateClientAccount } from '@/lib/admin/client-edit';
import { setClientTeam } from '@/lib/admin/client-team';
import type { FormState } from '@/modules/identity/types';

/** SCR-014/015 — name, legal name, GSTIN, PAN and billing address, through `core.update_client_account`. */
export async function updateClientAccountAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const clientAccountId = String(formData.get('clientAccountId') ?? '');
  const result = await updateClientAccount({
    clientAccountId,
    name: String(formData.get('name') ?? ''),
    legalName: String(formData.get('legalName') ?? ''),
    gstin: String(formData.get('gstin') ?? ''),
    pan: String(formData.get('pan') ?? ''),
    billingAddress: String(formData.get('billingAddress') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/clients/${clientAccountId}`);
  revalidatePath('/clients');
  return { status: 'success', message: result.data.outcome === 'unchanged' ? 'Nothing changed.' : 'Client details saved. Audited.' };
}

/** SCR-015 — the assigned team, replaced whole, through `core.set_client_account_team`. */
export async function setClientTeamAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const clientAccountId = String(formData.get('clientAccountId') ?? '');
  const userIds = formData.getAll('userIds').map((v) => String(v)).filter(Boolean);
  const result = await setClientTeam({ clientAccountId, userIds });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/clients/${clientAccountId}`);
  return { status: 'success', message: result.data.count === 0 ? 'Team cleared. Audited.' : `${result.data.count} assigned. Audited.` };
}
