'use client';

import { useActionState, useId, useState } from 'react';

import { addDeviceAction, setDeviceSupportAction } from '@/modules/qa/device-actions';
import { PLATFORM_LABEL, PLATFORMS } from '@/modules/qa/device-tiles';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

/**
 * SCR-044 "Add Device" and SCR-048 "unsupported devices must be recorded".
 * `qa.add_device_configuration` / `qa.set_device_support` decide; an
 * unsupported configuration cannot be saved without its reason, here or in
 * the database.
 */
export function AddDeviceForm() {
  const [state, action, pending] = useActionState(addDeviceAction, IDLE_STATE);
  const [status, setStatus] = useState<'supported' | 'unsupported'>('supported');
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-name`} className={labelClass}>Device</label>
          <input id={`${id}-name`} name="name" required maxLength={120} placeholder="iPhone 15" className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-platform`} className={labelClass}>Platform</label>
          <select id={`${id}-platform`} name="platform" defaultValue="android" className={selectClass}>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-os`} className={labelClass}>Operating system (optional)</label>
          <input id={`${id}-os`} name="os" maxLength={120} placeholder="iOS 17.4" className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-browser`} className={labelClass}>Only this browser (optional)</label>
          <input id={`${id}-browser`} name="browser" maxLength={120} placeholder="Safari 17" className={inputClass} />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-status`} className={labelClass}>Support</label>
          <select id={`${id}-status`} name="status" value={status} onChange={(e) => setStatus(e.target.value === 'unsupported' ? 'unsupported' : 'supported')} className={selectClass}>
            <option value="supported">Supported — we test on it</option>
            <option value="unsupported">Unsupported — we do not</option>
          </select>
        </div>
        {status === 'unsupported' ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-reason`} className={labelClass}>Why it is unsupported (required)</label>
            <textarea id={`${id}-reason`} name="reason" required rows={2} maxLength={600} placeholder="The client contract excludes Android 9 and below." className={textareaClass} />
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save device'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

/** Change a registered device between supported and unsupported; unsupported asks for the reason. */
export function DeviceSupportForm({ deviceId, status, name }: { deviceId: string; status: 'supported' | 'unsupported'; name: string }) {
  const [state, action, pending] = useActionState(setDeviceSupportAction, IDLE_STATE);
  const next: 'supported' | 'unsupported' = status === 'supported' ? 'unsupported' : 'supported';
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-1.5">
      <input type="hidden" name="deviceId" value={deviceId} />
      <input type="hidden" name="status" value={next} />
      {next === 'unsupported' ? (
        <>
          <label htmlFor={`${id}-reason`} className="sr-only">Why {name} is unsupported</label>
          <textarea id={`${id}-reason`} name="reason" required rows={2} maxLength={600} placeholder="Why it is unsupported" className={`${textareaClass} text-xs`} />
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
          {pending ? 'Saving…' : status === 'supported' ? 'Mark unsupported' : 'Mark supported'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}
