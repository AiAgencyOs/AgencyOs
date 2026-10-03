'use client';

import { useActionState, useId } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { approveScreenAction, confirmScreenQaAction, setScreenCategoryAction } from '@/modules/projects/screen-gate-actions';
import { buttonClass, FormMessage, inputClass, labelClass } from '@/ui';

/** SCR-034 — the inventory category of one screen (`projects.set_screen_category`). Existing categories are offered as suggestions. */
export function CategoryForm({ projectId, screenId, current, suggestions }: { projectId: string; screenId: string; current: string | null; suggestions: string[] }) {
  const [state, action, pending] = useActionState(setScreenCategoryAction, IDLE_STATE);
  const id = useId();
  const listId = useId();
  return (
    <form action={action} className="flex flex-col gap-1.5">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="screenId" value={screenId} />
      <label htmlFor={id} className={labelClass}>Category</label>
      <div className="flex flex-wrap items-center gap-2">
        <input id={id} name="category" list={listId} defaultValue={current ?? ''} maxLength={60} placeholder="e.g. Authentication" className={`${inputClass} min-w-0 flex-1`} />
        <datalist id={listId}>
          {suggestions.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Save Category'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

/** QA confirms the required sections, buttons, components and navigation (`projects.confirm_screen_qa`, owner or ops admin). */
export function ConfirmQaButton({ projectId, screenId }: { projectId: string; screenId: string }) {
  const [state, action, pending] = useActionState(confirmScreenQaAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="screenId" value={screenId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Recording…' : 'Confirm QA Check'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

/** Approve the screen design (`projects.approve_screen`); the database refuses while a state is missing or QA has not confirmed. */
export function ApproveScreenButton({ projectId, screenId }: { projectId: string; screenId: string }) {
  const [state, action, pending] = useActionState(approveScreenAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="screenId" value={screenId} />
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Approving…' : 'Approve Screen'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
