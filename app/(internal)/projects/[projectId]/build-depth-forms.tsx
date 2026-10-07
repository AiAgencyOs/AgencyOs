'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { cancelBuildRequestAction, createClientBuildPackageAction, setBuildConfigAction } from '@/modules/projects/build-depth-actions';
import { BUILD_CONFIG_KEYS, BUILD_CONFIG_LABEL } from '@/modules/projects/build-depth-schema';
import { FormMessage, buttonClass, inputClass, labelClass, textareaClass } from '@/ui';

/** The Admin writes the build configuration: a new version each time it changes. Names of variables only, never a value. */
export function BuildConfigForm({ projectId, current }: { projectId: string; current: Record<string, unknown> | null }) {
  const [state, action, pending] = useActionState(setBuildConfigAction, IDLE_STATE);
  const envNames = Array.isArray(current?.env_names) ? (current.env_names as string[]).join(', ') : '';
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="projectId" value={projectId} />
      {BUILD_CONFIG_KEYS.map((key) => (
        <div key={key} className="flex flex-col gap-1">
          <label htmlFor={`bc-${key}`} className={labelClass}>{BUILD_CONFIG_LABEL[key]}</label>
          <input id={`bc-${key}`} name={key} defaultValue={typeof current?.[key] === 'string' ? (current[key] as string) : ''} className={inputClass} maxLength={300} />
        </div>
      ))}
      <div className="flex flex-col gap-1 sm:col-span-2">
        <label htmlFor="bc-env" className={labelClass}>{BUILD_CONFIG_LABEL.env_names}</label>
        <input id="bc-env" name="envNames" defaultValue={envNames} placeholder="NEXT_PUBLIC_SUPABASE_URL, SENTRY_DSN" className={inputClass} />
      </div>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <label htmlFor="bc-note" className={labelClass}>Why it changed</label>
        <input id="bc-note" name="note" className={inputClass} maxLength={1000} />
      </div>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : 'Save as a new version'}</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

/** Package a READY build for the client: limitations and testing instructions in plain words. */
export function ClientPackageForm({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  const [state, action, pending] = useActionState(createClientBuildPackageAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="deliverableId" value={deliverableId} />
      <label htmlFor={`cp-l-${deliverableId}`} className={labelClass}>What this build cannot do yet</label>
      <textarea id={`cp-l-${deliverableId}`} name="limitations" required rows={2} maxLength={2000} className={textareaClass} />
      <label htmlFor={`cp-t-${deliverableId}`} className={labelClass}>How to test it</label>
      <textarea id={`cp-t-${deliverableId}`} name="testingInstructions" required rows={3} maxLength={4000} className={textareaClass} />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Writing…' : 'Write the client package'}</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function CancelBuildRequestForm({ projectId, requestId }: { projectId: string; requestId: string }) {
  const [state, action, pending] = useActionState(cancelBuildRequestAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="requestId" value={requestId} />
      <input name="reason" placeholder="Why" aria-label="Why it is cancelled" maxLength={500} className={inputClass} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Cancelling…' : 'Cancel request'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
