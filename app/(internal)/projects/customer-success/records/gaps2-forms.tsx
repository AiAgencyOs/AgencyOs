'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { phaseEightGaps2DoorAction } from '@/modules/projects/phase-eight-gaps2-actions';
import { buttonClass } from '@/ui';

/**
 * One generic form over the whitelisted second-half doors. It decides nothing: the database door refuses (role, state, tenant) and its refusal is shown as
 * written. Nothing it submits sends anything to a client.
 */

export type Gaps2Field =
  | { kind: 'text' | 'textarea' | 'number'; name: string; label: string; required?: boolean }
  | { kind: 'select'; name: string; label: string; options: [string, string][] };

const field = 'rounded-md border border-line bg-surface px-2 py-1';

export function Gaps2Form({ door, hidden = {}, fields, submit, intro }: { door: string; hidden?: Record<string, string>; fields: Gaps2Field[]; submit: string; intro?: string }) {
  const [state, action, pending] = useActionState(phaseEightGaps2DoorAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      {intro ? <p className="text-[13px] text-muted">{intro}</p> : null}
      <input type="hidden" name="door" value={door} />
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {fields.map((f) =>
        f.kind === 'select' ? (
          <select key={f.name} aria-label={f.label} name={f.name} defaultValue={f.options[0]?.[0]} className={field}>
            {f.options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        ) : f.kind === 'textarea' ? (
          <textarea key={f.name} aria-label={f.label} name={f.name} rows={3} required={f.required} placeholder={f.label} className={field} />
        ) : (
          <input key={f.name} aria-label={f.label} name={f.name} type={f.kind} required={f.required} placeholder={f.label} className={field} />
        ),
      )}
      <button type="submit" disabled={pending} className={buttonClass('secondary')}>
        {pending ? 'Saving…' : submit}
      </button>
      {state.status !== 'idle' ? (
        <p role="status" className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
