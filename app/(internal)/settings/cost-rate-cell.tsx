'use client';

import { useActionState, useState } from 'react';

import { setMemberCostRateAction } from '@/modules/team/cost-rate-actions';
import type { CostRateAccess, MemberCostRates } from '@/modules/team/cost-rate-types';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, inputClass, labelClass } from '@/ui';

/**
 * A person's cost rate on the Team roster — decision E2 of 2026-09-30.
 *
 * The owner sees the rate in force today, a "Set rate" form with the date
 * it applies from, and the history; ops_admin sees the value and the
 * history; nobody else sees this cell at all (the page passes `none` and
 * the row does not render it). A rate is cost, not billing: it prices
 * logged hours on the project report for readers who may read money, and
 * touches no invoice.
 *
 * Every row is a change from a date. There is no edit and no delete —
 * the table allows neither — so a wrong rate is corrected by setting the
 * right one from the same date; the newer row wins for that day and every
 * earlier log keeps the rate that covered its own day.
 */

function rate(minor: number, currency: string): string {
  return `${new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100)}/h`;
}

function SetRateForm({ userId, today, onDone }: { userId: string; today: string; onDone: () => void }) {
  const [state, action, pending] = useActionState(setMemberCostRateAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="userId" value={userId} />
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Rate (₹ per hour)</span>
        <input name="hourlyCost" inputMode="decimal" placeholder="850" required className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>From</span>
        <input type="date" name="effectiveFrom" defaultValue={today} required className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Note</span>
        <input name="note" maxLength={600} placeholder="optional" className={inputClass} />
      </label>
      <button type="submit" className={buttonClass('primary', 'sm')} disabled={pending}>
        {pending ? 'Setting…' : 'Set rate'}
      </button>
      <button type="button" className={buttonClass('ghost', 'sm')} onClick={onDone} disabled={pending}>
        Cancel
      </button>
      {state.status === 'error' ? <span className="basis-full text-xs text-danger">{state.message}</span> : null}
      {state.status === 'success' ? <span className="basis-full text-xs text-success">{state.message}</span> : null}
    </form>
  );
}

export function CostRateCell({
  userId,
  rates,
  access,
  today,
}: {
  userId: string;
  rates: MemberCostRates | undefined;
  access: Exclude<CostRateAccess, 'none'>;
  today: string;
}) {
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const current = rates?.current ?? null;
  const history = rates?.history ?? [];

  return (
    <div className="flex basis-full flex-col gap-2 border-t border-line pt-2">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-xs text-muted">Cost rate</span>
        {current ? (
          <span className="tabular font-medium">
            {rate(current.hourlyCostMinor, current.currency)}
            <span className="ml-1 text-xs font-normal text-muted">from {current.effectiveFrom}</span>
          </span>
        ) : (
          <span className="text-muted">No rate in force today{history.length > 0 ? ' (a later one is scheduled)' : ''}</span>
        )}
        {history.length > 0 ? (
          <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Hide history' : `History (${history.length})`}
          </button>
        ) : null}
        {access === 'set' && !editing ? (
          <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setEditing(true)}>
            Set rate
          </button>
        ) : null}
      </div>

      {access === 'set' && editing ? <SetRateForm userId={userId} today={today} onDone={() => setEditing(false)} /> : null}

      {showHistory && history.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-md bg-canvas px-3 py-2 text-xs">
          {history.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="tabular font-medium">{rate(r.hourlyCostMinor, r.currency)}</span>
              <span>from {r.effectiveFrom}</span>
              <span className="text-muted">set by {r.setByName} on {r.createdAt.slice(0, 10)}</span>
              {r.note ? <span className="text-muted">— {r.note}</span> : null}
            </li>
          ))}
          <li className="text-muted">A rate is never edited or deleted; set the right one from the same date to correct it.</li>
        </ul>
      ) : null}
    </div>
  );
}
