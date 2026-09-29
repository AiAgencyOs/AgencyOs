'use server';

import { revalidatePath } from 'next/cache';

import { setKillSwitch, KILL_SWITCH_LABEL, type KillSwitch } from '@/lib/observability/kill-switches';
import type { FormState } from '@/modules/identity/types';

/** SCR-068 — engage or release one emergency control, with a reason. Refusals are surfaced as written. */
export async function setKillSwitchAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await setKillSwitch({
    switch: String(formData.get('switch') ?? ''),
    active: String(formData.get('active') ?? '') === 'true',
    reason: String(formData.get('reason') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/operations');
  revalidatePath('/governance/overrides');
  revalidatePath('/', 'layout');
  const label = KILL_SWITCH_LABEL[result.data.switch as KillSwitch];
  return {
    status: 'success',
    message: result.data.active ? `${label}: engaged. The runner and the send chokepoint honour it from the next tick. Audited.` : `${label}: released. Audited.`,
  };
}
