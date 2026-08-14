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
 * `not_applicable` is offered beside `done` so that a project with no design
 * references can say so, rather than leaving an item pending for ever or
 * ticking a lie.
 *
 * This used to say the checklist "should be configurable by project type" and
 * is not yet — quoting Document 10 §6 and pointing at G-113 as the fix.
 * **ADM-73 ruled that project type is the wrong axis**: the agency sells any
 * combination of web and application work, and a type enum would limit what
 * can be sold rather than describe what was. There is no `project_type` field
 * anywhere in this repository and there is not going to be one.
 *
 * What G-113 still wants is narrower and different: the seventeen items are a
 * literal `VALUES` list inside `projects.seed_onboarding`, so changing the
 * baseline is a migration rather than something an Admin can do. `ADM-80` has
 * the proposed shape and is awaiting review.
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
