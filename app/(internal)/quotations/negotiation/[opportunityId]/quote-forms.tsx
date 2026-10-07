'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

import { applyTaxAction, cancelQuotationAction, recalculateTimelineAction, recordAcceptanceAction, resolveClarificationAction, setLinePricingAction } from './actions';

export function AcceptanceForm({ proposals, contacts }: { proposals: Array<{ id: string; version: number; label: string }>; contacts: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(recordAcceptanceAction, IDLE_STATE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">Quotation the client accepted
        <select name="proposalId" required className={`${inputClass} h-9`}>{proposals.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
      </label>
      <label className="flex flex-col gap-1 text-sm">Version the client named
        <input name="statedVersion" inputMode="numeric" placeholder="leave empty if they did not say" className={`${inputClass} h-9`} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Who accepted
        <select name="contactId" required className={`${inputClass} h-9`}>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </label>
      <label className="flex flex-col gap-1 text-sm">Where it came from
        <select name="channel" required className={`${inputClass} h-9`}>
          <option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="call">Call</option><option value="meeting">Meeting</option><option value="portal">Portal</option><option value="other">Other</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">Evidence (message reference, recording, signed reply)
        <input name="evidenceRef" required maxLength={500} className={`${inputClass} h-9`} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Message id (optional)<input name="messageRef" maxLength={200} className={`${inputClass} h-9`} /></label>
      <label className="flex flex-col gap-1 text-sm">Note (optional)<input name="note" maxLength={500} className={`${inputClass} h-9`} /></label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'md')}>{pending ? 'Recording…' : 'Record acceptance'}</button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function CancelForm({ proposalId }: { proposalId: string }) {
  const [state, action, pending] = useActionState(cancelQuotationAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="proposalId" value={proposalId} />
      <input name="reason" required maxLength={500} placeholder="why cancel" aria-label="Reason for cancelling" className={`${inputClass} h-7 w-48 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('danger', 'sm')}>{pending ? 'Cancelling…' : 'Cancel quotation'}</button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function ResolveClarificationForm({ clarificationId }: { clarificationId: string }) {
  const [state, action, pending] = useActionState(resolveClarificationAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="clarificationId" value={clarificationId} />
      <input name="note" required maxLength={1000} placeholder="how it was settled" aria-label="How it was settled" className={`${inputClass} h-7 w-56 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : 'Mark settled'}</button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function ApplyTaxForm({ proposalId }: { proposalId: string }) {
  const [state, action, pending] = useActionState(applyTaxAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="proposalId" value={proposalId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Computing…' : 'Compute tax from configuration'}</button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

const SOURCES = [['manual', 'Typed by hand'], ['pricing_reference', 'Pricing reference'], ['approved_offer', 'Approved offer'], ['catalogue', 'Price list / catalogue'], ['plan_slot', 'Plan slot']] as const;

export function LinePricingForm({ lineId, discountRupees, sourceKind, catalogueRef }: { lineId: string; discountRupees: number; sourceKind: string | null; catalogueRef: string | null }) {
  const [state, action, pending] = useActionState(setLinePricingAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="lineId" value={lineId} />
      <input name="discountRupees" type="number" min="0" step="0.01" defaultValue={discountRupees || ''} placeholder="line discount (₹)" aria-label="Discount on this line in rupees" className={`${inputClass} h-7 w-32 text-xs`} />
      <select name="sourceKind" defaultValue={sourceKind ?? ''} aria-label="Where the price came from" className={`${inputClass} h-7 text-xs`}>
        <option value="">source: not said</option>
        {SOURCES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      <input name="catalogueRef" maxLength={200} defaultValue={catalogueRef ?? ''} placeholder="reference key" aria-label="Catalogue or reference key" className={`${inputClass} h-7 w-40 text-xs`} />
      <input name="reason" maxLength={500} placeholder="reason (needed for a discount)" aria-label="Reason for the discount" className={`${inputClass} h-7 w-48 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : 'Save line'}</button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function TimelineRecalcForm({ objectionId }: { objectionId: string }) {
  const [state, action, pending] = useActionState(recalculateTimelineAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="objectionId" value={objectionId} />
      <input name="askedWeeks" type="number" min="1" max="104" required placeholder="weeks the client asked for" aria-label="Weeks the client asked for" className={`${inputClass} h-7 w-44 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Working…' : 'Recalculate the timeline'}</button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
