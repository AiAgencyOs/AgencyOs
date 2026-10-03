'use client';

import { useActionState } from 'react';

import { IDLE_STATE, type FormState } from '@/modules/identity/types';
import { linkDesignAssetAction, unlinkDesignAssetAction } from '@/modules/projects/screen-actions';
import { buttonClass, selectClass } from '@/ui';

/**
 * SCR-038 — link a reference asset to a screen or a UI version
 * (`projects.design_asset_links`, migration 20260929200000). Shown on the
 * Design overview's asset folders and on a screen's detail. `project.write`
 * on the door, `core.can_manage_delivery()` in the row policy.
 */

function Message({ state }: { state: FormState }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
      {state.message}
    </p>
  );
}

export type LinkTarget = { value: string; label: string };

/**
 * `assetId` fixed and targets chosen (asset folders), or `targets` fixed to
 * one screen and the asset chosen (screen detail) — both through one door.
 */
export function LinkAssetForm({
  projectId,
  assetId,
  targets,
  assets,
  fixedTarget,
}: {
  projectId: string;
  assetId?: string;
  targets?: LinkTarget[];
  assets?: { id: string; label: string }[];
  fixedTarget?: string;
}) {
  const [state, action, pending] = useActionState(linkDesignAssetAction, IDLE_STATE);

  const nothingToPick = (assetId && (targets ?? []).length === 0) || (fixedTarget && (assets ?? []).length === 0);
  if (nothingToPick) {
    return <p className="text-xs text-muted">{assetId ? 'No screen or UI version to link to yet.' : 'Every reference asset is already linked here, or none has been generated.'}</p>;
  }

  return (
    <form action={action} className="flex flex-col gap-1.5">
      <input type="hidden" name="projectId" value={projectId} />
      {assetId ? <input type="hidden" name="assetId" value={assetId} /> : null}
      {fixedTarget ? <input type="hidden" name="target" value={fixedTarget} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {assetId ? (
          <select name="target" required aria-label="Link to" className={`${selectClass} !h-8 min-w-[12rem] !text-xs`}>
            {(targets ?? []).map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        ) : (
          <select name="assetId" required aria-label="Asset" className={`${selectClass} !h-8 min-w-[16rem] !text-xs`}>
            {(assets ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        )}
        <button type="submit" disabled={pending} className={buttonClass('secondary')}>
          Link
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function UnlinkAssetForm({ projectId, linkId, screenId }: { projectId: string; linkId: string; screenId?: string }) {
  const [state, action, pending] = useActionState(unlinkDesignAssetAction, IDLE_STATE);

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="linkId" value={linkId} />
      {screenId ? <input type="hidden" name="screenId" value={screenId} /> : null}
      <button type="submit" disabled={pending} className="text-xs text-muted underline hover:text-foreground">
        Unlink
      </button>
      <Message state={state} />
    </form>
  );
}
