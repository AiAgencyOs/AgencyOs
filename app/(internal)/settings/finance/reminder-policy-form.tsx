'use client';

import { useActionState } from 'react';

import { setInvoiceReminderPolicyAction } from '@/modules/finance/reminder-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass } from '@/ui';

/**
 * Settings › Finance › past-due reminders — owner decision 2026-09-29. A
 * switch and an interval, both real columns on the organization, both
 * audited by the door. Off means what the product did before: nothing is
 * chased on its own.
 */
export function InvoiceReminderPolicyForm({ enabled, intervalDays }: { enabled: boolean; intervalDays: number }) {
  const [state, action, pending] = useActionState(setInvoiceReminderPolicyAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={enabled} className="h-4 w-4" />
          Chase past-due invoices on WhatsApp automatically
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Every (days, 1–90)</span>
          <input
            type="text"
            inputMode="numeric"
            name="intervalDays"
            defaultValue={String(intervalDays)}
            className={`${inputClass} w-24 tabular`}
          />
        </label>
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
