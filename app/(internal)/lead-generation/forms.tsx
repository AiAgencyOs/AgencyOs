'use client';

import { useActionState } from 'react';

import {
  decideDuplicateReviewAction,
  saveChannelSettingsAction,
  saveIcpAction,
  saveServiceAction,
  seedDefaultsAction,
  setChannelPauseAction,
  setGlobalPauseAction,
} from '@/modules/acquisition/actions';
import { ICP_LIST_KEYS, ICP_LIST_LABEL, type IcpDefinition } from '@/modules/acquisition/schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, textareaClass } from '@/ui';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={labelClass}>{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function SeedButton() {
  const [state, action, pending] = useActionState(async () => seedDefaultsAction(), IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <button type="submit" disabled={pending} className={buttonClass('primary')}>{pending ? 'Setting up...' : 'Set up lead generation'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function GlobalPauseForm({ active, reason, isOwner }: { active: boolean; reason: string | null; isOwner: boolean }) {
  const [state, action, pending] = useActionState(setGlobalPauseAction, IDLE_STATE);
  if (!isOwner) {
    return <p className="text-xs text-muted">{active ? `All lead generation is paused: ${reason ?? 'no reason recorded'}.` : 'Only the owner can pause all lead generation.'}</p>;
  }
  return (
    <form action={action} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <input type="hidden" name="active" value={active ? '0' : '1'} />
      <div className="flex-1">
        <Field label={active ? 'Reason for resuming' : 'Why are you pausing everything?'}>
          <input name="reason" required maxLength={500} className={inputClass} />
        </Field>
      </div>
      <button type="submit" disabled={pending} className={buttonClass(active ? 'primary' : 'danger')}>{active ? 'Resume all lead generation' : 'Pause all lead generation'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function ChannelSettingsForm({ channel, initial }: { channel: string; initial: { enabled: boolean; target: number | null; budgetMajor: number | null; daily: number | null } }) {
  const [state, action, pending] = useActionState(saveChannelSettingsAction, IDLE_STATE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="channel" value={channel} />
      <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
        <input type="checkbox" name="enabled" defaultChecked={initial.enabled} />
        <span>Part of the plan. This records the decision; the engine only acts when it exists and the channel is not paused.</span>
      </label>
      <Field label="Monthly qualified-lead goal" hint="Leave blank for no goal.">
        <input name="monthlyQualifiedTarget" inputMode="numeric" defaultValue={initial.target ?? ''} className={inputClass} />
      </Field>
      <Field label="Monthly budget (₹)" hint="The most this channel may spend in a month. Blank means none set.">
        <input name="monthlyBudget" inputMode="numeric" defaultValue={initial.budgetMajor ?? ''} className={inputClass} />
      </Field>
      <Field label="Daily action limit" hint="Most outreach actions per day. Blank means none set.">
        <input name="dailyLimit" inputMode="numeric" defaultValue={initial.daily ?? ''} className={inputClass} />
      </Field>
      <div className="flex items-end gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary')}>Save</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function ChannelPauseForm({ channel, paused, reason }: { channel: string; paused: boolean; reason: string | null }) {
  const [state, action, pending] = useActionState(setChannelPauseAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="paused" value={paused ? '0' : '1'} />
      {paused ? <p className="flex-1 text-[13px] text-muted">Paused: {reason}</p> : (
        <div className="flex-1">
          <Field label="Pause this channel" hint="Stops new actions only. Nothing is deleted, and replies already received are kept.">
            <input name="reason" required maxLength={500} placeholder="Why?" className={inputClass} />
          </Field>
        </div>
      )}
      <button type="submit" disabled={pending} className={buttonClass(paused ? 'primary' : 'danger')}>{paused ? 'Resume channel' : 'Pause channel'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function ServiceForm({ service }: { service?: { id: string; name: string; description: string | null; priority: number; active: boolean } }) {
  const [state, action, pending] = useActionState(saveServiceAction, IDLE_STATE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[2fr_3fr_6rem_auto_auto] sm:items-end">
      {service ? <input type="hidden" name="id" value={service.id} /> : null}
      <Field label="Service"><input name="name" required minLength={2} maxLength={80} defaultValue={service?.name ?? ''} className={inputClass} /></Field>
      <Field label="Description"><input name="description" maxLength={600} defaultValue={service?.description ?? ''} className={inputClass} /></Field>
      <Field label="Priority" hint="1 = first"><input name="priority" inputMode="numeric" defaultValue={service?.priority ?? 100} className={inputClass} /></Field>
      <label className="flex items-center gap-2 pb-2 text-[13px]"><input type="checkbox" name="active" defaultChecked={service?.active ?? true} /> Active</label>
      <button type="submit" disabled={pending} className={buttonClass(service ? 'secondary' : 'primary')}>{service ? 'Save' : 'Add service'}</button>
      <div className="sm:col-span-5"><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}

export function IcpForm({ initial }: { initial: IcpDefinition }) {
  const [state, action, pending] = useActionState(saveIcpAction, IDLE_STATE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      {ICP_LIST_KEYS.map((key) => (
        <Field key={key} label={ICP_LIST_LABEL[key]} hint="One per line.">
          <textarea name={key} rows={4} defaultValue={(initial[key] ?? []).join('\n')} className={textareaClass} />
        </Field>
      ))}
      <Field label="Minimum qualification score (0-100)" hint="Below this a prospect is not pursued.">
        <input name="minScore" inputMode="numeric" defaultValue={initial.min_qualification_score ?? ''} className={inputClass} />
      </Field>
      <Field label="What changed? (optional)"><input name="note" maxLength={500} className={inputClass} /></Field>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonClass('primary')}>Save as a new version</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function DuplicateDecisionForm({ reviewId }: { reviewId: string }) {
  const [state, action, pending] = useActionState(decideDuplicateReviewAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <input type="hidden" name="reviewId" value={reviewId} />
      <div className="flex-1">
        <Field label="Reason (needed unless you dismiss)">
          <input name="note" maxLength={1000} className={inputClass} />
        </Field>
      </div>
      <button type="submit" name="decision" value="kept_separate" disabled={pending} className={buttonClass('secondary')}>Different people</button>
      <button type="submit" name="decision" value="confirmed_same" disabled={pending} className={buttonClass('primary')}>Same person</button>
      <button type="submit" name="decision" value="dismissed" disabled={pending} className={buttonClass('ghost')}>Dismiss</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
