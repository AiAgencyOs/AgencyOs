'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useId, useRef, type FormEvent } from 'react';

import { IDLE_STATE, type FormState } from '@/modules/identity/types';
import { setTaskStatusAction } from '@/modules/projects/actions';
import {
  addChecklistItemAction,
  addTaskAttachmentAction,
  addTaskCommentAction,
  removeChecklistItemAction,
  removeTaskAttachmentAction,
  setChecklistItemDoneAction,
} from '@/modules/projects/task-collab-actions';
import { markTaskAgentAction, verifyAgentTaskAction } from '@/modules/projects/task-origin-actions';
import { ReadyForQaButton, StartTaskButton, SubmitEvidencePanel } from './projects/[projectId]/development/tasks/[taskId]/task-doors-panel';
import { TASK_EVIDENCE_KINDS } from '@/modules/projects/task-collab-schema';
import type { TaskCollab } from '@/modules/projects/task-collab-types';
import {
  Avatar,
  Badge,
  buttonClass,
  Callout,
  cx,
  FormMessage,
  IconAlert,
  IconArrowUpRight,
  IconAttach,
  IconCheck,
  IconClose,
  IconMessage,
  IconPlus,
  inputClass,
  labelClass,
  ProgressBar,
  selectClass,
  textareaClass,
} from '@/ui';
import { BLOCKER_TYPE_LABEL, BLOCKER_TYPES, type BlockerType } from '@/modules/projects/task-blocker';

/**
 * The collaborative half of a task — SCR-020 / SCR-021 / SCR-041: the
 * blocker, the checklist with its progress, comments and attached links.
 * One component for the three surfaces that draw a task (the Board drawer,
 * the My Tasks drawer, the task page), so they cannot drift. Every write
 * is a Server Action through task-collab-actions.ts; the page is refreshed
 * after each success so the rows the drawer shows are the rows the server
 * has, never an optimistic copy. Refusals are shown beside the control
 * that earned them.
 */

/** Refresh the server-rendered rows once per successful action result. */
function useRefreshOnSuccess(state: FormState) {
  const router = useRouter();
  const handled = useRef<FormState | null>(null);
  useEffect(() => {
    if (state.status === 'success' && handled.current !== state) {
      handled.current = state;
      router.refresh();
    }
  }, [state, router]);
}

export function TaskCollabPanel({
  projectId,
  taskId,
  status,
  collab,
  canWrite,
  compact = false,
}: {
  projectId: string;
  taskId: string;
  status: string;
  collab: TaskCollab;
  canWrite: boolean;
  /** Drawer sizing: tighter headings and spacing. */
  compact?: boolean;
}) {
  return (
    <div className={cx('flex flex-col', compact ? 'gap-4' : 'gap-5')}>
      {status === 'blocked' ? <BlockedSection projectId={projectId} taskId={taskId} collab={collab} canWrite={canWrite} /> : null}
      <ReviewSection projectId={projectId} taskId={taskId} status={status} collab={collab} canWrite={canWrite} />
      <AgentWorkSection projectId={projectId} taskId={taskId} status={status} collab={collab} canWrite={canWrite} />
      <ChecklistSection projectId={projectId} taskId={taskId} collab={collab} canWrite={canWrite} compact={compact} />
      <CommentsSection projectId={projectId} taskId={taskId} collab={collab} canWrite={canWrite} compact={compact} />
      <AttachmentsSection projectId={projectId} taskId={taskId} collab={collab} canWrite={canWrite} compact={compact} />
    </div>
  );
}

function SectionHeading({ icon, title, meta }: { icon: React.ReactNode; title: string; meta?: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
      {icon}
      {title}
      {meta ? <span className="ml-auto font-normal normal-case tracking-normal">{meta}</span> : null}
    </h3>
  );
}

/** A hidden pair every collaboration form carries so the right pages are revalidated. */
function TaskKeys({ projectId, taskId }: { projectId: string; taskId: string }) {
  return (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
    </>
  );
}

// ── Hand-off to review ─────────────────────────────────────────────────────

