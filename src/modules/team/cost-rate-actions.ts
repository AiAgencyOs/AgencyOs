'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { moneyToMinor } from './cost-rate-schema';
import { setMemberCostRate } from './cost-rate-service';

/** Set a person's hourly cost rate from a date — Settings › Team, owner only. */
export async function setMemberCostRateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();

  const hourlyCostMinor = moneyToMinor(text('hourlyCost'));
  if (hourlyCostMinor === null) {
    return { status: 'error', message: 'The rate is rupees per hour, like 850 or 850.50.' };
  }

  const result = await setMemberCostRate({
    userId: text('userId'),
    hourlyCostMinor,
    effectiveFrom: text('effectiveFrom'),
    ...(text('note') ? { note: text('note') } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings/team');
  return {
    status: 'success',
    message: `Rate set from ${text('effectiveFrom')}. Logs on or after that day are costed at it; earlier logs keep the rate that covered their day.`,
  };
}
