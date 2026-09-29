'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { recordScopeApprovalAction } from '@/modules/projects/scope-approval-actions';
import type { ScopeApproval } from '@/modules/projects/scope-approval-queries';
import { buttonClass, FormMessage, IconArrowUpRight, inputClass, labelClass, textareaClass } from '@/ui';

/**
 * SCR-030 — "Approval evidence" on a frozen baseline: who approved it (as
 * they signed), when, and a link to the evidence. Through
 * `projects.record_scope_approval_evidence`, which refuses a draft.
 */
export function ScopeApprovalPanel({ projectId, scopeVersionId, version, approval, approvedLabel, editable }: { projectId: string; scopeVersionId: string; version: number; approval: ScopeApproval | null; approvedLabel: string | null; editable: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(recordScopeApprovalAction, IDLE_STATE);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px]">
      <p className="font-medium">Approval evidence · v{version}</p>
      {approval?.approvedBy ? (
        <p className="flex flex-wrap items-center gap-2">
          <span>
            Approved by <span className="font-medium">{approval.approvedBy}</span>
            {approvedLabel ? <span className="text-muted"> · {approvedLabel}</span> : null}
          </span>
          {approval.evidenceUrl ? (
            <a href={approval.evidenceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-brand underline-offset-2 hover:underline">
              Evidence <IconArrowUpRight size={12} />
            </a>
          ) : (
            <span className="text-xs text-muted">no evidence link recorded</span>
          )}
        </p>
      ) : (
        <p className="text-muted">No approval recorded on this baseline yet. The frozen date says when it became the baseline, not that the client approved it.</p>
      )}
      {approval?.note ? <p className="text-xs text-muted">{approval.note}</p> : null}
      {editable ? (
        !open ? (
          <button type="button" onClick={() => setOpen(true)} className={`${buttonClass('secondary', 'sm')} self-start`}>
            {approval?.approvedBy ? 'Update approval evidence' : 'Record approval evidence'}
          </button>
        ) : (
          <form action={action} className="flex flex-col gap-2">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="scopeVersionId" value={scopeVersionId} />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Approved by (as they signed)</span>
                <input name="approvedBy" required maxLength={200} defaultValue={approval?.approvedBy ?? ''} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Evidence link (optional)</span>
                <input name="evidenceUrl" type="url" maxLength={2000} defaultValue={approval?.evidenceUrl ?? ''} className={inputClass} placeholder="https://…/signed-scope.pdf" />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Note (optional)</span>
              <textarea name="note" maxLength={1000} rows={2} defaultValue={approval?.note ?? ''} className={textareaClass} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
                {pending ? 'Recording…' : 'Record'}
              </button>
              <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
                Cancel
              </button>
              <FormMessage status={state.status} message={state.message} />
            </div>
          </form>
        )
      ) : null}
    </div>
  );
}
