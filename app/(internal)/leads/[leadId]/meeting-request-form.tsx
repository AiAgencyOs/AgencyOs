'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import type { FormState } from '@/modules/identity/types';
import { FormMessage } from '@/ui';

import { requestMeetingAction } from './meeting-request-actions';

/**
 * "The client asked for a meeting" — Scheduler §3.1, §4.
 *
 * The control that had been missing while every other meeting control existed.
 * It records that a request HAPPENED; it proposes nothing, offers nothing and
 * books nothing, because §4.1 keeps what a client asked for apart from what
 * anybody agreed.
 *
 * The mode is the client's own words about how they want to meet. There is no
 * "when" field here on purpose: a time the client named is a fact worth
 * keeping, but typing it from memory into a datetime box is how "Tuesday
 * afternoon?" becomes a booking nobody agreed. The offer that follows reads
 * the calendar.
 */

const MODES: readonly { value: string; label: string }[] = [
  { value: 'call', label: 'Call' },
  { value: 'video_meeting', label: 'Video meeting' },
  { value: 'in_person_meeting', label: 'In person' },
  { value: 'other', label: 'Other' },
];

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="self-start rounded-md border border-line-strong px-3 py-1.5 text-[13px] font-medium hover:bg-surface-strong disabled:opacity-60"
    >
      {pending ? 'Recording…' : 'Record the request'}
    </button>
  );
}

export function MeetingRequestForm({
  leadId,
  conversationId,
  agencyZone,
}: {
  leadId: string;
  conversationId: string | null;
  agencyZone: string | null;
}) {
  const [state, action] = useActionState<FormState, FormData>(requestMeetingAction, { status: 'idle' });

  if (!agencyZone) {
    return (
      <p className="text-[13px] text-muted">
        A meeting needs a timezone and the agency has not set one. Set it on the Settings page — a meeting recorded
        without one would be a time nobody can read.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      {conversationId ? <input type="hidden" name="conversationId" value={conversationId} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <select name="mode" defaultValue="call" className="rounded-md border border-line bg-surface px-2 py-1.5 text-[13px]">
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-muted">in {agencyZone}</span>
      </div>
      <input
        name="purpose"
        maxLength={2000}
        placeholder="What they want to talk about (optional)"
        className="rounded-md border border-line bg-surface px-2 py-1.5 text-[13px]"
      />
      <Submit />
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
