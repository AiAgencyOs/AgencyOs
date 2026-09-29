'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { REMINDER_INTERVAL_DEFAULT_DAYS } from './reminder-schema';
import { setInvoiceReminderPolicy } from './reminder-service';

/** Settings › Finance › past-due reminders — thin wrapper over reminder-service.ts. */
export async function setInvoiceReminderPolicyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const enabled = String(formData.get('enabled') ?? '') === 'on';
  const intervalRaw = String(formData.get('intervalDays') ?? '').trim();
  if (intervalRaw !== '' && !/^[0-9]{1,2}$/.test(intervalRaw)) {
    return { status: 'error', message: 'The interval is a whole number of days, 1–90.' };
  }
  const intervalDays = intervalRaw === '' ? REMINDER_INTERVAL_DEFAULT_DAYS : Number(intervalRaw);

  const result = await setInvoiceReminderPolicy({ enabled, intervalDays });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings/finance');
  return {
    status: 'success',
    message: result.data.enabled
      ? `On. Past-due invoices are chased on WhatsApp every ${result.data.intervalDays} day${result.data.intervalDays === 1 ? '' : 's'} on the runner's next tick — as text inside the 24-hour window, as the approved "invoice_reminder" template outside it.`
      : 'Off. Nothing is chased automatically; reminders are sent and recorded by hand from the invoice.',
  };
}
