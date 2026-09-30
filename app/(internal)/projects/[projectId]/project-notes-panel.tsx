'use client';

import { useActionState, useId, useState } from 'react';

import { IDLE_STATE, type FormState } from '@/modules/identity/types';
import { addProjectNoteAction, removeProjectNoteAction } from '@/modules/projects/task-plan-actions';
import { buttonClass, FormMessage, IconFile, inputClass, labelClass, textareaClass } from '@/ui';

export type NoteRow = { id: string; title: string; body: string | null; whenLabel: string; byName: string | null };

/** The overview's Project Notes card: the list, "Add note" and remove, through the project-notes doors. */
export function ProjectNotesPanel({ projectId, notes, editable }: { projectId: string; notes: NoteRow[]; editable: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(async (prev: FormState, formData: FormData) => {
    const result = await addProjectNoteAction(prev, formData);
    if (result.status === 'success') setOpen(false);
    return result;
  }, IDLE_STATE);
  const titleId = useId();
  const bodyId = useId();

  return (
    <div className="flex flex-col">
      {editable ? (
        <div className="px-4 pb-2 sm:px-5">
          {open ? (
            <form
              action={action}
              className="flex flex-col gap-2 rounded-lg border border-line p-3"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <div className="flex flex-col gap-1">
                <label htmlFor={titleId} className={labelClass}>Title</label>
                <input id={titleId} name="title" required maxLength={160} className={inputClass} placeholder="Client meeting discussion" />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={bodyId} className={labelClass}>Note</label>
                <textarea id={bodyId} name="body" rows={3} maxLength={4000} className={textareaClass} placeholder="What was said or decided" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>{pending ? 'Adding…' : 'Add note'}</button>
                <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>Close</button>
                <FormMessage status={state.status} message={state.message} />
              </div>
            </form>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setOpen(true)} className={buttonClass('secondary', 'sm')}>+ Add note</button>
              <FormMessage status={state.status} message={state.message} />
            </span>
          )}
        </div>
      ) : null}
      {notes.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No notes yet{editable ? ' — record what a meeting decided, or how the build is set up.' : '.'}</p>
      ) : (
        <ul className="divide-y divide-line">
          {notes.map((n) => (
            <li key={n.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-warning-soft text-warning" aria-hidden>
                <IconFile size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-foreground">{n.title}</span>
                {n.body ? <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{n.body}</span> : null}
                <span className="mt-0.5 block text-[11px] text-faint">{n.whenLabel}{n.byName ? ` · ${n.byName}` : ''}</span>
              </span>
              {editable ? <RemoveNoteButton projectId={projectId} noteId={n.id} title={n.title} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RemoveNoteButton({ projectId, noteId, title }: { projectId: string; noteId: string; title: string }) {
  const [state, action, pending] = useActionState(removeProjectNoteAction, IDLE_STATE);
  return (
    <form
      action={action}
      className="inline-flex items-center gap-1"
      onSubmit={(e) => {
        if (!window.confirm(`Remove the note “${title}”?`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="noteId" value={noteId} />
      <button type="submit" disabled={pending} className="text-xs text-faint hover:text-danger" aria-label={`Remove note ${title}`}>
        Remove
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}
