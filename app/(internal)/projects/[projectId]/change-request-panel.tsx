'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import {
  applyChangeRequestAction,
  classifyChangeRequestAction,
  decideChangeRequestAction,
  submitChangeRequestAction,
} from '@/modules/projects/actions';
import { CHANGE_REQUEST_CLASSIFICATIONS } from '@/modules/projects/schema';
import type { ChangeRequestContext } from '@/modules/projects/change-request-queries';
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

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);

/**
 * SCR-031 — the payment gate as the rows state it. A paid change is decided
 * against a proposal (ADM-22); the proposal's status is the client's answer,
 * and the project's invoice ledger is the money side. Neither is re-derived:
 * an `accepted` proposal with no `paid` invoice is shown as exactly that.
 */
function PaymentGate({ cr, context }: { cr: ChangeRequestRow; context: ChangeRequestContext }) {
  const proposal = cr.proposalId ? context.proposals[cr.proposalId] : undefined;
  const isPaid = cr.classification === 'paid_change';
  if (!isPaid && !proposal) return null;

  return (
    <div className="flex flex-col gap-1 rounded-md border border-line bg-surface-sunken px-3 py-2 text-[13px]">
      <p className="font-medium">Payment gate</p>
      {!proposal ? (
        <p className="text-muted">
          A paid change is approved against a quotation, and none is attached yet — the decision below asks for its id.
        </p>
      ) : (
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-muted">Quotation</span>
          <span>
            {proposal.title} v{proposal.version}
          </span>
          <Badge tone={proposal.status === 'accepted' ? 'success' : proposal.status === 'rejected' ? 'danger' : 'info'}>
            {proposal.status.replace(/_/g, ' ')}
          </Badge>
          <span className="text-muted">{money(proposal.totalMinor, proposal.currency)}</span>
        </p>
      )}
      {!context.invoices.visible ? (
        <p className="text-xs text-muted">Invoice status is not visible to your role.</p>
      ) : context.invoices.byStatus.length === 0 ? (
        <p className="text-xs text-muted">No invoice has been raised on this project.</p>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>Project invoices:</span>
          {context.invoices.byStatus.map((s) => (
            <Badge key={s.status} tone={s.status === 'paid' ? 'success' : s.status === 'overdue' ? 'danger' : 'neutral'}>
              {s.count} {s.status.replace(/_/g, ' ')}
            </Badge>
          ))}
        </p>
      )}
    </div>
  );
}

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
  context,
}: {
  projectId: string;
  changeRequests: ChangeRequestRow[];
  /** milestone.write — classify and apply. */
  mayManage: boolean;
  /** owner only — approve or reject, matching the door's own core.is_owner() gate. */
  mayDecide: boolean;
  /** SCR-031 — proposal, invoice ledger, resulting tasks and the quotation door. */
  context?: ChangeRequestContext;
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

          {context ? <PaymentGate cr={cr} context={context} /> : null}

          {context && (context.tasksByRequest[cr.id]?.length ?? 0) > 0 ? (
            <div className="flex flex-col gap-1 text-[13px]">
              <p className="text-xs font-medium text-muted">Tasks from the resulting baseline</p>
              <ul className="flex flex-wrap gap-1">
                {(context.tasksByRequest[cr.id] ?? []).map((t) => (
                  <li key={t.id}>
                    <Link
                      href={`/projects/${projectId}/development/tasks/${t.id}`}
                      className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 hover:bg-surface-hover"
                    >
                      <span>{t.title}</span>
                      <Badge tone="neutral">{t.status.replace(/_/g, ' ')}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {context && cr.classification === 'paid_change' && !cr.proposalId && context.quoteLeadId ? (
            <Link
              href={`/leads/${context.quoteLeadId}`}
              className="self-start text-xs underline underline-offset-2 hover:text-fg"
            >
              Draft a quotation for this change on the lead →
            </Link>
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
