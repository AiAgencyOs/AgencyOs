'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

import { PHASE_NINE_B_DOORS, isPhaseNineBDoor, phaseNineBWords, text } from './phase-nine-b-doors';

/**
 * ONE server action over the Phase 9B whitelist. It decides nothing: each database door checks the role and its refusal is shown as written.
 * No verify, refund, send or amount-edit door is in the table.
 */
export async function phaseNineBDoorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'invoice.read')) return { status: 'error', message: 'You do not have permission to use finance.' };
  const name = text(formData, 'door');
  if (!isPhaseNineBDoor(name)) return { status: 'error', message: 'Unknown action.' };
  const door = PHASE_NINE_B_DOORS[name];
  if (!door) return { status: 'error', message: 'Unknown action.' };
  const args = door.args(formData);
  if (args === null) return { status: 'error', message: phaseNineBWords('bad_input') };

  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc(door.rpc as never, args as never);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'phaseNineBDoorAction', door: name, detail: error.message }));
    return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  }
  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string | null };
  const outcome = String(row.outcome ?? 'no answer');
  if (!door.ok.includes(outcome)) return { status: 'error', message: phaseNineBWords(outcome) };
  revalidatePath('/finance/close');
  return { status: 'success', message: phaseNineBWords(outcome) };
}
