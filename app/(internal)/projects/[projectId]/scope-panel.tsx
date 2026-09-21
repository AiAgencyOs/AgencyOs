'use client';

import { useActionState } from 'react';

import {
  addScopeItemAction,
  freezeScopeVersionAction,
  openScopeVersionAction,
  removeScopeItemAction,
} from '@/modules/projects/actions';
import { SCOPE_ITEM_INCLUSIONS } from '@/modules/projects/schema';
import type { ScopeVersionRow } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/**
 * The scope baseline (Doc 11) — draft, fill, freeze. `open_scope_version` /
 * `freeze_scope_version` existed; `add_scope_item` / `remove_scope_item`
 * (20260921160000) did not, so a version could be opened and never filled —
 * `freeze_scope_version` refuses `empty` with nothing able to make it
 * non-empty. This panel is the first thing that has ever called any of the
 * four doors.
 */

const INCLUSION_TONE: Record<string, 'success' | 'danger' | 'neutral'> = {
  included: 'success',
  excluded: 'danger',
  optional: 'neutral',
};

export function OpenScopeVersionForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(openScopeVersionAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <button type="submit" disabled={pending} className={`${buttonClass('primary', 'sm')} self-start`}>
        {pending ? 'Opening…' : 'Open a scope draft'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function AddItemForm({ projectId, scopeVersionId }: { projectId: string; scopeVersionId: string }) {
  const [state, action, pending] = useActionState(addScopeItemAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="scopeVersionId" value={scopeVersionId} />
      <div className="flex flex-wrap gap-2">
        <div className="flex min-w-40 flex-1 flex-col gap-1">
          <label className={labelClass}>Title</label>
          <input name="title" required maxLength={200} className={inputClass} placeholder="User login" />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Inclusion</label>
          <select name="inclusion" defaultValue="included" className={selectClass}>
            {SCOPE_ITEM_INCLUSIONS.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className={labelClass}>Detail (optional)</label>
        <input name="detail" maxLength={4000} className={inputClass} />
      </div>
      <div className="flex flex-col gap-1">
        <label className={labelClass}>Acceptance criteria (optional)</label>
        <input name="acceptanceCriteria" maxLength={2000} className={inputClass} />
      </div>
      <button type="submit" disabled={pending} className={`${buttonClass('secondary', 'sm')} self-start`}>
        {pending ? 'Adding…' : 'Add item'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function RemoveItemButton({ projectId, scopeItemId }: { projectId: string; scopeItemId: string }) {
  const [state, action, pending] = useActionState(removeScopeItemAction, IDLE_STATE);

  return (
    <form action={action} className="inline-flex items-center gap-1">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="scopeItemId" value={scopeItemId} />
      <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
        Remove
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

function FreezeButton({ projectId, scopeVersionId }: { projectId: string; scopeVersionId: string }) {
  const [state, action, pending] = useActionState(freezeScopeVersionAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="scopeVersionId" value={scopeVersionId} />
      <button type="submit" disabled={pending} className={`${buttonClass('primary', 'sm')} self-start`}>
        {pending ? 'Freezing…' : 'Freeze this baseline'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function ScopeVersionCard({
  projectId,
  scopeVersion,
  editable,
}: {
  projectId: string;
  scopeVersion: ScopeVersionRow;
  editable: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          v{scopeVersion.version}
          <Badge tone={scopeVersion.status === 'active' ? 'success' : 'neutral'}>{scopeVersion.status}</Badge>
        </span>
        <span className="text-xs text-muted">{scopeVersion.source}</span>
      </div>

      {scopeVersion.items.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {scopeVersion.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className="font-medium">{item.title}</span>
                  <Badge tone={INCLUSION_TONE[item.inclusion] ?? 'neutral'}>{item.inclusion}</Badge>
                </span>
                {item.detail ? <span className="text-muted">{item.detail}</span> : null}
                {item.acceptanceCriteria ? (
                  <span className="text-xs text-muted">Accept: {item.acceptanceCriteria}</span>
                ) : null}
              </span>
              {editable ? <RemoveItemButton projectId={projectId} scopeItemId={item.id} /> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No items yet.</p>
      )}

      {editable ? (
        <>
          <AddItemForm projectId={projectId} scopeVersionId={scopeVersion.id} />
          {scopeVersion.items.length > 0 ? (
            <FreezeButton projectId={projectId} scopeVersionId={scopeVersion.id} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
