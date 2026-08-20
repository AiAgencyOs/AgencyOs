'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, inputClass } from '@/ui';

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
