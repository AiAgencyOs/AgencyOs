'use client';

import { useActionState, useId } from 'react';

import type { ExpenseCategory } from '@/modules/finance/expense-categories';
import { setExpenseCategoryAction } from '@/modules/finance/expense-category-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, FormMessage, buttonClass, inputClass, labelClass } from '@/ui';

/** Add a category: the name is the label; the key is its slug, made by the database. */
export function AddExpenseCategoryForm() {
  const [state, action, pending] = useActionState(setExpenseCategoryAction, IDLE_STATE);
  const uid = useId();
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="action" value="add" />
      <div className="flex flex-col gap-1">
        <label className={labelClass} htmlFor={`${uid}-label`}>New category</label>
        <input id={`${uid}-label`} name="label" required maxLength={60} placeholder="Legal" className={`${inputClass} w-56`} />
      </div>
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Adding…' : 'Add category'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

/** One row: rename in place, retire or restore. Nothing is deleted. */
export function ExpenseCategoryRow({ category, inUse }: { category: ExpenseCategory; inUse: number }) {
  const [renameState, renameAction, renaming] = useActionState(setExpenseCategoryAction, IDLE_STATE);
  const [toggleState, toggleAction, toggling] = useActionState(setExpenseCategoryAction, IDLE_STATE);
  const uid = useId();
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-canvas px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{category.label}</span>
        <Badge mono>{category.key}</Badge>
        {category.retired ? <Badge tone="neutral">retired</Badge> : <Badge tone="success" dot>offered</Badge>}
        <span className="text-xs text-muted">{inUse} expense{inUse === 1 ? '' : 's'} filed here</span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <form action={renameAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="action" value="rename" />
          <input type="hidden" name="key" value={category.key} />
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor={`${uid}-name`}>Name</label>
            <input id={`${uid}-name`} name="label" required maxLength={60} defaultValue={category.label} className={`${inputClass} w-52`} />
          </div>
          <button type="submit" disabled={renaming} className={buttonClass('secondary', 'sm')}>
            {renaming ? 'Renaming…' : 'Rename'}
          </button>
        </form>
        <form action={toggleAction}>
          <input type="hidden" name="action" value={category.retired ? 'restore' : 'retire'} />
          <input type="hidden" name="key" value={category.key} />
          <input type="hidden" name="label" value={category.label} />
          <button type="submit" disabled={toggling} className={buttonClass('secondary', 'sm')}>
            {toggling ? 'Saving…' : category.retired ? 'Restore' : 'Retire'}
          </button>
        </form>
      </div>
      <FormMessage status={renameState.status} message={renameState.message} />
      <FormMessage status={toggleState.status} message={toggleState.message} />
    </li>
  );
}