/**
 * SCR-020/021 — "Submit for review" asks for evidence. The hand-off is the
 * evidence-gated door (`mark_task_ready_for_qa`: needs evidence, never while
 * blocked), not a bare status change; start is its own door too. Drawn only
 * where the next step is one of these, so an ordinary click is not a refusal.
 */
function ReviewSection({ projectId, taskId, status, collab, canWrite }: { projectId: string; taskId: string; status: string; collab: TaskCollab; canWrite: boolean }) {
  if (!canWrite || (status !== 'todo' && status !== 'in_progress')) return null;
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-3 text-[13px]" aria-label="Hand-off to review">
      <SectionHeading icon={<IconCheck size={13} />} title={status === 'todo' ? 'Start work' : 'Submit for review'} meta={status === 'in_progress' ? <span className="tabular text-xs text-muted">{collab.evidenceCount} evidence</span> : null} />
      {status === 'todo' ? (
        <StartTaskButton projectId={projectId} taskId={taskId} />
      ) : (
        <>
          <p className="text-muted">A task goes to review with evidence of what was done. Add it, then hand the task off.</p>
          <details>
            <summary className="cursor-pointer text-xs font-medium text-brand">Add evidence</summary>
            <div className="mt-2">
              <SubmitEvidencePanel projectId={projectId} taskId={taskId} />
            </div>
          </details>
          <ReadyForQaButton projectId={projectId} taskId={taskId} evidenceCount={collab.evidenceCount} />
        </>
      )}
    </section>
  );
}

// ── Agent-generated work ───────────────────────────────────────────────────

/**
 * SCR-020 — "Agent-generated work is not complete until required verification
 * passes". Marks where the work came from and holds the gate: the database
 * refuses to move an unverified agent task to Done, so this is where it is verified.
 */
function AgentWorkSection({ projectId, taskId, status, collab, canWrite }: { projectId: string; taskId: string; status: string; collab: TaskCollab; canWrite: boolean }) {
  const [markState, markAction, markPending] = useActionState(markTaskAgentAction, IDLE_STATE);
  const [verifyState, verifyAction, verifyPending] = useActionState(verifyAgentTaskAction, IDLE_STATE);
  useRefreshOnSuccess(markState);
  useRefreshOnSuccess(verifyState);
  const noteId = useId();
  const { origin } = collab;

  if (origin.kind === 'human') {
    if (!canWrite || status === 'done') return null;
    return (
      <form action={markAction} className="flex items-center gap-2">
        <TaskKeys projectId={projectId} taskId={taskId} />
        <input type="hidden" name="agent" value="true" />
        <button type="submit" disabled={markPending} className={buttonClass('ghost', 'sm')}>
          {markPending ? 'Marking…' : 'Mark as agent-generated'}
        </button>
        <FormMessage status={markState.status} message={markState.message} />
      </form>
    );
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-3 text-[13px]" aria-label="Agent-generated work">
      <SectionHeading
        icon={<IconCheck size={13} />}
        title="Agent-generated work"
        meta={origin.verifiedAt ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Unverified</Badge>}
      />
      {origin.verifiedAt ? (
        <p className="text-muted">
          Verified by {origin.verifiedByName ?? 'a member'} on {origin.verifiedLabel}
          {origin.note ? <>: <span className="text-foreground">{origin.note}</span></> : null}
        </p>
      ) : (
        <>
          <p className="text-muted">Produced by an agent. It cannot be completed until a person has checked it.</p>
          {canWrite ? (
            <form action={verifyAction} className="flex flex-col gap-1.5">
              <TaskKeys projectId={projectId} taskId={taskId} />
              <label className={labelClass} htmlFor={noteId}>
                What did you check?
              </label>
              <textarea id={noteId} name="note" required maxLength={1000} rows={2} className={textareaClass} placeholder="The tests you ran, the output you read" />
              <div>
                <button type="submit" disabled={verifyPending} className={buttonClass('secondary', 'sm')}>
                  {verifyPending ? 'Verifying…' : 'Verify this work'}
                </button>
              </div>
              <FormMessage status={verifyState.status} message={verifyState.message} />
            </form>
          ) : null}
        </>
      )}
      {canWrite && !origin.verifiedAt && status !== 'done' ? (
        <form action={markAction} className="flex items-center gap-2">
          <TaskKeys projectId={projectId} taskId={taskId} />
          <input type="hidden" name="agent" value="false" />
          <button type="submit" disabled={markPending} className="text-xs text-muted underline-offset-2 hover:underline">
            Not agent work
          </button>
          <FormMessage status={markState.status} message={markState.message} />
        </form>
      ) : null}
    </section>
  );
}

