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

/**
 * The same add-a-version form, scoped to one kind — SCR-037's Prototype
 * Builds screen. `kind` is a hidden field rather than the generic form's
 * select: this page is already "the prototype list", and a visible selector
 * that could add a design version to it would contradict its own title.
 */
export function AddPrototypeForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(addDeliverableAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="kind" value="prototype" />

      <input
        name="title"
        required
        maxLength={200}
        placeholder="What this build is"
        className={inputClass}
        aria-label="Version title"
      />

      <input
        name="artifactUrl"
        type="url"
        placeholder="Link to the build (optional)"
        className={inputClass}
        aria-label="Artifact link"
      />

      <input
        name="changelog"
        placeholder="What changed since the last build (optional)"
        className={inputClass}
        aria-label="What changed since the last build"
      />

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm', 'self-start')}>
          {pending ? 'Adding…' : 'Add build'}
        </button>
        {state.status !== 'idle' ? (
          <p role="status" className={`text-sm ${state.status === 'error' ? 'text-danger' : 'text-muted'}`}>
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** The same scoped form as `AddPrototypeForm`, for `kind = 'build'` — SCR-043's Builds half. */
export function AddBuildForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(addDeliverableAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="kind" value="build" />

      <input
        name="title"
        required
        maxLength={200}
        placeholder="What this build is"
        className={inputClass}
        aria-label="Version title"
      />

      <input
        name="artifactUrl"
        type="url"
        placeholder="Link to the build (optional)"
        className={inputClass}
        aria-label="Artifact link"
      />

      <input
        name="changelog"
        placeholder="What changed since the last build (optional)"
        className={inputClass}
        aria-label="What changed since the last build"
      />

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm', 'self-start')}>
          {pending ? 'Adding…' : 'Add build'}
        </button>
        {state.status !== 'idle' ? (
          <p role="status" className={`text-sm ${state.status === 'error' ? 'text-danger' : 'text-muted'}`}>
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
