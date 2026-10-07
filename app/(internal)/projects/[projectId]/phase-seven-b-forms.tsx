'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { phaseSevenBDoorAction } from '@/modules/projects/phase-seven-b-actions';
import { buttonClass, FormMessage } from '@/ui';

/**
 * One generic form over the whitelisted Phase 7b doors (a portal request's settlement, a retention policy, the archive). It decides nothing: the database
 * door refuses (role, the exact version, a person's own verification) and its refusal is shown as written.
 */

export type SevenBField =
  | { kind: 'text' | 'textarea' | 'number'; name: string; label: string; required?: boolean }
  | { kind: 'select'; name: string; label: string; options: [string, string][] }
  | { kind: 'yesno'; name: string; label: string };

const field = 'rounded-md border border-line bg-surface px-2 py-1';

export function SevenBForm({ door, projectId, hidden = {}, fields = [], submit, intro }: { door: string; projectId: string; hidden?: Record<string, string>; fields?: SevenBField[]; submit: string; intro?: string }) {
  const [state, action, pending] = useActionState(phaseSevenBDoorAction, IDLE_STATE);
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
        if (f.kind === 'yesno') {
          return (
            <label key={f.name} className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" name={f.name} value="yes" /> {f.label}
            </label>
          );
        }
        if (f.kind === 'textarea') return <textarea key={f.name} aria-label={f.label} placeholder={f.label} name={f.name} rows={2} required={f.required} className={field} />;
        return <input key={f.name} aria-label={f.label} placeholder={f.label} name={f.name} type={f.kind === 'number' ? 'number' : 'text'} required={f.required} className={field} />;
      })}
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Working...' : submit}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