// ── Blocked ────────────────────────────────────────────────────────────────

function BlockedSection({ projectId, taskId, collab, canWrite }: { projectId: string; taskId: string; collab: TaskCollab; canWrite: boolean }) {
  const [state, action, pending] = useActionState(setTaskStatusAction, IDLE_STATE);
  useRefreshOnSuccess(state);
  return (
    <Callout tone="danger" icon={<IconAlert size={16} />} title="Blocked">
      <div className="flex flex-col gap-2 text-[13px]">
        {collab.blocked.reason ? (
          <p className="whitespace-pre-wrap">{collab.blocked.reason}</p>
        ) : (
          <p className="text-muted">No reason was recorded when this task was blocked.</p>
        )}
        {collab.blocked.type || collab.blocked.owner || collab.blocked.nextAction ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
            <dt className="text-muted">Kind</dt>
            <dd>{collab.blocked.type ? (BLOCKER_TYPE_LABEL[collab.blocked.type as BlockerType] ?? collab.blocked.type) : '—'}</dd>
            <dt className="text-muted">Owner</dt>
            <dd>{collab.blocked.owner ?? '—'}</dd>
            <dt className="text-muted">Next action</dt>
            <dd>{collab.blocked.nextAction ?? '—'}</dd>
          </dl>
        ) : (
          <p className="text-xs text-muted">No type, owner or next action was recorded when this task was blocked.</p>
        )}
        {collab.blocked.sinceLabel ? <p className="text-xs text-muted">Since {collab.blocked.sinceLabel}</p> : null}
        {canWrite ? (
          <form action={action} className="flex flex-col gap-1.5">
            <TaskKeys projectId={projectId} taskId={taskId} />
            <input type="hidden" name="status" value="blocked" />
            <label className={labelClass} htmlFor={`blocked-reason-${taskId}`}>
              {collab.blocked.reason ? 'Update the reason' : 'Record the reason'}
            </label>
            <div className="flex items-start gap-2">
              <input id={`blocked-reason-${taskId}`} name="reason" required maxLength={1000} defaultValue={collab.blocked.reason ?? ''} className={inputClass} placeholder="What is it waiting on?" />
            </div>
            <BlockerFields taskId={`update-${taskId}`} defaults={collab.blocked} />
            <div>
              <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
                {pending ? 'Saving…' : 'Save'}
              </button>
            </div>
            <FormMessage status={state.status} message={state.message} />
          </form>
        ) : null}
      </div>
    </Callout>
  );
}

/**
 * The reason a status control asks for before it moves a task to Blocked —
 * SCR-020/021. Rendered inside the same form as the status select, so the
 * reason travels with the status in one submit and the door that requires
 * it (`setTaskStatus`) is the only judge.
 */
export function BlockReasonField({ taskId, autoFocus = true }: { taskId: string; autoFocus?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-danger/40 bg-danger-soft/40 p-2.5">
      <label className={labelClass} htmlFor={`block-reason-${taskId}`}>
        Blocked on what?
      </label>
      <input
        id={`block-reason-${taskId}`}
        name="reason"
        required
        maxLength={1000}
        autoFocus={autoFocus}
        className={inputClass}
        placeholder="The thing this task is waiting for"
      />
      <BlockerFields taskId={taskId} />
      <p className="text-[11px] text-muted">A task is not moved to Blocked without a type, an owner and a next action; they are shown on the card and recorded on the audit trail.</p>
    </div>
  );
}

