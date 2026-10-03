'use client';

import { useActionState, useId } from 'react';

import { recordVerificationAction, setRollbackPlanAction, setSmokeItemAction } from '@/modules/projects/handover-release-actions';
import { VERIFICATION_ENVIRONMENTS, VERIFICATION_OUTCOMES } from '@/modules/projects/handover-release-schema';
import type { SmokeItem } from '@/modules/projects/handover-release-queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-049 — the rollback plan, the post-deploy smoke checklist and the dated
 * verification, recorded on the PROJECT's release record (20261006500100) so
 * they need no handover. All `project.write` doors; the gate summary reports
 * them and the sign-off door does not read them.
 */

export function RollbackPlanForm({ projectId, current }: { projectId: string; current: string | null }) {
  const [state, action, pending] = useActionState(setRollbackPlanAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
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

function SmokeItemToggle({ projectId, item }: { projectId: string; item: SmokeItem }) {
  const [state, action, pending] = useActionState(setSmokeItemAction, IDLE_STATE);
  const done = item.doneAt !== null;

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
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
  items,
  editable,
  formatDate,
}: {
  projectId: string;
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
              {editable ? <SmokeItemToggle projectId={projectId} item={item} /> : null}
            </li>
          ))}
        </ul>
      )}

      {editable ? (
        <form action={action} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="projectId" value={projectId} />
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

const OUTCOME_LABEL: Record<(typeof VERIFICATION_OUTCOMES)[number], string> = { passed: 'Passed', partial: 'Partly passed', failed: 'Failed' };
const ENV_LABEL: Record<(typeof VERIFICATION_ENVIRONMENTS)[number], string> = { staging: 'Staging', production: 'Production', other: 'Other' };

/**
 * SCR-049 "Record post-deploy verification": somebody checked the deployed
 * release — against which build, in which environment, with what result. A
 * partial or failed verification must say what was found
 * (`projects.record_release_verification`).
 */
export function VerificationForm({ projectId, builds }: { projectId: string; builds: { id: string; title: string; version: number }[] }) {
  const [state, action, pending] = useActionState(recordVerificationAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-wrap gap-2">
        <div className="flex min-w-36 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-env`} className={labelClass}>Environment</label>
          <select id={`${id}-env`} name="environment" defaultValue="production" className={selectClass}>
            {VERIFICATION_ENVIRONMENTS.map((e) => (
              <option key={e} value={e}>{ENV_LABEL[e]}</option>
            ))}
          </select>
        </div>
        <div className="flex min-w-36 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-out`} className={labelClass}>Result</label>
          <select id={`${id}-out`} name="outcome" defaultValue="passed" className={selectClass}>
            {VERIFICATION_OUTCOMES.map((o) => (
              <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>
            ))}
          </select>
        </div>
        {builds.length > 0 ? (
          <div className="flex min-w-36 flex-1 flex-col gap-1">
            <label htmlFor={`${id}-build`} className={labelClass}>Build (optional)</label>
            <select id={`${id}-build`} name="deliverableId" defaultValue="" className={selectClass}>
              <option value="">Not named</option>
              {builds.map((b) => (
                <option key={b.id} value={b.id}>v{b.version} · {b.title}</option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-notes`} className={labelClass}>What was checked, and what was found (required unless it passed)</label>
        <textarea id={`${id}-notes`} name="notes" rows={2} maxLength={2000} className={`${inputClass} min-h-16`} placeholder="Login, checkout and the invoice PDF all work on production; the cache warmed in two minutes." />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-url`} className={labelClass}>Evidence link (optional)</label>
        <input id={`${id}-url`} name="evidenceUrl" type="url" className={inputClass} placeholder="https://status.example.com/run/42" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Recording…' : 'Record verification'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
