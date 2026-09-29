'use client';

import { useActionState } from 'react';

import { openIncidentAction, resolveIncidentAction } from '@/modules/identity/incidents-actions';
import { INCIDENT_KINDS, INCIDENT_SEVERITIES } from '@/modules/identity/incidents-schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

/**
 * Open and resolve a security incident — SCR-069. "Investigate security
 * event" arrives here from the audit trail with the entry id prefilled, so
 * the incident names the evidence it started from. Owner and ops_admin; the
 * doors refuse everyone else and the refusal is shown as written.
 */
export function OpenIncidentForm({ auditEntryId, evidence }: { auditEntryId?: number; evidence?: string }) {
  const [state, action, pending] = useActionState(openIncidentAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-3 px-4 py-4 sm:px-5">
      {auditEntryId ? <input type="hidden" name="auditEntryId" value={String(auditEntryId)} /> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Kind</span>
          <select name="kind" defaultValue="suspicious_activity" className={selectClass}>
            {INCIDENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Severity</span>
          <select name="severity" defaultValue="medium" className={selectClass}>
            {INCIDENT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
          <span className={labelClass}>What happened</span>
          <input name="summary" required maxLength={1000} placeholder="One sentence a reader can act on" className={inputClass} />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Evidence</span>
        <textarea name="evidence" rows={2} maxLength={4000} defaultValue={evidence ?? ''} placeholder="Audit entry ids, run ids, what was seen — recorded as written" className={textareaClass} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Opening…' : 'Open incident'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}

export function ResolveIncidentForm({ incidentId }: { incidentId: string }) {
  const [state, action, pending] = useActionState(resolveIncidentAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="incidentId" value={incidentId} />
      <input name="resolution" required maxLength={2000} placeholder="how it was resolved" aria-label="Resolution" className={`${inputClass} h-7 w-64 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Resolving…' : 'Resolve'}
      </button>
      <FormMessage status={state.status} message={state.message} className="basis-full text-xs" />
    </form>
  );
}
