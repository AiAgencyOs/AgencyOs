'use client';

import { useActionState, useId } from 'react';

import { updateExpenseAction } from '@/modules/finance/actions';
import { offeredFor, type ExpenseCategory } from '@/modules/finance/expense-categories';
import type { ExpenseRow } from '@/modules/finance/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass } from '@/ui';

/** SCR-055 — correct one expense in place. Opens under its row; owner/ops_admin only. */
export function EditExpenseForm({ expense, projects, categories }: { expense: ExpenseRow; projects: readonly { id: string; name: string }[]; categories: readonly ExpenseCategory[] }) {
  const [state, action, pending] = useActionState(updateExpenseAction, IDLE_STATE);
  const receiptFileId = useId();

  return (
    <details>
      <summary className="cursor-pointer text-xs text-brand hover:underline">Edit</summary>
      <form action={action} className="mt-2 grid w-[min(36rem,80vw)] grid-cols-2 gap-2 rounded-lg border border-line bg-canvas p-3 text-left">
        <input type="hidden" name="expenseId" value={expense.id} />
        <label className="col-span-2 flex flex-col gap-1">
          <span className={labelClass}>What</span>
          <input name="description" required maxLength={2000} defaultValue={expense.description} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Category</span>
          <select name="category" defaultValue={expense.category} className={selectClass}>
            {offeredFor(categories, expense.category).map((c) => (
              <option key={c.key} value={c.key}>{c.retired ? `${c.label} (retired)` : c.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Project</span>
          <select name="projectId" defaultValue={expense.projectId ?? ''} className={selectClass}>
            <option value="">Overhead</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Vendor</span>
          <input name="vendor" maxLength={200} defaultValue={expense.vendor ?? ''} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Amount ({expense.currency})</span>
          <input name="amount" required inputMode="decimal" defaultValue={(expense.amountMinor / 100).toFixed(2)} className={`${inputClass} tabular`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Incurred on</span>
          <input type="date" name="incurredOn" required defaultValue={expense.incurredOn} className={inputClass} />
        </label>
        <label className="col-span-2 flex flex-col gap-1">
          <span className={labelClass}>Receipt link</span>
          <input type="url" name="receiptUrl" maxLength={2000} defaultValue={expense.receiptUrl ?? ''} className={inputClass} placeholder="https://…" />
        </label>
        <div className="col-span-2 flex flex-col gap-1">
          <label className={labelClass} htmlFor={receiptFileId}>{expense.receiptFileName ? `Replace the uploaded receipt (${expense.receiptFileName})` : 'Upload a receipt'}</label>
          <input id={receiptFileId} name="receiptFile" type="file" className={inputClass} />
        </div>
        <div className="col-span-2 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Saving…' : 'Save'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </div>
      </form>
    </details>
  );
}
