'use client';

import { useActionState, useId } from 'react';

import { NOTIFICATION_CHANNELS, NOTIFICATION_EVENT_CLASSES } from '@/lib/p13/notification-gate';
import { setNotificationRuleAction } from '@/modules/approvals/p13-notification-rules-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass } from '@/ui';

export type RuleDefaults = {
  eventClass: string;
  channel: string;
  enabled: boolean;
  minIntervalSeconds: number;
  quietStart: string;
  quietEnd: string;
  timezone: string;
  criticalBypassesQuiet: boolean;
};

export function RuleForm({ defaults, lockKey }: { defaults: RuleDefaults; lockKey: boolean }) {
  const [state, action, pending] = useActionState(setNotificationRuleAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-c`} className={labelClass}>
          Event
        </label>
        <select id={`${id}-c`} name="eventClass" defaultValue={defaults.eventClass} disabled={lockKey} className={inputClass}>
          {NOTIFICATION_EVENT_CLASSES.map((c) => (
            <option key={c} value={c}>
              {c.replace('_', ' ')}
            </option>
          ))}
        </select>
        {lockKey ? <input type="hidden" name="eventClass" value={defaults.eventClass} /> : null}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-h`} className={labelClass}>
          Channel
        </label>
        <select id={`${id}-h`} name="channel" defaultValue={defaults.channel} disabled={lockKey} className={inputClass}>
          {NOTIFICATION_CHANNELS.map((c) => (
            <option key={c} value={c}>
              {c.replace('_', ' ')}
            </option>
          ))}
        </select>
        {lockKey ? <input type="hidden" name="channel" value={defaults.channel} /> : null}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-i`} className={labelClass}>
          Minimum seconds apart
        </label>
        <input id={`${id}-i`} name="minIntervalSeconds" type="number" min={0} max={604800} defaultValue={defaults.minIntervalSeconds} className={inputClass} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-z`} className={labelClass}>
          Timezone
        </label>
        <input id={`${id}-z`} name="timezone" defaultValue={defaults.timezone} className={inputClass} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-qs`} className={labelClass}>
          Quiet from (HH:MM)
        </label>
        <input id={`${id}-qs`} name="quietStart" defaultValue={defaults.quietStart} placeholder="22:00" className={inputClass} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-qe`} className={labelClass}>
          Quiet until (HH:MM)
        </label>
        <input id={`${id}-qe`} name="quietEnd" defaultValue={defaults.quietEnd} placeholder="08:00" className={inputClass} />
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" name="enabled" defaultChecked={defaults.enabled} /> On
      </label>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" name="criticalBypassesQuiet" defaultChecked={defaults.criticalBypassesQuiet} /> Critical notices ignore quiet hours
      </label>
      <div className="flex items-center gap-3 sm:col-span-4">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save rule'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
