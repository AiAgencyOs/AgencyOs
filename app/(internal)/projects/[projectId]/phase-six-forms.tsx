'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { phaseSixDoorAction } from '@/modules/projects/phase-six-actions';
import { buttonClass } from '@/ui';

/**
 * One generic form over the whitelisted Phase 6 doors. It decides nothing: the database door refuses (independence, gates, state, role) and its
 * refusal is shown as written. The door name is a hidden field, but the server action only accepts names from its own table.
 */

export type DoorField =
  | { kind: 'text' | 'textarea' | 'number'; name: string; label: string; placeholder?: string; required?: boolean; defaultValue?: string }
  | { kind: 'select'; name: string; label: string; options: [string, string][]; defaultValue?: string }
  | { kind: 'checkboxes'; name: string; label: string; options: [string, string][] };

const field = 'rounded-md border border-line bg-surface px-2 py-1';

export function DoorForm({
  door,
  projectId,
  hidden = {},
  fields = [],
  submit,
  intro,
  tone = 'secondary',
}: {
  door: string;
  projectId: string;
  hidden?: Record<string, string>;
  fields?: DoorField[];
  submit: string;
  intro?: string;
  tone?: 'primary' | 'secondary';
}) {
  const [state, action, pending] = useActionState(phaseSixDoorAction, IDLE_STATE);
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
            <select key={f.name} aria-label={f.label} name={f.name} defaultValue={f.defaultValue ?? f.options[0]?.[0]} className={field}>
              {f.options.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          );
        }
        if (f.kind === 'checkboxes') {
          return (
            <fieldset key={f.name} className="flex flex-wrap gap-3 text-[13px]">
              <legend className="text-xs text-muted">{f.label}</legend>
              {f.options.map(([value, label]) => (
                <label key={value} className="flex items-center gap-1">
                  <input type="checkbox" name={f.name} value={value} defaultChecked /> {label}
                </label>
              ))}
            </fieldset>
          );
        }
        if (f.kind === 'textarea') {
          return <textarea key={f.name} aria-label={f.label} name={f.name} rows={2} required={f.required} defaultValue={f.defaultValue} placeholder={f.placeholder ?? f.label} className={field} />;
        }
        return <input key={f.name} aria-label={f.label} name={f.name} type={f.kind} required={f.required} defaultValue={f.defaultValue} placeholder={f.placeholder ?? f.label} className={field} />;
      })}
      <button type="submit" disabled={pending} className={tone === 'primary' ? buttonClass() : buttonClass('secondary', 'sm')}>
        {pending ? 'Working…' : submit}
      </button>
      {state.status !== 'idle' && state.message ? (
        <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
