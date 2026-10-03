'use client';

import { useActionState, useId } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { decidePrototypeAdminAction, recordPrototypeQaAction, sendPrototypeAction, setDeliverableDetailsAction } from '@/modules/projects/build-details-actions';
import { PROTOTYPE_PLATFORMS } from '@/modules/projects/prototype-schema';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

/**
 * SCR-037/043 — the controls on one prototype or build: its platform, commit
 * ref, build number and rollback target (`projects.set_deliverable_details`),
 * Admin's decision (`projects.decide_prototype_admin`) and the gated send to
 * the client (`projects.send_prototype_for_client_review`).
 */

export function BuildDetailsForm({
  projectId,
  deliverableId,
  current,
  rollbackChoices,
  showPlatform,
}: {
  projectId: string;
  deliverableId: string;
  current: { platform: string | null; commitRef: string | null; buildNumber: string | null; rollbackTargetId: string | null; rollbackNote: string | null };
  rollbackChoices: { id: string; label: string }[];
  showPlatform: boolean;
}) {
  const [state, action, pending] = useActionState(setDeliverableDetailsAction, IDLE_STATE);
  const ids = { platform: useId(), commit: useId(), number: useId(), target: useId(), note: useId() };
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="deliverableId" value={deliverableId} />
      {showPlatform ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.platform} className={labelClass}>Platform</label>
          <select id={ids.platform} name="platform" defaultValue={current.platform ?? ''} className={selectClass}>
            <option value="">Not set</option>
            {PROTOTYPE_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.commit} className={labelClass}>Commit or ref built from</label>
        <input id={ids.commit} name="commitRef" defaultValue={current.commitRef ?? ''} maxLength={200} className={inputClass} placeholder="a1b2c3d or release/1.4" />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.number} className={labelClass}>Build number</label>
        <input id={ids.number} name="buildNumber" defaultValue={current.buildNumber ?? ''} maxLength={60} className={inputClass} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.target} className={labelClass}>Roll back to</label>
        <select id={ids.target} name="rollbackTargetId" defaultValue={current.rollbackTargetId ?? ''} className={selectClass}>
          <option value="">No rollback target recorded</option>
          {rollbackChoices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <label htmlFor={ids.note} className={labelClass}>How to roll back</label>
        <input id={ids.note} name="rollbackNote" defaultValue={current.rollbackNote ?? ''} maxLength={1000} className={inputClass} placeholder="Redeploy the target build; no migration to undo" />
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Save Details'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

/** Admin confirms or sends the prototype back — two submit buttons on one form. */
export function PrototypeAdminForm({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  const [state, action, pending] = useActionState(decidePrototypeAdminAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="deliverableId" value={deliverableId} />
      <label htmlFor={id} className={labelClass}>Admin note (required when asking for changes)</label>
      <textarea id={id} name="note" rows={2} maxLength={1000} className={textareaClass} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" name="decision" value="approved" disabled={pending} className={buttonClass('primary', 'sm')}>
          Approve as Admin
        </button>
        <button type="submit" name="decision" value="changes_required" disabled={pending} className={buttonClass('secondary', 'sm')}>
          Ask for Changes
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

/**
 * Send for client review. On the normal path the button is offered only when
 * QA passed and Admin approved (the page passes `blockers`; the database
 * refuses regardless). The owner gets an override with a mandatory reason.
 */
export function SendPrototypeForm({
  projectId,
  deliverableId,
  blockers,
  mayOverride,
}: {
  projectId: string;
  deliverableId: string;
  blockers: string[];
  mayOverride: boolean;
}) {
  const [state, action, pending] = useActionState(sendPrototypeAction, IDLE_STATE);
  const id = useId();
  const open = blockers.length === 0;
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="deliverableId" value={deliverableId} />
      {open ? null : (
        <>
          <ul className="list-disc pl-5 text-[13px] text-warning">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          {mayOverride ? (
            <>
              <label htmlFor={id} className={labelClass}>Owner override — why it goes to the client anyway</label>
              <input id={id} name="overrideReason" required maxLength={500} className={inputClass} />
            </>
          ) : (
            <p className="text-xs text-muted">It cannot go to the client until both are done. Only the owner can send it around this gate, with a reason.</p>
          )}
        </>
      )}
      {open || mayOverride ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={pending} className={buttonClass(open ? 'primary' : 'secondary', 'sm')}>
            {pending ? 'Sending…' : open ? 'Send for Client Review' : 'Send Anyway (Owner Override)'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </div>
      ) : (
        <FormMessage status={state.status} message={state.message} />
      )}
    </form>
  );
}

/** A person's QA check on a prototype: passed, or changes required, with the evidence they looked at. */
export function PrototypeQaForm({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  const [state, action, pending] = useActionState(recordPrototypeQaAction, IDLE_STATE);
  const noteId = useId();
  const urlId = useId();
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="deliverableId" value={deliverableId} />
      <label htmlFor={noteId} className={labelClass}>What was checked (required when asking for changes)</label>
      <textarea id={noteId} name="note" rows={2} maxLength={1000} className={textareaClass} />
      <label htmlFor={urlId} className={labelClass}>Evidence link (optional, https)</label>
      <input id={urlId} name="evidenceUrl" type="url" maxLength={2000} className={inputClass} placeholder="https://…" />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" name="outcome" value="passed" disabled={pending} className={buttonClass('primary', 'sm')}>
          QA Passed
        </button>
        <button type="submit" name="outcome" value="changes_required" disabled={pending} className={buttonClass('secondary', 'sm')}>
          QA: Changes Required
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
