'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { setOnboardingItemAction } from '@/modules/projects/actions';

/**
 * Document 10 §6's checklist — G-017, ADM-06.
 *
 * **It blocks nothing.** Every item is a reminder, so there is no "you cannot
 * start until…" anywhere on this panel, and there is nothing downstream that
 * reads it. The progress count is information, not a gate.
 *
 * `not_applicable` is offered beside `done` because §6 says the checklist
 * "should be configurable by project type" and it is not yet (G-113): until it
 * is, a project with no design references needs a way to say so that is not a
 * lie in either direction.
 */

const button =
  'rounded-lg border border-black/15 px-2 py-1 text-xs font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10';

const MARK: Record<string, string> = {
  done: '✓',
  not_applicable: '—',
  pending: '·',
};

export function OnboardingItemForm({
  projectId,
  itemId,
  label,
  status,
}: {
  projectId: string;
  itemId: string;
  label: string;
  status: string;
}) {
  const [state, action, pending] = useActionState(setOnboardingItemAction, IDLE_STATE);

  // Ticking and un-ticking are the same control, because an item answered by
  // mistake is the ordinary case and hiding the way back would make people
  // leave it wrong.
  const next = status === 'pending' ? 'done' : 'pending';

  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span
        aria-hidden
        className={`w-4 text-center font-mono ${status === 'pending' ? 'text-muted' : ''}`}
      >
        {MARK[status] ?? '·'}
      </span>
      <span className={`flex-1 ${status === 'pending' ? '' : 'text-muted line-through'}`}>
        {label}
      </span>

      <form action={action} className="flex items-center gap-1">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="itemId" value={itemId} />
        <input type="hidden" name="status" value={next} />
        <button type="submit" disabled={pending} className={button}>
          {status === 'pending' ? 'Done' : 'Undo'}
        </button>
      </form>

      {status === 'pending' ? (
        <form action={action} className="flex items-center gap-1">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="itemId" value={itemId} />
          <input type="hidden" name="status" value="not_applicable" />
          <button type="submit" disabled={pending} className={button}>
            N/A
          </button>
        </form>
      ) : null}

      {state.status === 'error' ? (
        <span role="status" className="w-full text-xs text-red-600 dark:text-red-400">
          {state.message}
        </span>
      ) : null}
    </li>
  );
}
