'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

import { PHASE_NINE_DOORS, isPhaseNineDoor, phaseNineWords, text } from './phase-nine-doors';

/**
 * ONE server action over the Phase 9 whitelist (phase-nine-doors.ts). It decides nothing: each database door checks the role, the state, the separation
 * of duties and the gates under its own lock. The page gate here is only "may read money"; the database refuses everything else, and its refusal is shown
 * as written. Never imports a verify, refund, send or amount-edit door: none is in the table.
 */
export async function phaseNineDoorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'invoice.read')) return { status: 'error', message: 'You do not have permission to use finance.' };
  const name = text(formData, 'door');
  if (!isPhaseNineDoor(name)) return { status: 'error', message: 'Unknown action.' };
  const door = PHASE_NINE_DOORS[name];
  if (!door) return { status: 'error', message: 'Unknown action.' };

  const args = door.args(formData);
  if (args === null) return { status: 'error', message: phaseNineWords('bad_input') };

  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc(door.rpc as never, args as never);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'phaseNineDoorAction', door: name, detail: error.message }));
    return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  }
  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string | null };
  const outcome = String(row.outcome ?? 'no answer');
  if (!door.ok.includes(outcome)) return { status: 'error', message: phaseNineWords(outcome) };

  revalidatePath('/finance/close');
  const projectId = text(formData, 'projectId');
  if (projectId) revalidatePath(`/finance/close/${projectId}`);
  return { status: 'success', message: phaseNineWords(outcome) };
}
