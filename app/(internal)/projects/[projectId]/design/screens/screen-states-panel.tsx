'use client';

import { useActionState } from 'react';

import { setScreenStatesAction } from '@/modules/projects/screen-states-actions';
import { DEVICE_TARGETS } from '@/modules/projects/screen-states-schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass, textareaClass } from '@/ui';

/**
 * SCR-035 — "Add state" after creation, and the fields the PDF names on a
 * screen: role, device targets, components, responsive coverage. One form,
 * one door (`projects.set_screen_states`, migration 20261001130000),
 * audited with before and after; the refusal is shown verbatim.
 */
export function ScreenStatesPanel({
  projectId,
  screenId,
  current,
}: {
  projectId: string;
  screenId: string;
  current: {
    hasEmptyState: boolean;
    hasLoadingState: boolean;
    hasErrorState: boolean;
    hasSuccessState: boolean;
    userRole: string;
    deviceTargets: string[];
    components: string[];
    responsiveCoverage: Record<string, unknown>;
  };
}) {
  const [state, action, pending] = useActionState(setScreenStatesAction, IDLE_STATE);
  const states: { name: string; label: string; on: boolean }[] = [
    { name: 'hasEmptyState', label: 'Empty state', on: current.hasEmptyState },
    { name: 'hasLoadingState', label: 'Loading state', on: current.hasLoadingState },
    { name: 'hasErrorState', label: 'Error state', on: current.hasErrorState },
    { name: 'hasSuccessState', label: 'Success state', on: current.hasSuccessState },
  ];

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="screenId" value={screenId} />

      <fieldset className="flex flex-col gap-1">
        <legend className={labelClass}>States</legend>
        <div className="grid grid-cols-2 gap-1 text-[13px]">
          {states.map((s) => (
            <label key={s.name} className="flex items-center gap-2">
              <input type="checkbox" name={s.name} defaultChecked={s.on} /> {s.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1">
        <label className={labelClass}>User role</label>
        <input name="userRole" maxLength={100} defaultValue={current.userRole} className={inputClass} />
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className={labelClass}>Device targets</legend>
        <div className="flex flex-wrap gap-3 text-[13px]">
          {DEVICE_TARGETS.map((d) => (
            <label key={d} className="flex items-center gap-1.5">
              <input type="checkbox" name="deviceTargets" value={d} defaultChecked={current.deviceTargets.includes(d)} /> {d}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className={labelClass}>Responsive coverage — layouts drawn and checked</legend>
        <div className="flex flex-wrap gap-3 text-[13px]">
          {DEVICE_TARGETS.map((d) => (
            <label key={d} className="flex items-center gap-1.5">
              <input type="checkbox" name="responsiveCovered" value={d} defaultChecked={current.responsiveCoverage[d] === true} /> {d}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">Only a device in the targets counts; coverage is targets covered over all targets.</p>
      </fieldset>

      <div className="flex flex-col gap-1">
        <label className={labelClass}>Components — one per line</label>
        <textarea name="components" rows={3} maxLength={2000} defaultValue={current.components.join('\n')} className={textareaClass} placeholder="Header, Search bar, Result list…" />
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save states and fields'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
