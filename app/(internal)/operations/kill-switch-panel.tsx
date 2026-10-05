'use client';

import { useActionState } from 'react';

import { KILL_SWITCH_EFFECT, KILL_SWITCH_LABEL, type KillSwitchRow } from '@/lib/observability/kill-switch-types';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, FormMessage, buttonClass, inputClass } from '@/ui';

import { setKillSwitchAction } from './kill-switch-actions';

/**
 * Emergency controls — SCR-068. Four switches, each with what it does
 * written beside it, a reason required either way, and the audit trail as
 * the record. Drawn with controls for the owner alone; everyone else sees
 * the state and who set it.
 */
export type KillSwitchView = KillSwitchRow & { setAtLabel: string | null };

function SwitchForm({ row }: { row: KillSwitchView }) {
  const [state, action, pending] = useActionState(setKillSwitchAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="switch" value={row.switch} />
      <input type="hidden" name="active" value={row.active ? 'false' : 'true'} />
      <input name="reason" required maxLength={500} placeholder={row.active ? 'why release it' : 'why engage it'} aria-label={`Reason for ${row.active ? 'releasing' : 'engaging'} ${KILL_SWITCH_LABEL[row.switch]}`} className={`${inputClass} h-8 w-56 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass(row.active ? 'secondary' : 'danger', 'sm')}>
        {pending ? '…' : row.active ? 'Release' : 'Engage'}
      </button>
      <FormMessage status={state.status} message={state.message} className="basis-full text-xs" />
    </form>
  );
}

export function KillSwitchPanel({ switches, editable }: { switches: KillSwitchView[]; editable: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {switches.map((row) => (
        <li key={row.switch} className="flex flex-col gap-2 px-4 py-3 text-[13px] sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{KILL_SWITCH_LABEL[row.switch]}</span>
              <Badge tone={row.active ? 'danger' : 'success'} dot>
                {row.active ? 'engaged' : 'released'}
              </Badge>
            </span>
            {row.active ? (
              <span className="text-xs text-muted">
                by {row.setByName ?? 'unknown'} {row.setAtLabel ?? ''} — “{row.reason}”
              </span>
            ) : row.setAtLabel ? (
              <span className="text-xs text-muted">last released {row.setAtLabel}</span>
            ) : null}
          </div>
          <p className="text-xs text-muted">{KILL_SWITCH_EFFECT[row.switch]}</p>
          {editable ? <SwitchForm row={row} /> : null}
        </li>
      ))}
    </ul>
  );
}
