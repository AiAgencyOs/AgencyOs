'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, inputClass } from '@/ui';
import { PORTFOLIO_KINDS, PORTFOLIO_KIND_LABELS } from '@/modules/crm/schema';

import { addPortfolioItemAction, setPortfolioItemActiveAction } from './actions';

const field = inputClass;
const button = buttonClass('primary', 'md');

/**
 * Adding to the list §5.3 says the Admin maintains — G-013, ADM-12.
 *
 * A link is required, and the migration header says why: §5.3's list holds
 * things that may be *sent*, so an entry nobody could send would satisfy the
 * schema and not the rule.
 */
export function AddPortfolioItemForm() {
  const [state, action, pending] = useActionState(addPortfolioItemAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="kind" className="text-xs uppercase tracking-wide text-muted">
          What it is
        </label>
        <select id="kind" name="kind" className={field} defaultValue="sample" required>
          {PORTFOLIO_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {PORTFOLIO_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="title" className="text-xs uppercase tracking-wide text-muted">
          Title
        </label>
        <input id="title" name="title" className={field} maxLength={200} required />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="url" className="text-xs uppercase tracking-wide text-muted">
          Link
        </label>
        <input id="url" name="url" type="url" className={field} maxLength={2000} required />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="description" className="text-xs uppercase tracking-wide text-muted">
          Description <span className="normal-case text-muted">(optional)</span>
        </label>
        <textarea id="description" name="description" className={field} maxLength={2000} rows={2} />
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" className={button} disabled={pending}>
          {pending ? 'Adding…' : 'Add to the list'}
        </button>
        {state.status !== 'idle' && state.message ? (
          <span className={state.status === 'error' ? 'text-sm text-danger' : 'text-sm text-muted'}>
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Retiring an item, or bringing it back.
 *
 * Deactivation rather than deletion, so a message that already went out still
 * points at something.
 */
export function TogglePortfolioItemForm({
  itemId,
  isActive,
}: {
  itemId: string;
  isActive: boolean;
}) {
  const [state, action, pending] = useActionState(setPortfolioItemActiveAction, IDLE_STATE);

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="isActive" value={isActive ? 'false' : 'true'} />
      <button type="submit" className={button} disabled={pending}>
        {isActive ? 'Retire' : 'Restore'}
      </button>
      {state.status === 'error' && state.message ? (
        <span className="text-sm text-danger">{state.message}</span>
      ) : null}
    </form>
  );
}