/** SCR-020: the blocker's type, who has to act, and what happens next. */
export function BlockerFields({ taskId, defaults }: { taskId: string; defaults?: { type: string | null; owner: string | null; nextAction: string | null } }) {
  return (
    <>
      <label className={labelClass} htmlFor={`block-type-${taskId}`}>
        Kind of blocker
      </label>
      <select id={`block-type-${taskId}`} name="blockerType" required defaultValue={defaults?.type ?? ''} className={selectClass}>
        <option value="" disabled>
          Choose…
        </option>
        {BLOCKER_TYPES.map((t) => (
          <option key={t} value={t}>
            {BLOCKER_TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      <label className={labelClass} htmlFor={`block-owner-${taskId}`}>
        Who has to act
      </label>
      <input id={`block-owner-${taskId}`} name="blockerOwner" required maxLength={120} defaultValue={defaults?.owner ?? ''} className={inputClass} placeholder="A person or a role, e.g. the client’s PM" />
      <label className={labelClass} htmlFor={`block-next-${taskId}`}>
        Next action
      </label>
      <input id={`block-next-${taskId}`} name="nextAction" required maxLength={500} defaultValue={defaults?.nextAction ?? ''} className={inputClass} placeholder="What happens next to unblock it" />
    </>
  );
}

/** The blocker a form carries, or null while any part is missing — for the client-side Board prompts. */
export function readBlocker(form: HTMLFormElement): { reason: string; blockerType: string; blockerOwner: string; nextAction: string } | null {
  const data = new FormData(form);
  const pick = (key: string) => String(data.get(key) ?? '').trim();
  const blocker = { reason: pick('reason'), blockerType: pick('blockerType'), blockerOwner: pick('blockerOwner'), nextAction: pick('nextAction') };
  return blocker.reason && blocker.blockerType && blocker.blockerOwner && blocker.nextAction ? blocker : null;
}

// ── Checklist ──────────────────────────────────────────────────────────────

function ChecklistSection({ projectId, taskId, collab, canWrite, compact }: { projectId: string; taskId: string; collab: TaskCollab; canWrite: boolean; compact: boolean }) {
  const [addState, addAction, addPending] = useActionState(addChecklistItemAction, IDLE_STATE);
  useRefreshOnSuccess(addState);
  const addForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (addState.status === 'success') addForm.current?.reset();
  }, [addState]);

  const { done, total, percent } = collab.progress;
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading
        icon={<IconCheck size={13} />}
        title="Checklist"
        meta={total > 0 ? <span className="tabular text-xs text-muted">{done} of {total}</span> : null}
      />
      {total > 0 ? <ProgressBar value={percent} label="Checklist progress" tone={percent === 100 ? 'success' : 'brand'} size="sm" /> : null}
      {total === 0 ? (
        <p className="text-[13px] text-muted">{canWrite ? 'Break the task into the steps it is done through.' : 'No checklist.'}</p>
      ) : (
        <ul className={cx('flex flex-col', compact ? 'gap-1' : 'gap-1.5')}>
          {collab.checklist.map((item) => (
            <ChecklistRow key={item.id} projectId={projectId} taskId={taskId} item={item} canWrite={canWrite} />
          ))}
        </ul>
      )}
      {canWrite ? (
        <form ref={addForm} action={addAction} className="flex flex-col gap-1">
          <TaskKeys projectId={projectId} taskId={taskId} />
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor={`checklist-add-${taskId}`}>
              New checklist item
            </label>
            <input id={`checklist-add-${taskId}`} name="label" required maxLength={300} className={inputClass} placeholder="Add a step…" />
            <button type="submit" disabled={addPending} className={buttonClass('secondary', 'sm')} aria-label="Add checklist item">
              <IconPlus size={14} />
              {addPending ? 'Adding…' : 'Add'}
            </button>
          </div>
          <FormMessage status={addState.status} message={addState.message} />
        </form>
      ) : null}
    </section>
  );
}

function ChecklistRow({ projectId, taskId, item, canWrite }: { projectId: string; taskId: string; item: TaskCollab['checklist'][number]; canWrite: boolean }) {
  const [toggleState, toggleAction, togglePending] = useActionState(setChecklistItemDoneAction, IDLE_STATE);
  const [removeState, removeAction, removePending] = useActionState(removeChecklistItemAction, IDLE_STATE);
  useRefreshOnSuccess(toggleState);
  useRefreshOnSuccess(removeState);
  const ticked = item.doneAt !== null;
  return (
    <li className="flex flex-col gap-0.5 rounded-md border border-line px-2.5 py-1.5 text-[13px]">
      <div className="flex items-center gap-2">
        <form action={toggleAction} className="flex items-center">
          <TaskKeys projectId={projectId} taskId={taskId} />
          <input type="hidden" name="itemId" value={item.id} />
          <input type="hidden" name="done" value={ticked ? 'false' : 'true'} />
          <button
            type="submit"
            role="checkbox"
            aria-checked={ticked}
            aria-label={`${ticked ? 'Untick' : 'Tick'} ${item.label}`}
            disabled={!canWrite || togglePending}
            className={cx(
              'flex h-4.5 w-4.5 items-center justify-center rounded border transition-colors disabled:cursor-not-allowed',
              ticked ? 'border-success bg-success text-white' : 'border-line-strong bg-surface hover:border-brand',
            )}
          >
            {ticked ? <IconCheck size={11} /> : null}
          </button>
        </form>
        <span className={cx('min-w-0 flex-1', ticked ? 'text-muted line-through' : '')}>{item.label}</span>
        {canWrite ? (
          <form action={removeAction}>
            <TaskKeys projectId={projectId} taskId={taskId} />
            <input type="hidden" name="itemId" value={item.id} />
            <button type="submit" disabled={removePending} aria-label={`Remove ${item.label}`} className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-surface-hover hover:text-danger">
              <IconClose size={12} />
            </button>
          </form>
        ) : null}
      </div>
      {ticked && item.doneByName ? (
        <span className="pl-6.5 text-[11px] text-muted">
          {item.doneByName}
          {item.doneLabel ? ` · ${item.doneLabel}` : ''}
        </span>
      ) : null}
      {toggleState.status === 'error' ? <FormMessage status={toggleState.status} message={toggleState.message} /> : null}
      {removeState.status === 'error' ? <FormMessage status={removeState.status} message={removeState.message} /> : null}
    </li>
  );
}

// ── Comments ───────────────────────────────────────────────────────────────

function CommentsSection({ projectId, taskId, collab, canWrite, compact }: { projectId: string; taskId: string; collab: TaskCollab; canWrite: boolean; compact: boolean }) {
  const [state, action, pending] = useActionState(addTaskCommentAction, IDLE_STATE);
  useRefreshOnSuccess(state);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status === 'success') form.current?.reset();
  }, [state]);

  // Cmd/Ctrl+Enter submits, as a chat box would; plain Enter keeps its newline.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <SectionHeading icon={<IconMessage size={13} />} title="Comments" meta={collab.comments.length > 0 ? <span className="tabular text-xs text-muted">{collab.comments.length}</span> : null} />
      {collab.comments.length === 0 ? (
        <p className="text-[13px] text-muted">{canWrite ? 'Nothing has been said about this task yet.' : 'No comments.'}</p>
      ) : (
        <ul className={cx('flex flex-col', compact ? 'gap-2' : 'gap-2.5')}>
          {collab.comments.map((c) => (
            <li key={c.id} className="flex items-start gap-2.5">
              <Avatar name={c.authorName} size="sm" />
              <div className="min-w-0 flex-1 rounded-lg border border-line bg-surface-sunken/60 px-3 py-2">
                <p className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                  <span className="font-medium text-foreground">{c.authorName}</span>
                  <span className="text-faint">{c.createdLabel}</span>
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <form ref={form} action={action} className="flex flex-col gap-1.5">
          <TaskKeys projectId={projectId} taskId={taskId} />
          <label className="sr-only" htmlFor={`comment-${taskId}`}>
            Add a comment
          </label>
          <textarea id={`comment-${taskId}`} name="body" required maxLength={4000} rows={compact ? 2 : 3} onKeyDown={onKeyDown} className={textareaClass} placeholder="Write a comment… (Ctrl+Enter to post)" />
          <div className="flex items-center gap-2">
            <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
              {pending ? 'Posting…' : 'Comment'}
            </button>
            <FormMessage status={state.status} message={state.message} />
          </div>
        </form>
      ) : null}
    </section>
  );
}

// ── Attachments ────────────────────────────────────────────────────────────

function AttachmentsSection({ projectId, taskId, collab, canWrite, compact }: { projectId: string; taskId: string; collab: TaskCollab; canWrite: boolean; compact: boolean }) {
  const [state, action, pending] = useActionState(addTaskAttachmentAction, IDLE_STATE);
  useRefreshOnSuccess(state);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status === 'success') form.current?.reset();
  }, [state]);

  return (
    <section className="flex flex-col gap-2">
      <SectionHeading icon={<IconAttach size={13} />} title="Attachments" meta={collab.attachments.length > 0 ? <span className="tabular text-xs text-muted">{collab.attachments.length}</span> : null} />
      {collab.attachments.length === 0 ? (
        <p className="text-[13px] text-muted">{canWrite ? 'Attach a link to where the file lives — Drive, Figma, a PR.' : 'No attachments.'}</p>
      ) : (
        <ul className={cx('flex flex-col', compact ? 'gap-1' : 'gap-1.5')}>
          {collab.attachments.map((a) => (
            <AttachmentRow key={a.id} projectId={projectId} taskId={taskId} attachment={a} canWrite={canWrite} />
          ))}
        </ul>
      )}
      {canWrite ? (
        <form ref={form} action={action} className="flex flex-col gap-1.5">
          <TaskKeys projectId={projectId} taskId={taskId} />
          <div className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1.4fr)_auto]">
            {/* SCR-020: typed evidence — screenshot, log, url, file. */}
            <div className="flex flex-col gap-1">
              <label className="sr-only" htmlFor={`attach-kind-${taskId}`}>
                Evidence kind
              </label>
              <select id={`attach-kind-${taskId}`} name="kind" defaultValue="url" className={inputClass}>
                {TASK_EVIDENCE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="sr-only" htmlFor={`attach-title-${taskId}`}>
                Title
              </label>
              <input id={`attach-title-${taskId}`} name="title" required maxLength={200} className={inputClass} placeholder="Title" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="sr-only" htmlFor={`attach-url-${taskId}`}>
                Link
              </label>
              <input id={`attach-url-${taskId}`} name="url" type="url" required maxLength={2000} className={inputClass} placeholder="https://…" />
            </div>
            <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
              <IconPlus size={14} />
              {pending ? 'Attaching…' : 'Attach'}
            </button>
          </div>
          <FormMessage status={state.status} message={state.message} />
        </form>
      ) : null}
    </section>
  );
}

