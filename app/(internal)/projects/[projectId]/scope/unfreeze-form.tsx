'use client';

import { useActionState } from 'react';

import { unfreezeScopeVersionAction } from '@/modules/projects/scope-unfreeze-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { Callout, FormMessage, buttonClass, labelClass, textareaClass } from '@/ui';

/**
 * SCR-030 — the owner's unfreeze override. Rendered only for the owner and
 * only when the active baseline is the newest version; the door
 * (`projects.unfreeze_scope_version`) checks both again and refuses otherwise.
 */
export function UnfreezeScopeVersionForm({ projectId, scopeVersionId, version }: { projectId: string; scopeVersionId: string; version: number }) {
  const [state, action, pending] = useActionState(unfreezeScopeVersionAction, IDLE_STATE);

  return (
    <details className="rounded-lg border border-line bg-surface px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">Unfreeze v{version} (owner override)</summary>
      <form action={action} className="flex flex-col gap-3 pt-3">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="scopeVersionId" value={scopeVersionId} />
        <Callout tone="warning" title="This takes the delivery baseline away.">
          The test plan drafted against v{version} and any change request that cites it keep pointing at a
          version that is now editable. Use this only when the baseline was frozen by mistake and nothing has yet been
          built or argued against it; a real change to an agreed scope is a change request. The reason is written to the
          audit log with your name.
        </Callout>
        <div className="flex flex-col gap-1">
          <label htmlFor={`unfreeze-reason-${scopeVersionId}`} className={labelClass}>Why this baseline is being unfrozen</label>
          <textarea
            id={`unfreeze-reason-${scopeVersionId}`}
            name="reason"
            required
            minLength={10}
            maxLength={2000}
            rows={3}
            className={textareaClass}
            placeholder="Frozen before the client's last acceptance note was folded in; item 4's criteria are wrong."
          />
        </div>
        <button type="submit" disabled={pending} className={`${buttonClass('danger', 'sm')} self-start`}>
          {pending ? 'Unfreezing…' : `Unfreeze v${version}`}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </form>
    </details>
  );
}
