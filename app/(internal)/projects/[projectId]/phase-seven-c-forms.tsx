'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { phaseSevenCDoorAction } from '@/modules/projects/phase-seven-c-actions';
import { buttonClass, FormMessage } from '@/ui';

/**
 * One generic form over the two whitelisted Phase 7c doors (raise a client action request; confirm, send back or cancel one). It decides nothing: the database
 * door refuses (role, the deadline, secrets, a person's own verification) and its refusal is shown as written.
 */

export type SevenCField =
  | { kind: 'text' | 'textarea' | 'datetime-local'; name: string; label: string; required?: boolean }
  | { kind: 'select'; name: string; label: string; options: [string, string][] };

const field = 'rounded-md border border-line bg-surface px-2 py-1';

export function SevenCForm({ door, projectId, hidden = {}, fields = [], submit, intro }: { door: string; projectId: string; hidden?: Record<string, string>; fields?: SevenCField[]; submit: string; intro?: string }) {
  const [state, action, pending] = useActionState(phaseSevenCDoorAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      {intro ? <p className="text-[13px] text-muted">{intro}</p> : null}
      <input type="hidden" name="door" value={door} />
      <input type="hidden" name="projectId" value={projectId} />
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {fields.map((f) => {
        if (f.kind === 'select') {
          return (
            <select key={f.name} aria-label={f.label} name={f.name} defaultValue={f.options[0]?.[0]} className={field}>
              {f.options.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          );
        }
        if (f.kind === 'textarea') return <textarea key={f.name} aria-label={f.label} placeholder={f.label} name={f.name} rows={2} required={f.required} className={field} />;
        return <input key={f.name} aria-label={f.label} placeholder={f.label} name={f.name} type={f.kind} required={f.required} className={field} />;
      })}
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Working...' : submit}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
