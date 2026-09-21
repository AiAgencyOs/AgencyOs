'use client';

import { useActionState } from 'react';

import {
  applyChangeRequestAction,
  classifyChangeRequestAction,
  decideChangeRequestAction,
  submitChangeRequestAction,
} from '@/modules/projects/actions';
import { CHANGE_REQUEST_CLASSIFICATIONS } from '@/modules/projects/schema';
import type { ChangeRequestRow } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, FormMessage, buttonClass, inputClass, labelClass, selectClass, textareaClass, type Tone } from '@/ui';

/**
 * Doc 11 §16–§22 — the change-request lifecycle. `submit_change_request`,
 * `classify_change_request`, `decide_change_request` and
 * `apply_change_request` existed with no caller until now: a client-sourced
 * escalation (Phase 3's `possible_scope_change`) auto-opens one through the
 * job handler G-310 added, but nothing rendered the queue it lands in, and an
 * internally-sourced one had no way to be submitted at all.
 *
 * ── the two gates stay visibly different ──────────────────────────────
 *
 * Classify and apply are offered under `milestone.write`, matching
 * `core.can_manage_delivery()`. Decide is separate and stricter — only an
 * owner may approve or reject, because a delivery lead approving their own
 * team's change is the review signing its own homework. This page renders
 * that distinction rather than hiding it behind one shared "canWrite" flag.
 */

const STATUS_TONE: Record<string, Tone> = {
  submitted: 'neutral',
  analysing: 'info',
  classified: 'info',
  pending_approval: 'warning',
  approved: 'success',
  rejected: 'danger',
  implemented: 'success',
  closed: 'neutral',
};

const CLASSIFICATION_LABEL: Record<string, string> = {
  in_scope: 'In scope',
  free_change: 'Free change',
  paid_change: 'Paid change',
  new_project: 'New project',
  clarification: 'Clarification',
  duplicate: 'Duplicate',
  rejected: 'Rejected',
};

const when = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace('T', ' ');

export function SubmitChangeRequestForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(submitChangeRequestAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-col gap-1">
        <label className={labelClass}>What was asked for, in their own words</label>
        <textarea name="requested" required maxLength={4000} className={textareaClass} rows={2} />
      </div>
      <div className="flex flex-col gap-1">
        <label className={labelClass}>Source</label>
        <select name="source" defaultValue="internal" className={selectClass}>
          <option value="internal">Internal — raised by staff</option>
          <option value="client">Client — raised on the client's behalf</option>
        </select>
      </div>
      <button type="submit" disabled={pending} className={`${buttonClass('secondary', 'sm')} self-start`}>
        {pending ? 'Submitting…' : 'Submit a change request'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function ClassifyForm({ projectId, changeRequestId }: { projectId: string; changeRequestId: string }) {
  const [state, action, pending] = useActionState(classifyChangeRequestAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 border-t border-line pt-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="changeRequestId" value={changeRequestId} />
      <div className="flex flex-wrap gap-2">
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Classification</label>
          <select name="classification" required defaultValue="" className={selectClass}>
            <option value="" disabled>
              Choose one
            </option>
            {CHANGE_REQUEST_CLASSIFICATIONS.map((c) => (
              <option key={c} value={c}>
                {CLASSIFICATION_LABEL[c] ?? c}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Timeline (days, optional)</label>
          <input name="timelineDays" type="number" min={0} className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Effort (hours, optional)</label>
          <input name="effortHours" type="number" min={0} step="0.5" className={inputClass} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className={labelClass}>Impact notes (optional)</label>
        <textarea name="impactNotes" maxLength={4000} className={textareaClass} rows={2} />
      </div>
      <button type="submit" disabled={pending} className={`${buttonClass('secondary', 'sm')} self-start`}>
        {pending ? 'Classifying…' : 'Classify'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function DecideForm({ projectId, changeRequestId, classification }: { projectId: string; changeRequestId: string; classification: string | null }) {
  const [state, action, pending] = useActionState(decideChangeRequestAction, IDLE_STATE);
  const needsProposal = classification === 'paid_change';

  return (
    <form action={action} className="flex flex-col gap-2 border-t border-line pt-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="changeRequestId" value={changeRequestId} />
      {needsProposal ? (
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Proposal id (required for a paid change — ADM-22)</label>
          <input name="proposalId" className={inputClass} placeholder="uuid" />
        </div>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          name="decision"
          value="approve"
          disabled={pending}
          className={buttonClass('primary', 'sm')}
        >
          {pending ? 'Deciding…' : 'Approve'}
        </button>
        <button
          type="submit"
          name="decision"
          value="reject"
          disabled={pending}
          className={buttonClass('ghost', 'sm')}
        >
          Reject
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function ApplyButton({ projectId, changeRequestId }: { projectId: string; changeRequestId: string }) {
  const [state, action, pending] = useActionState(applyChangeRequestAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 border-t border-line pt-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="changeRequestId" value={changeRequestId} />
      <button type="submit" disabled={pending} className={`${buttonClass('primary', 'sm')} self-start`}>
        {pending ? 'Applying…' : 'Apply to the baseline'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function ChangeRequestList({
  projectId,
  changeRequests,
  mayManage,
  mayDecide,
}: {
  projectId: string;
  changeRequests: ChangeRequestRow[];
  /** milestone.write — classify and apply. */
  mayManage: boolean;
  /** owner only — approve or reject, matching the door's own core.is_owner() gate. */
  mayDecide: boolean;
}) {
  if (changeRequests.length === 0) {
    return <p className="text-[13px] text-muted">No change request has been raised for this project.</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {changeRequests.map((cr) => (
        <li key={cr.id} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[cr.status] ?? 'neutral'}>{cr.status.replace(/_/g, ' ')}</Badge>
            {cr.classification ? (
              <Badge tone="info">{CLASSIFICATION_LABEL[cr.classification] ?? cr.classification}</Badge>
            ) : null}
            <span className="text-xs text-muted">{cr.source} · {when(cr.createdAt)}</span>
          </div>
          <p className="max-w-2xl text-[13px]">“{cr.requested}”</p>
          {cr.impactNotes ? <p className="text-[13px] text-muted">{cr.impactNotes}</p> : null}
          {cr.timelineDays !== null || cr.effortHours !== null ? (
            <p className="text-xs text-muted">
              {cr.timelineDays !== null ? `${cr.timelineDays} day${cr.timelineDays === 1 ? '' : 's'}` : null}
              {cr.timelineDays !== null && cr.effortHours !== null ? ' · ' : null}
              {cr.effortHours !== null ? `${cr.effortHours}h estimated` : null}
            </p>
          ) : null}
          {cr.resultingScopeVersionId ? (
            <p className="text-xs text-muted">
              opened scope version <code className="text-fg">{cr.resultingScopeVersionId}</code>
            </p>
          ) : null}

          {/* Offered strictly from the stored status — the doors decide again. */}
          {mayManage && ['submitted', 'analysing', 'classified'].includes(cr.status) ? (
            <ClassifyForm projectId={projectId} changeRequestId={cr.id} />
          ) : null}
          {mayDecide && ['classified', 'pending_approval'].includes(cr.status) ? (
            <DecideForm projectId={projectId} changeRequestId={cr.id} classification={cr.classification} />
          ) : null}
          {mayManage && cr.status === 'approved' ? (
            <ApplyButton projectId={projectId} changeRequestId={cr.id} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
