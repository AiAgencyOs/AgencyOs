'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { Callout, FormMessage, IconAlert, buttonClass, inputClass, labelClass } from '@/ui';

import { setOrganizationNameAction, setTimezoneAction } from './actions';

/**
 * The two high-risk settings, with a preview-impact step — SCR-071.
 *
 * Step one takes the new value and shows what the change touches — counts
 * computed on the server by the same readers the pages use
 * (`readSettingImpact`), never a guess. Step two is the same door the plain
 * form always called (`setTimezoneAction`, `setOrganizationNameAction`); the
 * preview adds a pause, not a second write path. A person who has read the
 * impact confirms; nothing is saved before that.
 */

export type TimezoneImpact = { activeFollowUps: number; upcomingMeetings: number };
export type NameImpact = { openProposals: number; draftInvoices: number };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function TimezoneFormWithPreview({ current, impact }: { current: string | null; impact: TimezoneImpact }) {
  const [state, action, pending] = useActionState(setTimezoneAction, IDLE_STATE);
  const [value, setValue] = useState(current ?? '');
  const [previewed, setPreviewed] = useState(false);
  const changed = value.trim() !== (current ?? '') && value.trim().length > 0;

  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>IANA timezone</span>
          <input
            name="timezone"
            required
            placeholder="Asia/Kolkata"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setPreviewed(false);
            }}
            className={`${inputClass} w-56`}
          />
        </label>
        {!previewed ? (
          <button type="button" disabled={!changed} onClick={() => setPreviewed(true)} className={buttonClass('secondary', 'sm')}>
            Preview impact
          </button>
        ) : (
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Saving…' : `Confirm: set ${value.trim()}`}
          </button>
        )}
      </div>
      {previewed ? (
        <Callout tone="warning" icon={<IconAlert size={16} />} title={`Changing the timezone from ${current ?? 'unset'} to ${value.trim()} affects`}>
          <ul className="list-disc pl-4 text-[13px]">
            <li>{plural(impact.activeFollowUps, 'active follow-up sequence', 'active follow-up sequences')} — each re-schedules its next send in the new zone.</li>
            <li>{plural(impact.upcomingMeetings, 'upcoming meeting', 'upcoming meetings')} — shown and reminded in the new zone.</li>
            <li>Every date on every page, for everyone without a personal timezone preference.</li>
          </ul>
        </Callout>
      ) : null}
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function OrganizationNameFormWithPreview({ current, impact }: { current: string; impact: NameImpact }) {
  const [state, action, pending] = useActionState(setOrganizationNameAction, IDLE_STATE);
  const [value, setValue] = useState(current);
  const [previewed, setPreviewed] = useState(false);
  const changed = value.trim() !== current && value.trim().length > 0;

  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Agency name</span>
          <input
            name="name"
            required
            maxLength={120}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setPreviewed(false);
            }}
            className={`${inputClass} w-72`}
          />
        </label>
        {!previewed ? (
          <button type="button" disabled={!changed} onClick={() => setPreviewed(true)} className={buttonClass('secondary', 'sm')}>
            Preview impact
          </button>
        ) : (
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Saving…' : 'Confirm rename'}
          </button>
        )}
      </div>
      {previewed ? (
        <Callout tone="warning" icon={<IconAlert size={16} />} title={`Renaming “${current}” to “${value.trim()}” affects`}>
          <ul className="list-disc pl-4 text-[13px]">
            <li>{plural(impact.openProposals, 'open quotation', 'open quotations')} — the next PDF a client opens carries the new letterhead.</li>
            <li>{plural(impact.draftInvoices, 'draft invoice', 'draft invoices')} — issued under the new name.</li>
            <li>Every announcement sent from now on names the new sender.</li>
          </ul>
        </Callout>
      ) : null}
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
