'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { phaseEightDDoorAction } from '@/modules/projects/phase-eight-d-actions';
import { buttonClass } from '@/ui';

/**
 * One generic form over the whitelisted Phase 8D doors (communication governance and value-report drafts). It decides nothing: the database door
 * refuses (role, state, tenant) and its refusal is shown as written. The door name is a hidden field, but the server action only accepts names from its own table.
 * Nothing it submits sends anything to a client.
 */

export type DoorField =
  | { kind: 'text' | 'textarea' | 'number' | 'date' | 'datetime-local'; name: string; label: string; placeholder?: string; required?: boolean; defaultValue?: string }
  | { kind: 'select'; name: string; label: string; options: [string, string][]; defaultValue?: string };

const field = 'rounded-md border border-line bg-surface px-2 py-1';

export function DoorForm({
  door,
  clientId,
  hidden = {},
  fields = [],
  submit,
  intro,
  tone = 'secondary',
}: {
  door: string;
  clientId: string;
  hidden?: Record<string, string>;
  fields?: DoorField[];
  submit: string;
  intro?: string;
  tone?: 'primary' | 'secondary';
}) {
  const [state, action, pending] = useActionState(phaseEightDDoorAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      {intro ? <p className="text-[13px] text-muted">{intro}</p> : null}
      <input type="hidden" name="door" value={door} />
      <input type="hidden" name="clientId" value={clientId} />
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
        if (f.kind === 'textarea') {
          return <textarea key={f.name} aria-label={f.label} name={f.name} rows={3} required={f.required} defaultValue={f.defaultValue} placeholder={f.placeholder ?? f.label} className={field} />;
        }
        return (
          <label key={f.name} className="flex flex-col gap-0.5 text-xs text-muted">
            {f.kind === 'date' || f.kind === 'datetime-local' ? f.label : null}
            <input aria-label={f.label} name={f.name} type={f.kind} required={f.required} defaultValue={f.defaultValue} placeholder={f.placeholder ?? f.label} className={field} />
          </label>
        );
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
