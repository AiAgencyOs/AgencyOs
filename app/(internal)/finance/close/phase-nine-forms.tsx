'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { phaseNineDoorAction } from '@/modules/finance/phase-nine-actions';
import { FormMessage, buttonClass } from '@/ui';

/**
 * One generic form over the whitelisted Phase 9 doors. It decides nothing: the database door refuses (role, state, separation of duties, gates) and its
 * refusal is shown as written. The door name is a hidden field, but the server action only accepts names from its own table - and that table has no
 * door that verifies a payment, records a refund, edits an invoice or an amount, or sends a message.
 */

export type DoorField =
  | { kind: 'text' | 'textarea'; name: string; label: string; placeholder?: string; required?: boolean; defaultValue?: string }
  | { kind: 'date'; name: string; label: string; placeholder?: string; required?: boolean; defaultValue?: string }
  | { kind: 'select'; name: string; label: string; options: [string, string][]; defaultValue?: string };

const field = 'rounded-md border border-line bg-surface px-2 py-1 text-[13px]';

export function PhaseNineForm({
  door,
  hidden = {},
  fields = [],
  submit,
  intro,
  tone = 'secondary',
}: {
  door: string;
  hidden?: Record<string, string>;
  fields?: DoorField[];
  submit: string;
  intro?: string;
  tone?: 'primary' | 'secondary';
}) {
  const [state, action, pending] = useActionState(phaseNineDoorAction, IDLE_STATE);
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
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          );
        }
        if (f.kind === 'textarea') {
          return <textarea key={f.name} aria-label={f.label} name={f.name} placeholder={f.placeholder ?? f.label} required={f.required} defaultValue={f.defaultValue} rows={2} className={field} />;
        }
        return <input key={f.name} aria-label={f.label} type={f.kind} name={f.name} placeholder={f.placeholder ?? f.label} required={f.required} defaultValue={f.defaultValue} className={field} />;
      })}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass(tone, 'sm')}>{pending ? 'Working...' : submit}</button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
