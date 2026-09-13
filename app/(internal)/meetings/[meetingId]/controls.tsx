'use client';

import { useActionState, type ComponentType } from 'react';

import type { MeetingDoor } from '@/lib/scheduler/meeting-commands-eval';
import { IDLE_STATE } from '@/modules/identity/types';
import type { MeetingControl } from '@/modules/crm/meetings-view';
import { Badge, FormMessage, buttonClass, inputClass } from '@/ui';

import { addEvidenceAction, bookSlotAction, cancelMeetingAction, completeMeetingAction, proposeSlotsAction, recordNoShowAction, requestAnalysisAction, rescheduleMeetingAction } from './actions';

/**
 * A09's controls — G-237. Every control is rendered (Blueprint §11: a hidden
 * control is not enforcement). A `command` control mounts the form for the
 * door it names — looked up by the door, so a door without a form here is
 * a visible gap rather than a fall-through; a `blocked` one says on what it
 * is blocked and who owns that. The forms carry nothing the database does
 * not check again: the meeting id, and the fields the door validates.
 */

const input = inputClass;
const primary = buttonClass('primary', 'sm');
const secondary = buttonClass('secondary', 'sm');

type FormProps = { meetingId: string; offered?: readonly { startAt: string; endAt: string; label: string }[]; mode?: string };

