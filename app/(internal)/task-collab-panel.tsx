'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, type FormEvent } from 'react';

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
import type { TaskCollab } from '@/modules/projects/task-collab-types';
import {
  Avatar,
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
  textareaClass,
} from '@/ui';

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
      <p className="text-[11px] text-muted">A task is not moved to Blocked without saying why; the reason is shown on the card and recorded on the audit trail.</p>
    </div>
  );
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
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
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
