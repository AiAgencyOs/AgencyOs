'use client';

import { useActionState } from 'react';

import { createTaskBranchAction, linkCommitAction, mergePullRequestAction, setRepositoryWorkflowAction, submitReviewAction } from '@/modules/projects/git-write-actions';
import { REVIEW_EVENTS } from '@/modules/projects/git-write-schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

/**
 * Git is written — Decision: reversed by the owner on 2026-09-30. The three
 * write doors (branch, review, merge), the commit link and the workflow
 * file, as forms over the server actions. Each refusal — no token, a token
 * without `repo` scope, a red check, a database that would not record it —
 * is shown in the door's own words.
 */

type TaskOption = { id: string; title: string; status: string };
type PullOption = { number: number; title: string };

export function CreateTaskBranchPanel({ projectId, tasks }: { projectId: string; tasks: TaskOption[] }) {
  const [state, action, pending] = useActionState(createTaskBranchAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Task</span>
        <select name="taskId" className={selectClass} required disabled={tasks.length === 0}>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title} ({t.status.replace('_', ' ')})
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending || tasks.length === 0} className={buttonClass('primary', 'sm')}>
          {pending ? 'Creating…' : 'Create task branch'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
      <p className="text-xs text-muted">
        Creates <code>task/&lt;id&gt;-&lt;slug&gt;</code> from GitHub&apos;s default branch and records it here.
      </p>
    </form>
  );
}

export function SubmitReviewPanel({ projectId, pulls }: { projectId: string; pulls: PullOption[] }) {
  const [state, action, pending] = useActionState(submitReviewAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_11rem]">
        <div className="flex flex-col gap-1">
          <span className={labelClass}>Pull request</span>
          {pulls.length > 0 ? (
            <select name="pullNumber" aria-label="Pull request" className={selectClass} required>
              {pulls.map((p) => (
                <option key={p.number} value={p.number}>
                  #{p.number} — {p.title}
                </option>
              ))}
            </select>
          ) : (
            <input name="pullNumber" type="number" min={1} required aria-label="Pull request number" className={inputClass} placeholder="PR number" />
          )}
        </div>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Verdict</span>
          <select name="event" className={selectClass} defaultValue="COMMENT">
            {REVIEW_EVENTS.map((e) => (
              <option key={e} value={e}>
                {e === 'APPROVE' ? 'Approve' : e === 'REQUEST_CHANGES' ? 'Request changes' : 'Comment'}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Review</span>
        <textarea name="body" rows={3} maxLength={4000} className={textareaClass} placeholder="What was reviewed and what was found. Required unless approving." />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Submitting…' : 'Submit review'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function MergePullRequestPanel({ projectId, pulls }: { projectId: string; pulls: PullOption[] }) {
  const [state, action, pending] = useActionState(mergePullRequestAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-col gap-1">
        <span className={labelClass}>Pull request</span>
        {pulls.length > 0 ? (
          <select name="pullNumber" aria-label="Pull request" className={selectClass} required>
            {pulls.map((p) => (
              <option key={p.number} value={p.number}>
                #{p.number} — {p.title}
              </option>
            ))}
          </select>
        ) : (
          <input name="pullNumber" type="number" min={1} required aria-label="Pull request number" className={inputClass} placeholder="PR number" />
        )}
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('danger', 'sm')}>
          {pending ? 'Merging…' : 'Approve and squash-merge'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
      <p className="text-xs text-muted">Refused while any check run on the head is failed or still running; GitHub decides the rest.</p>
    </form>
  );
}

export function LinkCommitToTaskPanel({ projectId, tasks, defaultSha }: { projectId: string; tasks: TaskOption[]; defaultSha?: string }) {
  const [state, action, pending] = useActionState(linkCommitAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex min-w-48 flex-col gap-1">
        <span className={labelClass}>Task</span>
        <select name="taskId" className={selectClass} required disabled={tasks.length === 0}>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Commit sha</span>
        <input name="sha" required pattern="[0-9a-fA-F]{7,40}" defaultValue={defaultSha ?? ''} className={inputClass} placeholder="abc1234" />
      </label>
      <label className="flex min-w-48 flex-col gap-1">
        <span className={labelClass}>Link</span>
        <input name="url" maxLength={2000} className={inputClass} placeholder="https://github.com/…/commit/… (optional)" />
      </label>
      <button type="submit" disabled={pending || tasks.length === 0} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Linking…' : 'Link commit'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function WorkflowFilePanel({ projectId, current }: { projectId: string; current: string | null }) {
  const [state, action, pending] = useActionState(setRepositoryWorkflowAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex min-w-56 flex-col gap-1">
        <span className={labelClass}>Build workflow file (.github/workflows/)</span>
        <input name="workflowFile" maxLength={130} defaultValue={current ?? ''} className={inputClass} placeholder="deploy.yml — blank: record only" />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Set workflow'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
