'use client';

import { useActionState } from 'react';

import {
  lockUiVersionAction,
  recordUiVersionClientDecisionAction,
  shareUiVersionWithClientAction,
} from '@/modules/projects/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass } from '@/ui';

/**
 * Client UI Review — the three doors `20260923140000` built with no form in
 * front of them (P4-UID-CLIENT-REVIEW). One form per state the version is
 * actually in, the same "the form appears when the gate is open" discipline
 * `design-forms.tsx` keeps for Phase 3's identical shape: nothing here
 * decides whether a share or a lock is allowed — the door checks that again,
 * under its own row lock. A client-side copy of that rule would disagree
 * with the database the moment a review landed elsewhere, in the direction
 * of offering a button that fails.
 */

function Message({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
      {state.message}
    </p>
  );
}

function ShareWithClientForm({ projectId, uiVersionId }: { projectId: string; uiVersionId: string }) {
  const [state, action, pending] = useActionState(shareUiVersionWithClientAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">
        AgencyOS cannot send this — there is no channel configured. Send it yourself, then record
        what you sent.
      </p>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="uiVersionId" value={uiVersionId} />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">
          The reference of the message you sent — so this record can point at the thing it claims
        </span>
        <input
          name="evidenceRef"
          required
          className="rounded-md border border-line bg-surface px-2 py-1"
          placeholder="WhatsApp message reference, or a link"
        />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Recording…' : 'Record that it was sent'}
      </button>
      <Message state={state} />
    </form>
  );
}

function RecordClientDecisionForm({ projectId, uiVersionId }: { projectId: string; uiVersionId: string }) {
  const [state, action, pending] = useActionState(recordUiVersionClientDecisionAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="uiVersionId" value={uiVersionId} />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">What the client actually wrote — their words, not a summary</span>
        <textarea
          name="clientWords"
          rows={2}
          required
          className="rounded-md border border-line bg-surface px-2 py-1"
          placeholder="looks good but can we make the header simpler"
        />
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">What that means — Master names exactly two answers here</span>
        <select
          name="decision"
          defaultValue="change_requested"
          className="rounded-md border border-line bg-surface px-2 py-1"
        >
          <option value="change_requested">They want a revision</option>
          <option value="final_confirmed">They approved this exact UI</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">Where to verify this (optional)</span>
        <input
          name="evidenceRef"
          className="rounded-md border border-line bg-surface px-2 py-1"
          placeholder="WhatsApp message reference, or a link"
        />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Recording…' : 'Record what the client said'}
      </button>
      <Message state={state} />
    </form>
  );
}

function LockUiVersionForm({ projectId, uiVersionId }: { projectId: string; uiVersionId: string }) {
  const [state, action, pending] = useActionState(lockUiVersionAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px]">The client confirmed this exact version.</p>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="uiVersionId" value={uiVersionId} />
      <button type="submit" disabled={pending} className={buttonClass()}>
        {pending ? 'Locking…' : 'Lock this UI version'}
      </button>
      <Message state={state} />
    </form>
  );
}

/**
 * Picks the one form the version's current status actually opens — the same
 * status this panel already reads and badges above. `admin_approved` may be
 * shared; `client_review`/`client_change` may receive a decision;
 * `client_approved` may be locked. Every other status has no form here,
 * because there is nothing for a person to do at this gate yet.
 */
export function ClientReviewForms({
  projectId,
  uiVersionId,
  status,
}: {
  projectId: string;
  uiVersionId: string;
  status: string;
}) {
  switch (status) {
    case 'admin_approved':
      return <ShareWithClientForm projectId={projectId} uiVersionId={uiVersionId} />;
    case 'client_review':
    case 'client_change':
      return <RecordClientDecisionForm projectId={projectId} uiVersionId={uiVersionId} />;
    case 'client_approved':
      return <LockUiVersionForm projectId={projectId} uiVersionId={uiVersionId} />;
    default:
      return null;
  }
}
