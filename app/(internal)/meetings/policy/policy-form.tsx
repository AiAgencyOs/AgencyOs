'use client';

import { useActionState } from 'react';

import type { SchedulingPolicy } from '@/lib/scheduling/p1o-policy';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

import { saveSchedulingPolicyAction } from './actions';

const DAYS: Array<[string, string]> = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];

export function PolicyForm({ policy, canEdit }: { policy: SchedulingPolicy; canEdit: boolean }) {
  const [state, action, pending] = useActionState(saveSchedulingPolicyAction, IDLE_STATE);
  const hours = policy.workingHours ?? {};
  return (
    <form action={action} className="flex flex-col gap-5">
      <fieldset disabled={!canEdit || pending} className="flex flex-col gap-5">
        <label className="flex flex-col gap-1 text-sm">Timezone the hours are in
          <input name="timezone" defaultValue={policy.timezone} className={`${inputClass} h-9 w-64`} />
        </label>

        <div>
          <p className="mb-2 text-sm font-medium">Working hours (24-hour, in that timezone). Leave a day empty for closed; leave all empty for no limit.</p>
          <div className="grid gap-2">
            {DAYS.map(([key, label]) => {
              const w = hours[key as keyof typeof hours]?.[0];
              return (
                <div key={key} className="flex items-center gap-2 text-sm">
                  <span className="w-24">{label}</span>
                  <input name={`${key}_start`} defaultValue={w?.start ?? ''} placeholder="10:00" aria-label={`${label} opens`} className={`${inputClass} h-8 w-24`} />
                  <span>to</span>
                  <input name={`${key}_end`} defaultValue={w?.end ?? ''} placeholder="19:00" aria-label={`${label} closes`} className={`${inputClass} h-8 w-24`} />
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="flex flex-col gap-1 text-sm">Earliest start<input name="earliest" defaultValue={policy.earliestLocalTime ?? ''} placeholder="09:00" className={`${inputClass} h-8`} /></label>
          <label className="flex flex-col gap-1 text-sm">Latest end<input name="latest" defaultValue={policy.latestLocalTime ?? ''} placeholder="20:00" className={`${inputClass} h-8`} /></label>
          <label className="flex flex-col gap-1 text-sm">Minimum notice (min)<input name="minNotice" inputMode="numeric" defaultValue={policy.minNoticeMinutes} className={`${inputClass} h-8`} /></label>
          <label className="flex flex-col gap-1 text-sm">Buffer either side (min)<input name="buffer" inputMode="numeric" defaultValue={policy.bufferMinutes} className={`${inputClass} h-8`} /></label>
          <label className="flex flex-col gap-1 text-sm">Durations offered (min)<input name="durations" defaultValue={policy.durations.join(', ')} className={`${inputClass} h-8`} /></label>
          <label className="flex flex-col gap-1 text-sm">An offer stays open (hours)<input name="ttl" inputMode="numeric" defaultValue={policy.proposalTtlHours} className={`${inputClass} h-8`} /></label>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="enforce" defaultChecked={policy.enforceWorkingHours} className="mt-1" />
          <span>Refuse a booking outside these hours. Off by default: with it off, the hours only narrow the times that are offered.</span>
        </label>

        {canEdit ? (
          <div className="flex items-center gap-3">
            <button type="submit" disabled={pending} className={buttonClass('primary', 'md')}>{pending ? 'Saving…' : 'Save policy'}</button>
            <FormMessage status={state.status} message={state.message} />
          </div>
        ) : (
          <p className="text-sm text-muted">Only an owner or ops admin can change this.</p>
        )}
      </fieldset>
    </form>
  );
}
