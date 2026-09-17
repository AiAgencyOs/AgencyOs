'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass } from '@/ui';
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

const button = buttonClass('secondary', 'sm');

/**
 * Master §5.4's states — G-261. `done` is gone, migrated to `verified`.
 *
 * `waiting_client` and `received` are distinct on purpose: an item somebody
 * has asked for is not an item that has arrived, and neither is an item that
 * has been checked. Showing all three as one tick would let a checklist read
 * as settled while two thirds of it is still somebody's problem.
 */
export const ONBOARDING_MARK: Record<string, string> = {
  pending: '·',
  waiting_client: '…',
  received: '↓',
  verified: '✓',
  not_applicable: '—',
};

/** Which states mean the item is no longer waiting on anybody here. */
const SETTLED = new Set(['verified', 'not_applicable']);

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
  // leave it wrong. G-261: the tick now means `verified`, which is what
  // `done` always meant.
  const next = SETTLED.has(status) ? 'pending' : 'verified';

  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span
        aria-hidden
        className={`w-4 text-center font-mono ${SETTLED.has(status) ? '' : 'text-muted'}`}
      >
        {ONBOARDING_MARK[status] ?? '·'}
      </span>
      <span className={`flex-1 ${SETTLED.has(status) ? 'text-muted line-through' : ''}`}>
        {label}
      </span>

      <form action={action} className="flex items-center gap-1">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="itemId" value={itemId} />
        <input type="hidden" name="status" value={next} />
        <button type="submit" disabled={pending} className={button}>
          {SETTLED.has(status) ? 'Undo' : 'Verified'}
        </button>
      </form>

      {SETTLED.has(status) ? null : (
        <>
          {/*
            The two states §5.4 adds, offered where they are useful: an item
            asked for and waiting, and an item that has arrived but nobody has
            checked. Both are honest answers a person previously had to record
            as "done" or leave as "pending".
          */}
          <form action={action} className="flex items-center gap-1">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="itemId" value={itemId} />
            <input type="hidden" name="status" value="waiting_client" />
            <button type="submit" disabled={pending} className={button}>
              Asked
            </button>
          </form>
          <form action={action} className="flex items-center gap-1">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="itemId" value={itemId} />
            <input type="hidden" name="status" value="received" />
            <button type="submit" disabled={pending} className={button}>
              Received
            </button>
          </form>
          <form action={action} className="flex items-center gap-1">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="itemId" value={itemId} />
            <input type="hidden" name="status" value="not_applicable" />
            <button type="submit" disabled={pending} className={button}>
              N/A
            </button>
          </form>
        </>
      )}

      {state.status === 'error' ? (
        <span role="status" className="w-full text-xs text-danger">
          {state.message}
        </span>
      ) : null}
    </li>
  );
}