function CancelForm({ meetingId }: FormProps) {
  const [state, action, pending] = useActionState(cancelMeetingAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="meetingId" value={meetingId} />
      <input name="reason" placeholder="Reason (optional, kept on the row)" className={input} aria-label="Cancellation reason" maxLength={20000} />
      <button type="submit" disabled={pending} className={`${secondary} self-start`}>{pending ? 'Cancelling…' : 'Cancel meeting'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function CompleteForm({ meetingId }: FormProps) {
  const [state, action, pending] = useActionState(completeMeetingAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="meetingId" value={meetingId} />
      <select name="outcome" defaultValue="completed" aria-label="Outcome" className={`${input} w-auto`}>
        <option value="completed">Completed</option>
        <option value="follow_up_required">Completed — follow-up required</option>
        <option value="failed">Failed (it happened, and did not work)</option>
      </select>
      <textarea name="note" rows={3} placeholder="What was said or decided (optional; filed as internal notes evidence)" className={input} aria-label="Completion note" maxLength={20000} />
      <button type="submit" disabled={pending} className={`${primary} self-start`}>{pending ? 'Recording…' : 'Mark completed'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function NoShowForm({ meetingId }: FormProps) {
  const [state, action, pending] = useActionState(recordNoShowAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="meetingId" value={meetingId} />
      <input name="note" placeholder="Note (optional, e.g. did not pick up)" className={input} aria-label="No-show note" maxLength={20000} />
      <button type="submit" disabled={pending} className={`${secondary} self-start`}>{pending ? 'Recording…' : 'Mark no-show'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function EvidenceForm({ meetingId }: FormProps) {
  const [state, action, pending] = useActionState(addEvidenceAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="meetingId" value={meetingId} />
      <div className="flex flex-wrap gap-2">
        <select name="kind" defaultValue="notes" aria-label="Kind" className={`${input} w-auto`}>
          <option value="notes">Typed notes</option>
          <option value="summary">Structured summary</option>
        </select>
        <select name="visibility" defaultValue="internal" aria-label="Visibility" className={`${input} w-auto`}>
          <option value="internal">Internal</option>
          <option value="client_visible">Client-visible</option>
        </select>
      </div>
      <textarea name="body" rows={3} required placeholder="The text. Internal unless you say otherwise — an internal note shown to a client cannot be un-shown." className={input} aria-label="Evidence text" maxLength={20000} />
      <button type="submit" disabled={pending} className={`${secondary} self-start`}>{pending ? 'Attaching…' : 'Attach'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function AnalysisForm({ meetingId }: FormProps) {
  const [state, action, pending] = useActionState(requestAnalysisAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="meetingId" value={meetingId} />
      <button type="submit" disabled={pending} className={`${secondary} self-start`}>{pending ? 'Asking the gate…' : 'Request analysis'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function ProposeForm({ meetingId }: FormProps) {
  const [state, action, pending] = useActionState(proposeSlotsAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="meetingId" value={meetingId} />
      <select name="duration" defaultValue="30" aria-label="Duration" className={`${input} w-auto`}>
        <option value="30">30 minutes</option>
        <option value="45">45 minutes</option>
        <option value="60">60 minutes</option>
      </select>
      <button type="submit" disabled={pending} className={`${primary} self-start`}>{pending ? 'Reading the calendar…' : 'Propose a time'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function BookForm({ meetingId, offered = [], mode }: FormProps) {
  const [state, action, pending] = useActionState(bookSlotAction, IDLE_STATE);
  if (offered.length === 0) return <p className="text-[12.5px] text-muted">No slots are on offer yet — propose a time first.</p>;
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="meetingId" value={meetingId} />
      <select name="startAt" defaultValue={offered[0]!.startAt} aria-label="Slot the client chose" className={`${input} w-auto`}>
        {offered.map((s) => <option key={s.startAt} value={s.startAt}>{s.label}</option>)}
      </select>
      <select name="mode" defaultValue={mode ?? 'call'} aria-label="Mode" className={`${input} w-auto`}>
        <option value="call">Call</option>
        <option value="video_meeting">Video meeting (Google Meet)</option>
        <option value="in_person_meeting">In person</option>
        <option value="other">Other</option>
      </select>
      <button type="submit" disabled={pending} className={`${primary} self-start`}>{pending ? 'Re-checking and booking…' : 'Book the chosen slot'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function RescheduleForm({ meetingId, mode }: FormProps) {
  const [state, action, pending] = useActionState(rescheduleMeetingAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="meetingId" value={meetingId} />
      <input name="reason" placeholder="Why (optional, kept on the cancelled booking)" className={input} aria-label="Reschedule reason" maxLength={20000} />
      <select name="mode" defaultValue={mode ?? 'call'} aria-label="Mode for the new meeting" className={`${input} w-auto`}>
        <option value="call">Call</option>
        <option value="video_meeting">Video meeting (Google Meet)</option>
        <option value="in_person_meeting">In person</option>
        <option value="other">Other</option>
      </select>
      <button type="submit" disabled={pending} className={`${secondary} self-start`}>{pending ? 'Rescheduling…' : 'Reschedule (cancel this, request a new one)'}</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

/**
 * One form per door. A door missing here renders nothing under its heading —
 * visibly, not as another door's form.
 *
 * `Partial` since the request door joined the table: a meeting page is the
 * wrong place to REQUEST a meeting — the row already exists by the time
 * anybody is on it — so that door has no form here and is offered from the
 * lead's page instead. The type says "may be absent" rather than the table
 * carrying a form that could never be reached.
 */
const FORMS: Partial<Record<MeetingDoor, ComponentType<FormProps>>> = {
  'crm.propose_meeting_slots': ProposeForm,
  'crm.book_meeting': BookForm,
  'crm.reschedule_meeting': RescheduleForm,
  'crm.cancel_meeting': CancelForm,
  'crm.complete_meeting': CompleteForm,
  'crm.record_no_show': NoShowForm,
  'crm.add_meeting_evidence': EvidenceForm,
  'crm.request_meeting_analysis': AnalysisForm,
};

export function MeetingControls({ meetingId, controls, mayWrite, settled, offered, mode }: { meetingId: string; controls: MeetingControl[]; mayWrite: boolean; settled: boolean; offered?: readonly { startAt: string; endAt: string; label: string }[]; mode?: string }) {
  return (
    <div className="flex flex-col gap-3">
      {settled ? <p className="text-[13px] text-muted">This meeting is settled: no status remains to move to. Evidence can still be attached.</p> : null}
      <ul className="flex flex-col gap-3">
        {controls.map((c) => {
          const Form = c.state === 'command' && mayWrite && c.door ? FORMS[c.door] : null;
          return (
            <li key={`${c.action}-${c.target ?? 'none'}`} className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2 ${c.state === 'blocked' ? 'border-dashed border-line-strong' : 'border-line'}`}>
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium">{c.action}</span>
                {c.state === 'blocked' ? <Badge tone="warning" dot>Blocked</Badge> : mayWrite ? <Badge tone="success" dot>Command</Badge> : <Badge tone="neutral" dot>Owner / ops admin</Badge>}
                <span className="font-mono text-[11px] text-faint">{c.door ?? 'crm.book_meeting'}</span>
              </div>
              <p className="text-[12.5px] text-muted">{c.reason}. Owner: {c.owner}.</p>
              {Form ? <Form meetingId={meetingId} offered={offered} mode={mode} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
