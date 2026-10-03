'use client';

import { useActionState } from 'react';

import { linkCommitAction } from '@/modules/projects/git-write-actions';
import { setTaskArchivedAction, setTaskStatusAction } from '@/modules/projects/actions';
import { markTaskReadyForQaAction, reopenTaskFromDefectAction, startTaskAction, submitTaskEvidenceAction } from '@/modules/projects/task-doors-actions';
import { EVIDENCE_KINDS } from '@/modules/projects/task-doors-schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

/**
 * SCR-041 — the task page's doors (migration 20261001130000): start, mark
 * ready for QA, submit evidence, reopen from an open defect, and link a
 * commit. Each is one server action; each refusal is the database's
 * sentence, shown verbatim. Which buttons are drawn follows the status, so
 * the ordinary outcome of a click is not a refusal.
 */

/** `blockedReason` is the requirement / dependency check's sentence (Q-C3): the button is disabled and says why. */
export function StartTaskButton({ projectId, taskId, blockedReason = null }: { projectId: string; taskId: string; blockedReason?: string | null }) {
  const [state, action, pending] = useActionState(startTaskAction, IDLE_STATE);
  const reasonId = `start-blocked-${taskId}`;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <button type="submit" disabled={pending || blockedReason !== null} aria-describedby={blockedReason ? reasonId : undefined} className={buttonClass('primary', 'sm')}>
        {pending ? 'Starting…' : 'Start task'}
      </button>
      {blockedReason ? (
        <span id={reasonId} className="text-xs text-warning">
          {blockedReason}
        </span>
      ) : null}
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function ReadyForQaButton({ projectId, taskId, evidenceCount }: { projectId: string; taskId: string; evidenceCount: number }) {
  const [state, action, pending] = useActionState(markTaskReadyForQaAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <button type="submit" disabled={pending} className={buttonClass(evidenceCount > 0 ? 'primary' : 'secondary', 'sm')} title={evidenceCount === 0 ? 'Submit evidence first' : undefined}>
        {pending ? 'Marking…' : 'Mark ready for QA'}
      </button>
      {evidenceCount === 0 ? <span className="text-xs text-warning">needs evidence first</span> : null}
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function SubmitEvidencePanel({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [state, action, pending] = useActionState(submitTaskEvidenceAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[8rem_1fr]">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Kind</span>
          <select name="kind" className={selectClass} defaultValue="test">
            {EVIDENCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Title</span>
          <input name="title" required maxLength={200} className={inputClass} placeholder="e.g. CI run #412, screenshot of the settled state" />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Link</span>
        <input name="url" maxLength={2000} className={inputClass} placeholder="https://… (a link, a note, or both)" />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Note</span>
        <textarea name="note" rows={2} maxLength={4000} className={textareaClass} placeholder="What it shows." />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Submitting…' : 'Submit evidence'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function ReopenFromDefectPanel({ projectId, taskId, defects }: { projectId: string; taskId: string; defects: { id: string; title: string; severity: string }[] }) {
  const [state, action, pending] = useActionState(reopenTaskFromDefectAction, IDLE_STATE);
  if (defects.length === 0) return null;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <select name="defectId" className={selectClass} aria-label="Open defect" required>
        {defects.map((d) => (
          <option key={d.id} value={d.id}>
            {d.severity} — {d.title}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={buttonClass('danger', 'sm')}>
        {pending ? 'Reopening…' : 'Reopen after QA failure'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function LinkCommitPanel({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [state, action, pending] = useActionState(linkCommitAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Commit sha</span>
        <input name="sha" required pattern="[0-9a-fA-F]{7,40}" className={inputClass} placeholder="abc1234" />
      </label>
      <label className="flex min-w-48 flex-col gap-1">
        <span className={labelClass}>Link</span>
        <input name="url" maxLength={2000} className={inputClass} placeholder="https://github.com/…/commit/… (optional)" />
      </label>
      <label className="flex min-w-48 flex-col gap-1">
        <span className={labelClass}>Message</span>
        <input name="message" maxLength={500} className={inputClass} placeholder="first line (optional)" />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Linking…' : 'Link commit'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

/**
 * T1-1 — cancel, reopen and archive. Cancel is offered while the task is open (to its assignee and the roster
 * managers); a cancelled task is reopened to To do by a roster manager; archive and restore are the roster managers'.
 * Each is one audited server action; a refusal is the database's own sentence.
 */
export function TaskLifecycleControls({ projectId, taskId, status, archived, canCancel, canManage }: { projectId: string; taskId: string; status: string; archived: boolean; canCancel: boolean; canManage: boolean }) {
  const [statusState, statusAction, statusPending] = useActionState(setTaskStatusAction, IDLE_STATE);
  const [archiveState, archiveAction, archivePending] = useActionState(setTaskArchivedAction, IDLE_STATE);
  const open = ['todo', 'in_progress', 'blocked', 'in_review'].includes(status);
  const nothing = !(canCancel && open && !archived) && !(canManage && status === 'cancelled' && !archived) && !canManage;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {canCancel && open && !archived ? (
        <form action={statusAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="status" value="cancelled" />
          {/* U1-2: a cancel says why; the assignee is told. */}
          <label className="flex flex-col gap-1 text-[13px] text-muted">
            Reason for cancelling (required)
            <input name="reason" required maxLength={1000} placeholder="Why is this task cancelled?" className="h-8 min-w-64 rounded-md border border-line-strong bg-surface px-2 text-[13px] text-foreground" />
          </label>
          <button type="submit" disabled={statusPending} className={buttonClass('secondary', 'sm')}>
            {statusPending ? 'Cancelling…' : 'Cancel task'}
          </button>
          <FormMessage status={statusState.status} message={statusState.message} />
        </form>
      ) : null}
      {canManage && status === 'cancelled' && !archived ? (
        <form action={statusAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="status" value="todo" />
          <button type="submit" disabled={statusPending} className={buttonClass('secondary', 'sm')}>
            {statusPending ? 'Reopening…' : 'Reopen to To do'}
          </button>
          <FormMessage status={statusState.status} message={statusState.message} />
        </form>
      ) : null}
      {canManage ? (
        <form action={archiveAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
          <button type="submit" disabled={archivePending} className={buttonClass('secondary', 'sm')}>
            {archivePending ? 'Saving…' : archived ? 'Restore task' : 'Archive task'}
          </button>
          <FormMessage status={archiveState.status} message={archiveState.message} />
        </form>
      ) : null}
      {nothing ? <span className="text-[13px] text-muted">{archived ? 'This task is archived and read-only.' : status === 'cancelled' ? 'This task is cancelled.' : 'Only the assignee or a delivery lead cancels or archives a task.'}</span> : null}
    </div>
  );
}
