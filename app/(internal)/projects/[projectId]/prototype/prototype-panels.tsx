'use client';

import { useActionState } from 'react';

import { setPrototypePlatformAction, submitPrototypeToQaAction } from '@/modules/projects/prototype-actions';
import { PROTOTYPE_PLATFORMS } from '@/modules/projects/prototype-schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, selectClass } from '@/ui';

/** SCR-037 — the platform picker and "Submit to QA" on a prototype build (migration 20261001130000). */

export function PlatformPicker({ projectId, artifactId, current }: { projectId: string; artifactId: string; current: string | null }) {
  const [state, action, pending] = useActionState(setPrototypePlatformAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="artifactId" value={artifactId} />
      <select name="platform" defaultValue={current ?? ''} className={selectClass} aria-label="Platform">
        <option value="" disabled>
          Platform…
        </option>
        {PROTOTYPE_PLATFORMS.map((p) => (
          <option key={p} value={p}>
            {p.replace('_', ' ')}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Set'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function SubmitToQaButton({ projectId, artifactId }: { projectId: string; artifactId: string }) {
  const [state, action, pending] = useActionState(submitPrototypeToQaAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="artifactId" value={artifactId} />
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Submitting…' : 'Submit to QA'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
