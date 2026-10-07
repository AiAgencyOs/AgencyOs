'use client';

import { useActionState } from 'react';

import { IDLE_STATE, type FormState } from '@/modules/identity/types';
import { decideSmokeFailureAction, reportSmokeFailureAction } from '@/modules/projects/maintenance-smoke-actions';
import { buttonClass } from '@/ui';

const field = 'rounded-md border border-line bg-surface px-2 py-1 text-[13px]';

function Status({ state }: { state: FormState }) {
  if (state.status === 'idle' || !state.message) return null;
  return <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">{state.message}</p>;
}

export function ReportSmokeFailureForm({ projectId, items }: { projectId: string; items: { id: string; title: string }[] }) {
  const [state, run, pending] = useActionState(reportSmokeFailureAction, IDLE_STATE);
  return (
    <form action={run} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex flex-col gap-1 text-[13px] text-muted">Released change
        <select name="workItemId" className={field} required>{items.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}</select>
      </label>
      <label className="flex flex-col gap-1 text-[13px] text-muted">Evidence reference (a run id or link, never a secret)
        <input name="evidenceRef" className={field} required maxLength={500} />
      </label>
      <label className="flex flex-col gap-1 text-[13px] text-muted">What failed
        <textarea name="reason" className={field} required maxLength={2000} rows={2} />
      </label>
      <label className="flex flex-col gap-1 text-[13px] text-muted">Severity
        <select name="severity" className={field} defaultValue="major"><option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option></select>
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>Record smoke failure</button>
      <Status state={state} />
    </form>
  );
}

export function DecideSmokeFailureForm({ projectId, failureId }: { projectId: string; failureId: string }) {
  const [state, run, pending] = useActionState(decideSmokeFailureAction, IDLE_STATE);
  return (
    <form action={run} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="failureId" value={failureId} />
      <label className="flex flex-col gap-1 text-[13px] text-muted">Decision (recorded; AgencyOS rolls nothing back)
        <select name="decision" className={field} required>
          <option value="rollback_executed">Rollback was carried out elsewhere</option>
          <option value="forward_fix">Fix forward</option>
          <option value="false_alarm">False alarm</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[13px] text-muted">Note
        <textarea name="note" className={field} required maxLength={2000} rows={2} />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>Record decision</button>
      <Status state={state} />
    </form>
  );
}