function AttachmentRow({ projectId, taskId, attachment, canWrite }: { projectId: string; taskId: string; attachment: TaskCollab['attachments'][number]; canWrite: boolean }) {
  const [state, action, pending] = useActionState(removeTaskAttachmentAction, IDLE_STATE);
  useRefreshOnSuccess(state);
  const confirmRemove = (e: FormEvent<HTMLFormElement>) => {
    if (!window.confirm(`Remove "${attachment.title}" from this task?`)) e.preventDefault();
  };
  return (
    <li className="flex flex-col gap-0.5 rounded-md border border-line px-2.5 py-1.5 text-[13px]">
      <div className="flex items-center gap-2">
        <a href={attachment.url} target="_blank" rel="noreferrer noopener" className="flex min-w-0 flex-1 items-center gap-1 font-medium text-brand underline-offset-2 hover:underline">
          <span className="truncate">{attachment.title}</span>
          <IconArrowUpRight size={12} className="shrink-0" />
        </a>
        <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">{attachment.kind}</span>
        {canWrite ? (
          <form action={action} onSubmit={confirmRemove}>
            <TaskKeys projectId={projectId} taskId={taskId} />
            <input type="hidden" name="attachmentId" value={attachment.id} />
            <button type="submit" disabled={pending} aria-label={`Remove ${attachment.title}`} className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-surface-hover hover:text-danger">
              <IconClose size={12} />
            </button>
          </form>
        ) : null}
      </div>
      <span className="text-[11px] text-muted">
        {attachment.addedByName ?? 'Unknown'} · {attachment.createdLabel}
      </span>
      {state.status === 'error' ? <FormMessage status={state.status} message={state.message} /> : null}
    </li>
  );
}
