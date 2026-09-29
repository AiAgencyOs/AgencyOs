'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { invoiceChangeRequest } from './change-request-invoice-service';

/** SCR-031 "Trigger finance" — raise the change request's own invoice as a Server Action. */
export async function invoiceChangeRequestAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const dueInDaysRaw = String(formData.get('dueInDays') ?? '').trim();
  const notes = String(formData.get('notes') ?? '').trim();
  const result = await invoiceChangeRequest({
    changeRequestId: String(formData.get('changeRequestId') ?? ''),
    ...(dueInDaysRaw ? { dueInDays: Number(dueInDaysRaw) } : {}),
    ...(notes ? { notes } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}/scope`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/invoices');
  return {
    status: 'success',
    message: result.data.created
      ? `Draft invoice ${result.data.number} raised for this change. Issue it from Invoices; apply the change once it is paid.`
      : `This change already has invoice ${result.data.number}.`,
  };
}
