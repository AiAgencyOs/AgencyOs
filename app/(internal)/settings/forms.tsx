'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, inputClass } from '@/ui';

import { upsertApprovalPolicyAction } from '@/modules/approvals/actions';
import { linkInternalRecipientAction, linkInternalGroupAction } from '@/modules/crm/actions';

import {
  setReactivationPilotAction,
  setTestRecipientAction,
  setTimezoneAction,
  setWhatsAppNumberAction,
  verifyWhatsAppAction,
} from './actions';

/** A few common IANA zones as suggestions; any valid IANA zone is accepted. */
const COMMON_ZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

function Message({ status, message }: { status: string; message?: string }) {
  if (status === 'idle' || !message) return null;
  return (
    <span className={`text-xs ${status === 'error' ? 'text-danger' : 'text-success'}`}>
      {message}
    </span>
  );
}

export function TimezoneForm({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState(setTimezoneAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        name="timezone"
        defaultValue={current ?? ''}
        placeholder="Asia/Kolkata"
        list="iana-zones"
        aria-label="Agency IANA timezone"
        className={inputClass}
      />
      <datalist id="iana-zones">
        {COMMON_ZONES.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
      <button
        type="submit"
        disabled={pending}
        className={buttonClass('secondary', 'sm')}
      >
        {pending ? 'Saving…' : current ? 'Update' : 'Set timezone'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

export function WhatsAppNumberForm({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState(setWhatsAppNumberAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        name="phone_number_id"
        defaultValue={current ?? ''}
        placeholder="123456789012345"
        inputMode="numeric"
        aria-label="WhatsApp phone number id"
        className={inputClass}
      />
      <button
        type="submit"
        disabled={pending}
        className={buttonClass('secondary', 'sm')}
      >
        {pending ? 'Saving…' : current ? 'Update' : 'Set number id'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

export function TestRecipientForm({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState(setTestRecipientAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        name="test_recipient"
        defaultValue={current ?? ''}
        placeholder="+919000000000"
        aria-label="Internal WhatsApp test recipient"
        className={inputClass}
      />
      <button
        type="submit"
        disabled={pending}
        className={buttonClass('secondary', 'sm')}
      >
        {pending ? 'Saving…' : current ? 'Update' : 'Set test number'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

export function VerifyWhatsAppButton() {
  const [state, action, pending] = useActionState(verifyWhatsAppAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <button
        type="submit"
        disabled={pending}
        className={buttonClass('secondary', 'sm')}
      >
        {pending ? 'Checking with Meta…' : 'Verify configuration'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

export function PilotToggleForm({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState(setReactivationPilotAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <button
        type="submit"
        disabled={pending}
        className={buttonClass('secondary', 'sm')}
      >
        {pending ? 'Saving…' : enabled ? 'Disable pilot' : 'Enable pilot'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

/**
 * Who must approve what — ADM-08b, and the reason nothing could be quoted.
 *
 * `sales.submit_proposal` answers `no_policy` when nothing covers quotations,
 * and the message an owner reads says *"An owner sets one before this can be
 * approved"* — an action the product did not offer anywhere. So on a fresh
 * deployment the whole of ADM-07's close path stopped at the first submit.
 *
 * Here rather than on /approvals deliberately: that page's own comment says
 * *"changing who may approve what is an authority change… not a screen a queue
 * view should hand out"*, and it is still right. This is the owner's
 * configuration surface, already owner-gated and already audited.
 *
 * The money floor is stated in the form rather than discovered on submit —
 * `violatesMoneyFloor` was written for exactly this and had no caller. The
 * DDL constraint is still the rule; this only says so first.
 */
export function ApprovalPolicyForm({ subjectTypes, roles }: { subjectTypes: readonly string[]; roles: readonly string[] }) {
  const [state, action, pending] = useActionState(upsertApprovalPolicyAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select name="subjectType" defaultValue="proposal" aria-label="What needs approving" className={`${inputClass} w-auto`}>
          {subjectTypes.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, ' ')}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-[12.5px] text-muted">
          at or above ₹
          <input
            name="minAmountMinor"
            type="number"
            min="0"
            step="1"
            defaultValue="0"
            aria-label="Minimum amount in rupees"
            className={`${inputClass} w-28`}
          />
        </label>

        <select name="requiredRole" defaultValue="owner" aria-label="Who must approve" className={`${inputClass} w-auto`}>
          {roles.map((r) => (
            <option key={r} value={r}>
              {r.replace(/_/g, ' ')}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-[12.5px] text-muted">
          within
          <input
            name="slaHours"
            type="number"
            min="1"
            max="8760"
            defaultValue="24"
            aria-label="Hours to answer"
            className={`${inputClass} w-20`}
          />
          h
        </label>

        <input name="note" placeholder="Note (optional)" aria-label="Note" className={`${inputClass} w-44`} />

        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Set policy'}
        </button>
      </div>

      <p className="text-[12.5px] text-muted">
        A policy says who must consent, never who may act. Refunds are owner-only and invoices
        need owner or ops admin — policy may make a gate stricter, never looser, and the database
        refuses the rest. Setting the same subject and amount again replaces that rung.
      </p>

      <Message status={state.status} message={state.message} />
    </form>
  );
}

/**
 * Where the agent asks for help — G-109, business rules §5.1.
 *
 * The internal group is *"an approval channel, not a chat log"*: what the
 * agent brings there is what needs a person — an approval, and a conversation
 * it has handed over.
 *
 * Written after the first real handover on production reached nobody. The
 * reason was good, the lead went to the top of the attention list, the thread
 * grew a banner — and no phone buzzed, because no group was linked and there
 * was no way to link one. The announcer had been built and was silent.
 */
/**
 * Where announcements go when the channel is a person — ADM-95, G-159.
 *
 * Meta refused this WABA the Groups APIs (#131215), so the group form above
 * cannot deliver anywhere today; this one can. One number, the owner's own.
 */
export function InternalRecipientForm({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState(linkInternalRecipientAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="phone"
          defaultValue={current ?? ''}
          placeholder="+91 98765 43210"
          aria-label="Announcements WhatsApp number"
          className={`${inputClass} w-72`}
        />
        <input name="title" placeholder="Name (optional)" aria-label="Recipient name" className={`${inputClass} w-44`} />
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Linking…' : current ? 'Change number' : 'Link number'}
        </button>
      </div>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

export function InternalGroupForm({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState(linkInternalGroupAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="externalRef"
          defaultValue={current ?? ''}
          placeholder="120363012345678901@g.us"
          aria-label="Internal group id"
          className={`${inputClass} w-72`}
        />
        <input name="title" placeholder="Name (optional)" aria-label="Group name" className={`${inputClass} w-44`} />
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Linking…' : current ? 'Relink group' : 'Link group'}
        </button>
      </div>
      <Message status={state.status} message={state.message} />
    </form>
  );
}
