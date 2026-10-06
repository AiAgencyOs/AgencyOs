'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import {
  recordBuildRevisionAction,
  recordShareDeliveryAction,
  resolveRevisionEscalationAction,
  shareBuildForReviewAction,
} from '@/modules/projects/pm-depth-actions';
import { buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/** The PM depth doors, one collapsed form each. The database door refuses; its refusal is shown as written. */

function Message({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
      {state.message}
    </p>
  );
}

type Build = { id: string; version: number; title: string };

export function ShareBuildForm({ projectId, builds }: { projectId: string; builds: Build[] }) {
  const [state, action, pending] = useActionState(shareBuildForReviewAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label className={labelClass}>Build
        <select name="deliverableId" className={selectClass} required>
          {builds.map((b) => <option key={b.id} value={b.id}>v{b.version} - {b.title}</option>)}
        </select>
      </label>
      <label className={labelClass}>Platform to test on<input name="reviewPlatform" className={inputClass} maxLength={60} required /></label>
      <label className={labelClass}>Review link (https)<input name="reviewUrl" className={inputClass} maxLength={500} required /></label>
      <label className={labelClass}>How to test it<textarea name="testingInstructions" className={inputClass} rows={3} maxLength={2000} required /></label>
      <button type="submit" className={buttonClass('primary')} disabled={pending}>Record the review share</button>
      <Message state={state} />
    </form>
  );
}

export function ShareDeliveryForm({ projectId, shareId }: { projectId: string; shareId: string }) {
  const [state, action, pending] = useActionState(recordShareDeliveryAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="shareId" value={shareId} />
      <select name="state" className={selectClass} aria-label="Delivery outcome">
        <option value="relayed">Relayed to the client</option>
        <option value="failed">Did not reach the client</option>
      </select>
      <input name="note" className={inputClass} placeholder="Note (optional)" maxLength={500} />
      <button type="submit" className={buttonClass('secondary')} disabled={pending}>Record</button>
      <Message state={state} />
    </form>
  );
}

export function RecordRevisionForm({ projectId, builds, features }: { projectId: string; builds: Build[]; features: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(recordBuildRevisionAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label className={labelClass}>Origin
        <select name="origin" className={selectClass} required>
          <option value="client">Client (spends the included allowance)</option>
          <option value="admin">Admin (spends nothing)</option>
          <option value="qa_correction">QA correction (spends nothing)</option>
          <option value="approved_change_request">Approved Change Request (spends nothing)</option>
        </select>
      </label>
      <label className={labelClass}>From build
        <select name="fromDeliverableId" className={selectClass} required>{builds.map((b) => <option key={b.id} value={b.id}>v{b.version}</option>)}</select>
      </label>
      <label className={labelClass}>To build (the revised one)
        <select name="toDeliverableId" className={selectClass} required>{builds.map((b) => <option key={b.id} value={b.id}>v{b.version}</option>)}</select>
      </label>
      <label className={labelClass}>Features touched
        <select name="featureIds" className={selectClass} multiple>{features.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
      </label>
      <label className={labelClass}>Change Request id (approved-change only)<input name="changeRequestId" className={inputClass} /></label>
      <label className={labelClass}>Why<textarea name="reason" className={inputClass} rows={2} maxLength={1000} required /></label>
      <button type="submit" className={buttonClass('primary')} disabled={pending}>Record the revision</button>
      <Message state={state} />
    </form>
  );
}

export function ResolveEscalationForm({ projectId, escalationId }: { projectId: string; escalationId: string }) {
  const [state, action, pending] = useActionState(resolveRevisionEscalationAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="escalationId" value={escalationId} />
      <select name="decision" className={selectClass} aria-label="Decision">
        <option value="extra_rounds_granted">Grant extra rounds</option>
        <option value="handled_as_change_request">Handle as a Change Request</option>
        <option value="declined">Decline</option>
      </select>
      <input name="extraRounds" type="number" min={0} max={10} defaultValue={0} className={inputClass} aria-label="Extra rounds" />
      <input name="note" className={inputClass} placeholder="Reason (required)" required />
      <button type="submit" className={buttonClass('primary')} disabled={pending}>Decide</button>
      <Message state={state} />
    </form>
  );
}
