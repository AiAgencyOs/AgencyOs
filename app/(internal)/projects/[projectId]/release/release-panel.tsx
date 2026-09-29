'use client';

import { useActionState } from 'react';

import { setRollbackPlanAction, setSmokeItemAction } from '@/modules/projects/handover-release-actions';
import type { SmokeItem } from '@/modules/projects/handover-release-queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

/**
 * SCR-049 — the rollback plan and the smoke checklist on the release
 * candidate's handover. Both are `project.write` doors on
 * `projects.handovers`; the gate summary reports the checklist and the
 * sign-off door does not read it.
 */

export function RollbackPlanForm({ projectId, handoverId, current }: { projectId: string; handoverId: string; current: string | null }) {
  const [state, action, pending] = useActionState(setRollbackPlanAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="handoverId" value={handoverId} />
      <textarea
        name="rollbackPlan"
        rows={4}
        maxLength={8000}
        defaultValue={current ?? ''}
        className={`${inputClass} min-h-20`}
        placeholder="How this release is undone if it fails: previous artefact, the database step to reverse, who runs it, and how long it takes."
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : current ? 'Update rollback plan' : 'Record rollback plan'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

function SmokeItemToggle({ projectId, handoverId, item }: { projectId: string; handoverId: string; item: SmokeItem }) {
  const [state, action, pending] = useActionState(setSmokeItemAction, IDLE_STATE);
  const done = item.doneAt !== null;

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="handoverId" value={handoverId} />
      <input type="hidden" name="label" value={item.label} />
      <button type="submit" name="done" value={done ? 'false' : 'true'} disabled={pending} className={buttonClass('ghost', 'sm')}>
        {pending ? '…' : done ? 'Untick' : 'Tick'}
      </button>
      <button type="submit" name="remove" value="true" disabled={pending} className={buttonClass('ghost', 'sm')}>
        Remove
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

export function SmokeChecklist({
  projectId,
  handoverId,
  items,
  editable,
  formatDate,
}: {
  projectId: string;
  handoverId: string;
  items: SmokeItem[];
  editable: boolean;
  /** Pre-formatted by the server's agency clock; the client has no clock of its own. */
  formatDate: Record<string, string>;
}) {
  const [state, action, pending] = useActionState(setSmokeItemAction, IDLE_STATE);

  return (
    <div className="flex flex-col gap-2">
      {items.length === 0 ? (
        <p className="text-[13px] text-muted">No smoke check listed yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.label} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-1.5 text-[13px]">
              <span className="flex items-center gap-2">
                <span aria-hidden className={item.doneAt ? 'text-success' : 'text-muted'}>
                  {item.doneAt ? '☑' : '☐'}
                </span>
                <span className={item.doneAt ? '' : 'text-foreground'}>{item.label}</span>
                {item.doneAt ? <span className="text-xs text-muted">done {formatDate[item.doneAt] ?? ''}</span> : null}
              </span>
              {editable ? <SmokeItemToggle projectId={projectId} handoverId={handoverId} item={item} /> : null}
            </li>
          ))}
        </ul>
      )}

      {editable ? (
        <form action={action} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="handoverId" value={handoverId} />
          <input type="hidden" name="done" value="false" />
          <input name="label" required maxLength={200} className={`${inputClass} min-w-48 flex-1`} placeholder="Home page loads over HTTPS" />
          <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
            {pending ? 'Adding…' : 'Add check'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </form>
      ) : null}
    </div>
  );
}
