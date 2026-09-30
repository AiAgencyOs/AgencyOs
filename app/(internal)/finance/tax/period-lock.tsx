'use client';

import { useActionState } from 'react';

import { lockTaxPeriodAction, unlockTaxPeriodAction } from '@/modules/finance/tax-lock-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass } from '@/ui';

/**
 * Lock and unlock the selected reporting period — SCR-056. Locking records
 * that the return for this window has been filed; while it holds, the
 * finance service refuses to issue or void an invoice dated inside it.
 * Unlocking needs a reason, which the audit log keeps.
 */
export function LockPeriodForm({ periodStart, periodEnd, label }: { periodStart: string; periodEnd: string; label: string }) {
  const [state, action, pending] = useActionState(lockTaxPeriodAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="periodStart" value={periodStart} />
      <input type="hidden" name="periodEnd" value={periodEnd} />
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Note (optional — e.g. the ARN of the filed return)</span>
        <input name="note" maxLength={600} className={inputClass} placeholder="GSTR-3B filed, ARN AA0709260012345" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Locking…' : `Lock ${label}`}
        </button>
        <span className="text-xs text-muted">Invoices dated inside it can no longer be issued or voided.</span>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function UnlockPeriodForm({ lockId, label }: { lockId: string; label: string }) {
  const [state, action, pending] = useActionState(unlockTaxPeriodAction, IDLE_STATE);

  return (
    <details className="rounded-lg border border-line bg-surface px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">Unlock {label}</summary>
      <form action={action} className="flex flex-col gap-2 pt-3">
        <input type="hidden" name="lockId" value={lockId} />
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Why is the period being reopened?</span>
          <input name="reason" required maxLength={600} className={inputClass} placeholder="Amended return to be filed; invoice INV-2026-0042 was raised in error" />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
            {pending ? 'Unlocking…' : 'Unlock, with this reason'}
          </button>
          <span className="text-xs text-muted">The reason goes on the audit log with your name.</span>
        </div>
        <FormMessage status={state.status} message={state.message} />
      </form>
    </details>
  );
}
