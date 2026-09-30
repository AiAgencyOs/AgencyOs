'use client';

import { useActionState } from 'react';

import { linkCommitAction } from '@/modules/projects/git-write-actions';
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

export function StartTaskButton({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [state, action, pending] = useActionState(startTaskAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Starting…' : 'Start task'}
      </button>
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
