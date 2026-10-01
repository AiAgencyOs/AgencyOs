'use client';

import { useActionState, useId } from 'react';

import { generatePeriodReportAction } from '@/modules/finance/period-report-actions';
import { lockTaxPeriodAction, unlockTaxPeriodAction } from '@/modules/finance/tax-lock-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/**
 * Lock and unlock the selected reporting period — SCR-056. Locking records
 * that the return for this window has been filed; while it holds, the
 * finance service refuses to issue or void an invoice dated inside it.
 * Unlocking needs a reason, which the audit log keeps.
 */
export function LockPeriodForm({
  periodStart,
  periodEnd,
  label,
  reports = [],
}: {
  periodStart: string;
  periodEnd: string;
  label: string;
  /** Q-D2: the dated report snapshots of exactly this period, newest first; the lock may refer to one. */
  reports?: { id: string; label: string }[];
}) {
  const [state, action, pending] = useActionState(lockTaxPeriodAction, IDLE_STATE);
  const noteId = useId();
  const reportId = useId();

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="periodStart" value={periodStart} />
      <input type="hidden" name="periodEnd" value={periodEnd} />
      <div className="flex flex-col gap-1">
        <label htmlFor={noteId} className={labelClass}>Note (optional — e.g. the ARN of the filed return)</label>
        <input id={noteId} name="note" maxLength={600} className={inputClass} placeholder="GSTR-3B filed, ARN AA0709260012345" />
      </div>
      {/* Q-D2: the lock may refer to the dated report snapshot the return was made from. */}
      <div className="flex flex-col gap-1">
        <label htmlFor={reportId} className={labelClass}>Report this return was made from (optional)</label>
        <select id={reportId} name="reportId" defaultValue="" className={selectClass} disabled={reports.length === 0}>
          <option value="">{reports.length === 0 ? 'No report generated for this period yet' : 'No report named'}</option>
          {reports.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
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
  const reasonId = useId();

  return (
    <details className="rounded-lg border border-line bg-surface px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">Unlock {label}</summary>
      <form action={action} className="flex flex-col gap-2 pt-3">
        <input type="hidden" name="lockId" value={lockId} />
        <div className="flex flex-col gap-1">
          <label htmlFor={reasonId} className={labelClass}>Why is the period being reopened?</label>
          <input id={reasonId} name="reason" required maxLength={600} className={inputClass} placeholder="Amended return to be filed; invoice INV-2026-0042 was raised in error" />
        </div>
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

/**
 * "Generate period report" — SCR-056, Q-D2: stores a dated snapshot of the
 * selected period (the issued invoices and expenses as the ledger holds them
 * now, per currency). Each press is a new, dated row; the export history lists
 * them, and the period lock may refer to one.
 */
export function GeneratePeriodReportForm({ periodStart, periodEnd, label }: { periodStart: string; periodEnd: string; label: string }) {
  const [state, action, pending] = useActionState(generatePeriodReportAction, IDLE_STATE);
  const labelId = useId();

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="periodStart" value={periodStart} />
      <input type="hidden" name="periodEnd" value={periodEnd} />
      <div className="flex flex-col gap-1">
        <label htmlFor={labelId} className={labelClass}>Report name (optional)</label>
        <input id={labelId} name="label" maxLength={120} defaultValue={label} className={inputClass} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Generating…' : `Generate period report for ${label}`}
        </button>
        <span className="text-xs text-muted">Stores a dated snapshot of the figures as they stand now; it appears in the export history.</span>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
