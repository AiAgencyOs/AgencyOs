'use client';

import { useActionState } from 'react';

import { addProjectFileAction, removeProjectFileAction } from '@/modules/projects/actions';
import { PROJECT_FILE_CATEGORIES } from '@/modules/projects/schema';
import type { ProjectFile } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, Card, FormMessage, humanize, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

/** SCR-024's add form and file rows — thin client wrappers over the server actions. */

export function AddProjectFileForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(addProjectFileAction, IDLE_STATE);

  return (
    <Card className="p-4">
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="projectId" value={projectId} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Title</label>
            <input name="title" required maxLength={200} className={inputClass} placeholder="Requirements v2.pdf" />
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Category</label>
            <select name="category" defaultValue="documents" className={selectClass}>
              {PROJECT_FILE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Link</label>
          <input
            name="url"
            type="url"
            required
            maxLength={2000}
            className={inputClass}
            placeholder="https://drive.google.com/…"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Description (optional)</label>
          <textarea name="description" maxLength={1000} className={textareaClass} rows={2} />
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Adding…' : 'Add file'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </div>
      </form>
    </Card>
  );
}

export function RemoveFileButton({ projectId, fileId }: { projectId: string; fileId: string }) {
  const [state, action, pending] = useActionState(removeProjectFileAction, IDLE_STATE);

  return (
    <form action={action}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="fileId" value={fileId} />
      <button type="submit" disabled={pending} className="text-xs text-danger hover:underline disabled:opacity-50">
        {pending ? 'Removing…' : 'Remove'}
      </button>
      {state.status === 'error' ? <span className="ml-2 text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

export function FileRow({ file, projectId, editable }: { file: ProjectFile; projectId: string; editable: boolean }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1">
        <a
          href={file.url}
          target="_blank"
          rel="noreferrer noopener"
          className="block truncate text-sm font-medium text-foreground underline-offset-2 hover:underline"
        >
          {file.title}
        </a>
        <span className="block truncate text-xs text-muted">
          {file.uploadedByName ? `${file.uploadedByName} · ` : ''}
          {file.description ?? 'No description'}
        </span>
      </div>
      {editable ? <RemoveFileButton projectId={projectId} fileId={file.id} /> : null}
    </li>
  );
}
