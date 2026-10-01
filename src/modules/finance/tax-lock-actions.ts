'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { lockTaxPeriod, unlockTaxPeriod } from './tax-lock-service';

/** Lock the selected reporting period — SCR-056. */
export async function lockTaxPeriodAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();

  const result = await lockTaxPeriod({
    periodStart: text('periodStart'),
    periodEnd: text('periodEnd'),
    ...(text('note') ? { note: text('note') } : {}),
    ...(text('reportId') ? { reportId: text('reportId') } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/finance/tax');
  revalidatePath('/invoices');
  return {
    status: 'success',
    message: result.data.alreadyLocked
      ? 'This period was already locked.'
      : 'Period locked. Invoices dated inside it can no longer be issued or voided until it is unlocked.',
  };
}

/** Reopen a locked period, with a reason — audited. */
export async function unlockTaxPeriodAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();

  const result = await unlockTaxPeriod({ lockId: text('lockId'), reason: text('reason') });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/finance/tax');
  revalidatePath('/invoices');
  return {
    status: 'success',
    message: result.data.alreadyUnlocked ? 'This period was already unlocked.' : 'Period unlocked. The reason is on the audit log.',
  };
}
