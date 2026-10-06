'use client';

import { useActionState } from 'react';

import {
  classifyBuildFeedbackAction,
  decideBuildAdminAction,
  recordBuildFeedbackAction,
  recordBuildQaAction,
  recordCodeReviewAction,
  shareBuildWithClientAction,
} from '@/modules/projects/phase-five-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass } from '@/ui';

/**
 * The Phase 5 doors, with a form each. Nothing here decides whether an action is allowed: the database door refuses (independence, gates,
 * state) and its refusal is shown as written. Each form is a collapsed <details> so the overview stays a read first.
 */

function Message({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
      {state.message}
    </p>
  );
}

const field = 'rounded-md border border-line bg-surface px-2 py-1';

function Hidden({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  return (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="deliverableId" value={deliverableId} />
    </>
  );
}

function QaForm({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  const [state, action, pending] = useActionState(recordBuildQaAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">Independent QA of this exact build. Whoever built it cannot pass it.</p>
      <Hidden projectId={projectId} deliverableId={deliverableId} />
      <select aria-label="QA outcome" name="outcome" defaultValue="passed" className={field}>
        <option value="passed">Passed</option>
        <option value="changes_required">Changes required</option>
      </select>
      <textarea aria-label="Note" name="note" rows={2} className={field} placeholder="What was tested (required when changes are required)" />
      <input aria-label="Evidence link" name="evidenceUrl" className={field} placeholder="https:// link to the test evidence (optional)" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Recording…' : 'Record QA verdict'}</button>
      <Message state={state} />
    </form>
  );
}

function ReviewForm({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  const [state, action, pending] = useActionState(recordCodeReviewAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">Independent code and security review of the exact commit. A critical or high finding cannot pass.</p>
      <Hidden projectId={projectId} deliverableId={deliverableId} />
      <select aria-label="Review verdict" name="verdict" defaultValue="passed" className={field}>
        <option value="passed">Passed</option>
        <option value="changes_required">Changes required</option>
        <option value="blocked">Blocked</option>
      </select>
      <textarea aria-label="Review findings, one per line" name="findings" rows={3} className={field} placeholder={'One finding per line, e.g.\nhigh: SQL built from user input\nlow: naming'} />
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" name="changedCode" /> I changed the code myself while reviewing (a second reviewer will be required)
      </label>
      <input aria-label="Note" name="note" className={field} placeholder="Note (optional)" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Recording…' : 'Record review'}</button>
      <Message state={state} />
    </form>
  );
}

function AdminForm({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  const [state, action, pending] = useActionState(decideBuildAdminAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">Admin decision on a build QA has passed. EDIT goes back to development, never to the client.</p>
      <Hidden projectId={projectId} deliverableId={deliverableId} />
      <select aria-label="Admin decision" name="decision" defaultValue="approved" className={field}>
        <option value="approved">Approve</option>
        <option value="changes_required">Edit (changes required)</option>
      </select>
      <textarea aria-label="Note" name="note" rows={2} className={field} placeholder="Note (required for an edit)" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Recording…' : 'Record decision'}</button>
      <Message state={state} />
    </form>
  );
}

function ShareForm({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  const [state, action, pending] = useActionState(shareBuildWithClientAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">Share this exact build for client testing. The database refuses unless it has a commit, a build run, a passed review, QA and Admin approval.</p>
      <Hidden projectId={projectId} deliverableId={deliverableId} />
      <button type="submit" disabled={pending} className={buttonClass()}>{pending ? 'Sharing…' : 'Share with the client'}</button>
      <Message state={state} />
    </form>
  );
}

function FeedbackForm({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  const [state, action, pending] = useActionState(recordBuildFeedbackAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">The client&apos;s own words about this build, not a summary.</p>
      <Hidden projectId={projectId} deliverableId={deliverableId} />
      <textarea aria-label="What the client wrote" name="clientWords" rows={2} required className={field} placeholder="What the client wrote" />
      <input aria-label="Message reference" name="evidenceRef" className={field} placeholder="Message reference (optional)" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Recording…' : 'Record feedback'}</button>
      <Message state={state} />
    </form>
  );
}

/** The actions a person can take on one development build. */
export function BuildActions({ projectId, deliverableId, status }: { projectId: string; deliverableId: string; status: string }) {
  const open = status === 'draft' || status === 'changes_requested';
  const shared = status === 'in_review' || status === 'changes_requested' || status === 'approved';
  return (
    <div className="flex flex-col gap-2 pl-4">
      {open ? (
        <>
          <details><summary className="cursor-pointer text-xs underline underline-offset-2">QA verdict</summary><QaForm projectId={projectId} deliverableId={deliverableId} /></details>
          <details><summary className="cursor-pointer text-xs underline underline-offset-2">Code review</summary><ReviewForm projectId={projectId} deliverableId={deliverableId} /></details>
          <details><summary className="cursor-pointer text-xs underline underline-offset-2">Admin decision</summary><AdminForm projectId={projectId} deliverableId={deliverableId} /></details>
          <details><summary className="cursor-pointer text-xs underline underline-offset-2">Share with the client</summary><ShareForm projectId={projectId} deliverableId={deliverableId} /></details>
        </>
      ) : null}
      {shared ? (
        <details><summary className="cursor-pointer text-xs underline underline-offset-2">Record client feedback</summary><FeedbackForm projectId={projectId} deliverableId={deliverableId} /></details>
      ) : null}
    </div>
  );
}

const CLASSES: [string, string][] = [
  ['bug', 'Bug'],
  ['missed_requirement', 'Missed requirement'],
  ['ui_mismatch', 'UI mismatch'],
  ['included_small_revision', 'Included small revision'],
  ['clarification', 'Clarification'],
  ['possible_scope_change', 'Possible scope change'],
  ['new_feature', 'New feature'],
];

export function ClassifyFeedbackForm({ projectId, feedbackId }: { projectId: string; feedbackId: string }) {
  const [state, action, pending] = useActionState(classifyBuildFeedbackAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="feedbackId" value={feedbackId} />
      <select aria-label="Feedback classification" name="classification" defaultValue="bug" className={field}>
        {CLASSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Routing…' : 'Classify and route'}</button>
      <Message state={state} />
    </form>
  );
}
