'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

import { proposeMeetingOnDayAction } from './propose-meeting-actions';

/**
 * SCR-022 — "Propose a meeting on this day". Picks one of the project's
 * client leads, a time and a mode; the day is the one clicked. The action
 * hands it to the existing meeting request door with the date pre-filled
 * as the requested start — a request, not a booking.
 */
const MODES: readonly { value: string; label: string }[] = [
  { value: 'call', label: 'Call' },
  { value: 'video_meeting', label: 'Video meeting' },
  { value: 'in_person_meeting', label: 'In person' },
  { value: 'other', label: 'Other' },
];

export function ProposeMeetingOnDayForm({
  projectId,
  date,
  leads,
  agencyZone,
  compact,
}: {
  projectId: string;
  date: string;
  leads: { id: string; title: string }[];
  agencyZone: string | null;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(proposeMeetingOnDayAction, IDLE_STATE);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={compact ? 'text-xs text-muted hover:text-foreground' : buttonClass('ghost', 'sm')}
        aria-label={`Propose a meeting on ${date}`}
      >
        + meeting
      </button>
    );
  }

  if (!agencyZone) {
    return <p className="text-xs text-muted">A meeting needs a timezone and the agency has not set one. Set it on the Settings page first.</p>;
  }
  if (leads.length === 0) {
    return <p className="text-xs text-muted">No lead to propose to — this project’s client has no lead this meeting could belong to.</p>;
  }

  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line bg-surface p-2 text-left">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="date" value={date} />
      <div className="flex flex-col gap-1">
        <label className={labelClass}>Meeting on {date} · in {agencyZone}</label>
        <div className="flex flex-wrap items-center gap-2">
          <select name="leadId" aria-label="Lead" defaultValue={leads[0]?.id} className={`${selectClass} w-auto max-w-[14rem]`}>
            {leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
          <input type="time" name="time" defaultValue="10:00" required aria-label="Time" className={`${inputClass} w-28`} />
          <select name="mode" aria-label="Meeting mode" defaultValue="call" className={`${selectClass} w-auto`}>
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <input name="purpose" maxLength={2000} placeholder="What it is about (optional)" className={inputClass} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Recording…' : 'Propose the meeting'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
        <span className="text-xs text-muted">Records a request at this time; offer and book it from the meeting page.</span>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
