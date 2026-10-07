'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { p789RoundTwoAction } from '@/modules/projects/p789-round2-actions';
import { buttonClass } from '@/ui';

/**
 * One generic form over the whitelisted round-two doors. It decides nothing: the database door refuses (role, state, tenant) and its refusal is shown as
 * written. The door name is a hidden field, but the server action only accepts names from its own table. Nothing it submits sends anything to a client.
 */

export type P789Field =
  | { kind: 'text' | 'textarea' | 'number' | 'date'; name: string; label: string; placeholder?: string; required?: boolean; defaultValue?: string }
  | { kind: 'select'; name: string; label: string; options: [string, string][]; defaultValue?: string }
  | { kind: 'checkbox'; name: string; label: string };

const field = 'rounded-md border border-line bg-surface px-2 py-1';

export function P789DoorForm({ door, hidden = {}, fields = [], submit, intro }: { door: string; hidden?: Record<string, string>; fields?: P789Field[]; submit: string; intro?: string }) {
  const [state, action, pending] = useActionState(p789RoundTwoAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      {intro ? <p className="text-[13px] text-muted">{intro}</p> : null}
      <input type="hidden" name="door" value={door} />
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
        if (f.kind === 'checkbox') {
          return (
            <label key={f.name} className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" name={f.name} />
              {f.label}
            </label>
          );
        }
        if (f.kind === 'textarea') {
          return <textarea key={f.name} aria-label={f.label} name={f.name} rows={3} required={f.required} defaultValue={f.defaultValue} placeholder={f.placeholder ?? f.label} className={field} />;
        }
        return (
          <label key={f.name} className="flex flex-col gap-0.5 text-xs text-muted">
            {f.kind === 'date' ? f.label : null}
            <input aria-label={f.label} name={f.name} type={f.kind} required={f.required} defaultValue={f.defaultValue} placeholder={f.placeholder ?? f.label} className={field} />
          </label>
        );
      })}
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Working...' : submit}
      </button>
      {state.status !== 'idle' && state.message ? (
        <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
