'use client';

import { useActionState } from 'react';

import { addDeliverableAction, submitDeliverableAction } from '@/modules/projects/actions';
import { DELIVERABLE_KINDS } from '@/modules/projects/schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, inputClass, selectClass } from '@/ui';

/**
 * Adding a version, and sending one to the client — Phase 12.
 *
 * Two controls, deliberately separate. Adding a version is internal and
 * cheap; sending one reaches a client and raises an approval somebody then
 * owes an answer on. A single control that did both on a tickbox is how a
 * half-finished design ends up in front of a customer.
 *
 * The form never edits: there is no field for changing an existing version,
 * because an approval names a version and rewriting one would make the
 * approval refer to something that no longer exists. A revision is v+1.
 */

export function AddDeliverableForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(addDeliverableAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />

      <div className="flex flex-wrap gap-2">
        <select
          name="kind"
          required
          aria-label="Kind"
          className={selectClass}
        >
          {DELIVERABLE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>

        <input
          name="title"
          required
          maxLength={200}
          placeholder="What this version is"
          className={`${inputClass} min-w-48 flex-1`}
        aria-label="Version title" />
      </div>

      <input
        name="artifactUrl"
        type="url"
        placeholder="Link to the file, build or design (optional)"
        className={inputClass}
      aria-label="Artifact link" />

      <input
        name="changelog"
        placeholder="What changed since the last version (optional)"
        className={inputClass}
      aria-label="What changed since the last version" />

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className={buttonClass('secondary', 'sm', 'self-start')}
        >
          {pending ? 'Adding…' : 'Add version'}
        </button>

        {state.status !== 'idle' ? (
          <p
            role="status"
            className={`text-sm ${state.status === 'error' ? 'text-danger' : 'text-muted'}`}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

export function SubmitDeliverableForm({
  deliverableId,
  projectId,
}: {
  deliverableId: string;
  projectId: string;
}) {
  const [state, action, pending] = useActionState(submitDeliverableAction, IDLE_STATE);

  return (
    <form action={action} className="mt-2 flex items-center gap-3">
      <input type="hidden" name="deliverableId" value={deliverableId} />
      <input type="hidden" name="projectId" value={projectId} />

      <button
        type="submit"
        disabled={pending}
        className={buttonClass('secondary', 'sm')}
      >
        {pending ? 'Sending…' : 'Send for client review'}
      </button>

      {state.status !== 'idle' ? (
        <p
          role="status"
          className={`text-xs ${state.status === 'error' ? 'text-danger' : 'text-muted'}`}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
