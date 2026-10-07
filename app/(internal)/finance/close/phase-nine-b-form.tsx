'use client';

import { useActionState } from 'react';

import { phaseNineBDoorAction } from '@/modules/finance/phase-nine-b-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass } from '@/ui';

/** One generic form over the whitelisted Phase 9B doors. It decides nothing: the database door refuses and its refusal is shown as written. */

export type BField =
  | { kind: 'text' | 'date' | 'number'; name: string; label: string; required?: boolean; defaultValue?: string }
  | { kind: 'select'; name: string; label: string; options: [string, string][]; defaultValue?: string };

const field = 'rounded-md border border-line bg-surface px-2 py-1 text-[13px]';

export function PhaseNineBForm({ door, hidden = {}, fields = [], submit, intro }: { door: string; hidden?: Record<string, string>; fields?: BField[]; submit: string; intro?: string }) {
  const [state, action, pending] = useActionState(phaseNineBDoorAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      {intro ? <p className="text-[13px] text-muted">{intro}</p> : null}
      <input type="hidden" name="door" value={door} />
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {fields.map((f) =>
        f.kind === 'select' ? (
          <select key={f.name} aria-label={f.label} name={f.name} defaultValue={f.defaultValue ?? f.options[0]?.[0]} className={field}>
            {f.options.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        ) : (
          <input key={f.name} aria-label={f.label} type={f.kind} name={f.name} placeholder={f.label} required={f.required} defaultValue={f.defaultValue} className={field} />
        ),
      )}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Working...' : submit}</button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
