'use client';

import { useActionState } from 'react';

import { recordPostedAction, activateStrategyAction, cancelVersionAction, createDraftAction, reviewVersionAction, scheduleVersionAction, submitVersionAction } from '@/modules/acquisition/actions';
import { CONTENT_FORMATS, CONTENT_OBJECTIVES, FORMAT_LABEL, OBJECTIVE_LABEL, PLATFORM_LABEL, SOCIAL_PLATFORMS } from '@/modules/acquisition/social-vocabulary';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={labelClass}>{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function NewDraftForm({ services }: { services: string[] }) {
  const [state, action, pending] = useActionState(createDraftAction, IDLE_STATE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-4">
      <Field label="Platform"><select name="platform" aria-label="Platform" className={selectClass}>{SOCIAL_PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}</select></Field>
      <Field label="What is it for?"><select name="objective" aria-label="Objective" className={selectClass}>{CONTENT_OBJECTIVES.map((o) => <option key={o} value={o}>{OBJECTIVE_LABEL[o]}</option>)}</select></Field>
      <Field label="Format"><select name="format" aria-label="Format" className={selectClass}>{CONTENT_FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}</select></Field>
      <Field label="Service it targets">
        <select name="service" aria-label="Target service" className={selectClass}><option value="">None</option>{services.map((s) => <option key={s} value={s}>{s}</option>)}</select>
      </Field>
      <div className="sm:col-span-4"><Field label="Title (internal)"><input name="title" required minLength={3} maxLength={160} className={inputClass} /></Field></div>
      <div className="sm:col-span-4"><Field label="The post" hint="This exact text is what is reviewed, approved and published. Any change makes a new version that needs approving again."><textarea name="body" required rows={6} className={textareaClass} /></Field></div>
      <div className="sm:col-span-2"><Field label="Call to action"><input name="cta" maxLength={500} className={inputClass} /></Field></div>
      <div className="sm:col-span-2"><Field label="Hashtags" hint="Separated by spaces or commas."><input name="hashtags" className={inputClass} /></Field></div>
      <div className="flex items-center gap-3 sm:col-span-4">
        <button type="submit" disabled={pending} className={buttonClass('primary')}>Save draft</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

function OneButton({ versionId, action: act, label, variant = 'secondary' }: { versionId: string; action: typeof reviewVersionAction; label: string; variant?: 'primary' | 'secondary' }) {
  const [state, run, pending] = useActionState(act, IDLE_STATE);
  return (
    <form action={run} className="flex flex-col gap-1">
      <input type="hidden" name="versionId" value={versionId} />
      <button type="submit" disabled={pending} className={buttonClass(variant)}>{label}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export const ReviewButton = ({ versionId }: { versionId: string }) => <OneButton versionId={versionId} action={reviewVersionAction} label="Run automated review" />;
export const SubmitButton = ({ versionId }: { versionId: string }) => <OneButton versionId={versionId} action={submitVersionAction} label="Send for approval" variant="primary" />;

export function ScheduleForm({ versionId }: { versionId: string }) {
  const [state, action, pending] = useActionState(scheduleVersionAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="versionId" value={versionId} />
      <div className="flex items-end gap-2">
        <Field label="Publish at"><input name="when" type="datetime-local" required className={inputClass} /></Field>
        <button type="submit" disabled={pending} className={buttonClass('primary')}>Schedule</button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function CancelVersionForm({ versionId }: { versionId: string }) {
  const [state, action, pending] = useActionState(cancelVersionAction, IDLE_STATE);
  return (
    <form action={action} className="flex items-end gap-2">
      <input type="hidden" name="versionId" value={versionId} />
      <input name="reason" required maxLength={300} placeholder="Why cancel?" aria-label="Reason for cancelling" className={inputClass} />
      <button type="submit" disabled={pending} className={buttonClass('danger')}>Cancel</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function ActivateStrategyButton({ strategyId }: { strategyId: string }) {
  const [state, action, pending] = useActionState(activateStrategyAction, IDLE_STATE);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="strategyId" value={strategyId} />
      <button type="submit" disabled={pending} className={buttonClass('primary')}>Activate</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

/** No publisher exists yet: the person posts it on the platform exactly as approved and records the post here. */
export function RecordPostedForm({ versionId }: { versionId: string }) {
  const [state, run, pending] = useActionState(recordPostedAction, IDLE_STATE);
  return (
    <form action={run} className="flex flex-col gap-1">
      <input type="hidden" name="versionId" value={versionId} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="The post's reference on the platform"><input name="externalRef" required maxLength={200} className={inputClass} /></Field>
        <Field label="Link to the post"><input name="url" type="url" className={inputClass} /></Field>
        <button type="submit" disabled={pending} className={buttonClass('primary')}>I posted it - record it</button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
