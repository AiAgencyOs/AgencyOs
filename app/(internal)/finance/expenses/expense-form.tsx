'use client';

import { useActionState, useId } from 'react';

import { recordExpenseAction } from '@/modules/finance/actions';
import type { ExpenseCategory } from '@/modules/finance/expense-categories';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

export function RecordExpenseForm({ projects, categories }: { projects: { id: string; name: string }[]; categories: readonly ExpenseCategory[] }) {
  const [state, action, pending] = useActionState(recordExpenseAction, IDLE_STATE);
  const receiptFileId = useId();

  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border border-dashed border-line p-4">
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor="expense-category">
            Category
          </label>
          <select id="expense-category" name="category" required defaultValue="" className={selectClass}>
            <option value="" disabled>
              Choose…
            </option>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor="expense-project">
            Project (optional)
          </label>
          <select id="expense-project" name="projectId" defaultValue="" className={selectClass}>
            <option value="">Overhead — no project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor="expense-vendor">
            Vendor (optional)
          </label>
          <input id="expense-vendor" name="vendor" maxLength={200} className={inputClass} placeholder="Vercel" />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor="expense-amount">
            Amount
          </label>
          <input id="expense-amount" name="amount" required inputMode="decimal" className={`${inputClass} w-32`} />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor="expense-incurred">
            Incurred on
          </label>
          <input id="expense-incurred" name="incurredOn" type="date" required className={inputClass} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className={labelClass} htmlFor="expense-description">
          What this was for
        </label>
        <input id="expense-description" name="description" required maxLength={2000} className={inputClass} />
      </div>
      <div className="flex flex-col gap-1">
        <label className={labelClass} htmlFor="expense-receipt">
          Receipt link (optional)
        </label>
        <input id="expense-receipt" name="receiptUrl" type="url" maxLength={2000} className={inputClass} placeholder="https://drive.google.com/…" />
      </div>
      <div className="flex flex-col gap-1">
        <label className={labelClass} htmlFor={receiptFileId}>
          Or upload the receipt (optional)
        </label>
        <input id={receiptFileId} name="receiptFile" type="file" className={inputClass} />
        <span className="text-xs text-muted">Up to 50 MB, and never a password or key. A link above works too.</span>
      </div>
      <button type="submit" disabled={pending} className={`${buttonClass('primary', 'sm')} self-start`}>
        {pending ? 'Recording…' : 'Record expense'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
