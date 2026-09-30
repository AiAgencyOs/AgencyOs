'use client';

import { useActionState } from 'react';

import { submitDeliverableAction } from '@/modules/projects/actions';
import { markDesignAssetApprovedAction, uploadDesignAssetAction } from '@/modules/projects/design-asset-actions';
import { DESIGN_ASSET_KINDS } from '@/modules/projects/design-asset-schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, Callout, FormMessage, inputClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-032/033/038 — the design asset lifecycle's controls (migration
 * 20261001130000): upload a first version or a replacement, mark a version
 * approved, and submit the design deliverable for review. Thin wrappers
 * over the server actions; every refusal is shown verbatim. Each control is
 * gated on storage being reachable: an upload button over an unreachable
 * bucket is the one lie this surface must not tell.
 */

export function UploadDesignAssetPanel({
  projectId,
  storage,
  fixedKind,
  parentAssetId,
  compact,
}: {
  projectId: string;
  storage: { reachable: boolean; reason: string | null };
  /** When set, the kind is fixed (the Color studio's reference uploads). */
  fixedKind?: (typeof DESIGN_ASSET_KINDS)[number];
  /** When set, this upload replaces that first version with a new version. */
  parentAssetId?: string;
  compact?: boolean;
}) {
  const [state, action, pending] = useActionState(uploadDesignAssetAction, IDLE_STATE);

  if (!storage.reachable) {
    return (
      <Callout tone="warning" title="Storage is not reachable, so nothing can be uploaded.">
        {storage.reason}
      </Callout>
    );
  }

  return (
    <form action={action} className={compact ? 'flex flex-wrap items-end gap-2' : 'flex flex-col gap-3'}>
      <input type="hidden" name="projectId" value={projectId} />
      {parentAssetId ? <input type="hidden" name="parentAssetId" value={parentAssetId} /> : null}
      {fixedKind ? (
        <input type="hidden" name="kind" value={fixedKind} />
      ) : (
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Kind</span>
          <select name="kind" className={selectClass} defaultValue="visual_asset">
            {DESIGN_ASSET_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
      )}
      {!parentAssetId ? (
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Title</span>
          <input name="title" maxLength={200} className={inputClass} placeholder="Optional — the file name otherwise" />
        </label>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className={labelClass}>{parentAssetId ? 'New version' : 'File'}</span>
        <input name="file" type="file" required accept="image/png,image/jpeg,image/webp,image/svg+xml,application/pdf" className={inputClass} />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass(parentAssetId ? 'secondary' : 'primary', 'sm')}>
          {pending ? 'Uploading…' : parentAssetId ? 'Replace with a new version' : 'Upload design'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
      {!compact ? <p className="text-xs text-muted">PNG, JPEG, WebP, SVG or PDF up to 50 MB, into the project-files bucket. Uploaded as a draft; approve it below once reviewed.</p> : null}
    </form>
  );
}

export function ApproveAssetButton({ projectId, assetId }: { projectId: string; assetId: string }) {
  const [state, action, pending] = useActionState(markDesignAssetApprovedAction, IDLE_STATE);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="assetId" value={assetId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Approving…' : 'Mark approved'}
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

/**
 * SCR-032 "Submit for review" on the overview — the design deliverable's
 * own door (`projects.submit_deliverable`, the same one the Overview tab
 * uses), offered for the newest draft design version. Nothing new
 * underneath: the approval policy names the reviewer.
 */
export function SubmitDesignReviewPanel({ projectId, deliverable }: { projectId: string; deliverable: { id: string; version: number; title: string } | null }) {
  const [state, action, pending] = useActionState(submitDeliverableAction, IDLE_STATE);
  if (!deliverable) {
    return <p className="text-[13px] text-muted">No draft design version to submit. Record one on the Overview tab, then submit it here.</p>;
  }
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="deliverableId" value={deliverable.id} />
      <span className="text-[13px]">
        Design v{deliverable.version} — {deliverable.title}
      </span>
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Submitting…' : 'Submit for review'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
