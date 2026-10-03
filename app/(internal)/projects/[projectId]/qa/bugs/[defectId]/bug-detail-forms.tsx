'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { addDefectEvidenceAction, linkDefectBuildAction } from '@/modules/qa/defect-detail-actions';
import { DEFECT_EVIDENCE_KINDS } from '@/modules/qa/defect-detail-schema';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-047 — the bug page's two new doors: attach evidence
 * (`qa.add_defect_evidence`) and link the build the fix lands in
 * (`qa.link_defect_build`). Triage and settle are the QA tab's own forms,
 * mounted on the page unchanged.
 */

export function AttachEvidenceForm({ projectId, defectId }: { projectId: string; defectId: string }) {
  const [state, action, pending] = useActionState(addDefectEvidenceAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="defectId" value={defectId} />
      <div className="flex flex-col gap-1">
        <label className={labelClass} htmlFor="evidence-kind">
          Kind
        </label>
        <select id="evidence-kind" name="kind" defaultValue="url" className={selectClass}>
          {DEFECT_EVIDENCE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k === 'url' ? 'link' : 'note'}
            </option>
          ))}
        </select>
      </div>
      <div className="flex min-w-56 flex-1 flex-col gap-1">
        <label className={labelClass} htmlFor="evidence-value">
          Link to a screenshot, recording or log — or a note
        </label>
        <input id="evidence-value" name="value" required maxLength={2000} className={inputClass} placeholder="https://… or what was seen" />
      </div>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Attaching…' : 'Attach evidence'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function LinkBuildForm({
  projectId,
  defectId,
  currentBuildId,
  builds,
}: {
  projectId: string;
  defectId: string;
  currentBuildId: string | null;
  builds: { id: string; version: number; title: string }[];
}) {
  const [state, action, pending] = useActionState(linkDefectBuildAction, IDLE_STATE);

  if (builds.length === 0) return <p className="text-xs text-muted">No build deliverable exists yet to link.</p>;

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="defectId" value={defectId} />
      <div className="flex min-w-48 flex-col gap-1">
        <label className={labelClass} htmlFor="defect-build">
          Build the fix lands in
        </label>
        <select id="defect-build" name="buildId" defaultValue={currentBuildId ?? ''} className={selectClass}>
          <option value="">No build</option>
          {builds.map((b) => (
            <option key={b.id} value={b.id}>
              v{b.version} — {b.title}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Linking…' : 'Link build'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
