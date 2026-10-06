'use client';

import { useActionState } from 'react';

import {
  createTrackedLinkAction,
  cancelSubtaskAction,
  savePolicyAction,
  cancelHandoffAction,
  decideDuplicateReviewAction,
  mergeContactsAction,
  askAgentAction,
  setAutopilotAction,
  saveHandoffSettingsAction,
  saveChannelSettingsAction,
  saveIcpAction,
  saveServiceAction,
  seedDefaultsAction,
  setChannelPauseAction,
  setGlobalPauseAction,
} from '@/modules/acquisition/actions';
import { ACTION_LABEL, NEVER_AUTO_ACTIONS, type ACTION_TYPES } from '@/modules/acquisition/policy-vocabulary';
import { ICP_LIST_KEYS, ICP_LIST_LABEL, type IcpDefinition } from '@/modules/acquisition/schema';
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

export function MergeContactsForm({ a, b }: { a: { id: string; name: string }; b: { id: string; name: string } }) {
  const [state, action, pending] = useActionState(mergeContactsAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="flex-1">
        <Field label="Why these are one person (kept with the merge)">
          <input name="reason" required maxLength={500} className={inputClass} />
        </Field>
      </div>
      <button type="submit" name="keep" value={`${a.id}:${b.id}`} disabled={pending} className={buttonClass('primary')}>Keep {a.name}</button>
      <button type="submit" name="keep" value={`${b.id}:${a.id}`} disabled={pending} className={buttonClass('secondary')}>Keep {b.name}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function AutopilotForm({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState(setAutopilotAction, IDLE_STATE);
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="enabled" value={enabled ? '0' : '1'} />
      <button type="submit" disabled={pending} className={buttonClass(enabled ? 'secondary' : 'primary')}>{enabled ? 'Turn the weekly autopilot off' : 'Turn the weekly autopilot on'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function AskAgentForm({ agent, label }: { agent: string; label: string }) {
  const [state, action, pending] = useActionState(askAgentAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="agent" value={agent} />
      <Field label={`What should the ${label} agent do?`} hint="In your own words. It drafts and checks; it cannot send, publish, launch, deploy or price anything.">
        <textarea name="task" required minLength={5} maxLength={3000} rows={3} className={inputClass} />
      </Field>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary')}>Ask the agent</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function HandoffSettingsForm({ initial }: { initial: { businessNumber: string; linkTtlDays: number } }) {
  const [state, action, pending] = useActionState(saveHandoffSettingsAction, IDLE_STATE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
      <Field label="WhatsApp business number" hint="With the country code. This is the number a handoff link opens - not the API id.">
        <input name="businessNumber" defaultValue={initial.businessNumber} placeholder="+91 98765 43210" className={inputClass} />
      </Field>
      <Field label="Link lifetime (days)" hint="1 to 90.">
        <input name="linkTtlDays" inputMode="numeric" defaultValue={initial.linkTtlDays} className={inputClass} />
      </Field>
      <button type="submit" disabled={pending} className={buttonClass('primary')}>Save</button>
      <div className="sm:col-span-3"><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}

export function CancelHandoffForm({ handoffId }: { handoffId: string }) {
  const [state, action, pending] = useActionState(cancelHandoffAction, IDLE_STATE);
  return (
    <form action={action} className="flex items-end gap-2">
      <input type="hidden" name="handoffId" value={handoffId} />
      <input name="reason" required maxLength={500} placeholder="Why cancel?" className={inputClass} />
      <button type="submit" disabled={pending} className={buttonClass('danger')}>Cancel link</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function PolicyForm({ action: actionType, current, isOwner }: { action: (typeof ACTION_TYPES)[number]; current: { mode: string; approvalAbove: number | null; escalateAbove: number | null } | null; isOwner: boolean }) {
  const [state, run, pending] = useActionState(savePolicyAction, IDLE_STATE);
  const neverAuto = (NEVER_AUTO_ACTIONS as readonly string[]).includes(actionType);
  return (
    <form action={run} className="grid gap-2 border-b border-line py-3 last:border-0 sm:grid-cols-[2fr_1.2fr_1fr_1fr_auto] sm:items-end">
      <input type="hidden" name="action" value={actionType} />
      <div className="flex flex-col"><span className="text-[13px] font-medium">{ACTION_LABEL[actionType]}</span>{neverAuto ? <span className="text-xs text-muted">Always needs a person to approve.</span> : null}</div>
      <Field label="Decision">
        <select name="mode" aria-label={`Decision for ${ACTION_LABEL[actionType]}`} defaultValue={current?.mode ?? 'approval'} className={selectClass}>
          <option value="approval">Ask me first</option>
          {!neverAuto && isOwner ? <option value="auto">Automatic</option> : null}
          {!neverAuto && !isOwner && current?.mode === 'auto' ? <option value="auto">Automatic</option> : null}
          <option value="block">Never</option>
        </select>
      </Field>
      <Field label="Ask above (₹)"><input name="approvalAbove" inputMode="numeric" defaultValue={current?.approvalAbove === null || current?.approvalAbove === undefined ? '' : Math.round(current.approvalAbove / 100)} className={inputClass} /></Field>
      <Field label="Owner above (₹)"><input name="escalateAbove" inputMode="numeric" defaultValue={current?.escalateAbove === null || current?.escalateAbove === undefined ? '' : Math.round(current.escalateAbove / 100)} className={inputClass} /></Field>
      <button type="submit" disabled={pending} className={buttonClass('secondary')}>Save</button>
      <div className="sm:col-span-5"><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}

export function CancelSubtaskForm({ subtaskId }: { subtaskId: string }) {
  const [state, action, pending] = useActionState(cancelSubtaskAction, IDLE_STATE);
  return (
    <form action={action} className="flex items-end gap-2">
      <input type="hidden" name="subtaskId" value={subtaskId} />
      <input name="reason" required maxLength={500} placeholder="Why cancel?" aria-label="Reason for cancelling" className={inputClass} />
      <button type="submit" disabled={pending} className={buttonClass('danger')}>Cancel request</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

/** A tracked link for a lead who is somewhere else. It opens WhatsApp with a reference pre-filled, so their first message continues THIS lead. */
export function TrackedLinkForm() {
  const [state, run, pending] = useActionState(createTrackedLinkAction, IDLE_STATE);
  return (
    <form action={run} className="grid gap-3 sm:grid-cols-4">
      <div className="sm:col-span-2"><label className="flex flex-col gap-1"><span className={labelClass}>Lead id</span><input name="leadId" required className={inputClass} /></label></div>
      <label className="flex flex-col gap-1"><span className={labelClass}>They are on</span><select name="sourceChannel" aria-label="Where they are now" className={selectClass}>{['email', 'social', 'b2b', 'meta_ads', 'google_ads', 'other'].map((c) => <option key={c} value={c}>{c.replaceAll('_', ' ')}</option>)}</select></label>
      <label className="flex flex-col gap-1"><span className={labelClass}>Which platform</span><input name="sourcePlatform" maxLength={40} className={inputClass} placeholder="e.g. upwork (needed for B2B)" /></label>
      <div className="sm:col-span-4"><label className="flex flex-col gap-1"><span className={labelClass}>What happens next</span><input name="nextAction" maxLength={300} className={inputClass} /></label></div>
      <div className="flex items-center gap-3 sm:col-span-4"><button type="submit" disabled={pending} className={buttonClass('primary')}>Create the link</button><FormMessage status={state.status} message={state.message} /></div>
    </form>
  );
}
