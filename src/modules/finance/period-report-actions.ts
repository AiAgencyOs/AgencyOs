'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { generatePeriodReport } from './period-report-service';

/** "Generate period report" — SCR-056: stores a dated snapshot of the selected period (Q-D2). */
export async function generatePeriodReportAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const result = await generatePeriodReport({
    periodStart: text('periodStart'),
    periodEnd: text('periodEnd'),
    ...(text('label') ? { label: text('label') } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/finance/tax');
  return {
    status: 'success',
    message: `Report stored with ${result.data.invoiceCount} issued invoice${result.data.invoiceCount === 1 ? '' : 's'}. It is in the export history, and the period lock can refer to it.`,
  };
}
