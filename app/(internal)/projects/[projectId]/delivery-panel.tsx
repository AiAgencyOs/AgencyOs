'use client';

import { useActionState, useState } from 'react';

import { configurePaymentPlanAction, setProjectStatusAction } from '@/modules/projects/actions';
import { IDLE_STATE } from '@/modules/identity/types';

const input =
  'w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20';
const button =
  'rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10';

function Status({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'idle') return null;
  return (
    <p
      role="status"
      className={`text-sm ${state.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted'}`}
    >
      {state.message}
    </p>
  );
}

export function ProjectStatusForm({
  projectId,
  current,
  allowed,
}: {
  projectId: string;
  current: string;
  allowed: readonly string[];
}) {
  const [state, action, pending] = useActionState(setProjectStatusAction, IDLE_STATE);

  if (allowed.length === 0) {
    return <p className="text-sm text-muted">Project is {current}; no further moves.</p>;
  }

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-wrap items-center gap-2">
        <select name="status" defaultValue={allowed[0]} aria-label="New status" className={`${input} w-auto`}>
          {allowed.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Moving…' : 'Move project'}
        </button>
      </div>
      <Status state={state} />
    </form>
  );
}

type Row = { name: string; percent: string; dueOn: string };

/**
 * Payment plan editor.
 *
 * Rows are added and removed freely and the split is whatever the deal agreed:
 * 30/20/30/20, 5/10/30/20/35, or anything else totalling 100. The running total
 * is shown so the user sees the constraint before submitting — the server and
 * the database both re-check it regardless.
 */
export function PaymentPlanForm({
  projectId,
  initial,
}: {
  projectId: string;
  initial: { name: string; percent: number | null; dueOn: string | null }[];
}) {
  const [state, action, pending] = useActionState(configurePaymentPlanAction, IDLE_STATE);
  const [rows, setRows] = useState<Row[]>(
    initial.length > 0
      ? initial.map((m) => ({
          name: m.name,
          percent: m.percent === null ? '' : String(m.percent),
          dueOn: m.dueOn ?? '',
        }))
      : [{ name: 'Advance', percent: '', dueOn: '' }],
  );

  const total = rows.reduce((sum, r) => sum + (Number(r.percent) || 0), 0);
  const balanced = Math.round(total * 100) === 10_000;

  const update = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="projectId" value={projectId} />

      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <input
              name="name"
              value={row.name}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder="Milestone"
              aria-label={`Milestone ${i + 1} name`}
              className={`${input} w-56`}
            />
            <input
              name="percent"
              value={row.percent}
              onChange={(e) => update(i, { percent: e.target.value })}
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              placeholder="%"
              aria-label={`Milestone ${i + 1} percent`}
              className={`${input} w-24`}
            />
            <input
              name="dueOn"
              value={row.dueOn}
              onChange={(e) => update(i, { dueOn: e.target.value })}
              type="date"
              aria-label={`Milestone ${i + 1} due date`}
              className={`${input} w-44`}
            />
            <button
              type="button"
              onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
              className="text-sm text-muted hover:underline"
              aria-label={`Remove milestone ${i + 1}`}
            >
              remove
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setRows((prev) => [...prev, { name: '', percent: '', dueOn: '' }])}
          className={button}
        >
          Add milestone
        </button>
        <span
          className={`font-mono text-sm ${balanced ? 'text-muted' : 'text-red-600 dark:text-red-400'}`}
        >
          total {total.toFixed(2)}%
        </span>
        <button type="submit" disabled={pending || !balanced} className={button}>
          {pending ? 'Saving…' : 'Save payment plan'}
        </button>
      </div>

      <Status state={state} />
    </form>
  );
}
