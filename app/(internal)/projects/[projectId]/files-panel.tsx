'use client';

import { useActionState } from 'react';
import { SECRETS_WARNING } from '@/modules/projects/file-secrets-guard';

import { addProjectFileAction, removeProjectFileAction, updateProjectFileAction } from '@/modules/projects/actions';
import { PROJECT_FILE_CATEGORIES } from '@/modules/projects/schema';
import type { ProjectFile } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, buttonClass, Card, FormMessage, humanize, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

/** SCR-024's add form and file rows — thin client wrappers over the server actions. */

export function AddProjectFileForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(addProjectFileAction, IDLE_STATE);

  return (
    <Card className="p-4">
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="projectId" value={projectId} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Title</span>
            <input name="title" required maxLength={200} className={inputClass} placeholder="Requirements v2.pdf" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Category</span>
            <select name="category" defaultValue="documents" className={selectClass}>
              {PROJECT_FILE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Link</span>
          <input
            name="url"
            type="url"
            required
            maxLength={2000}
            className={inputClass}
            placeholder="https://drive.google.com/…"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Description (optional)</span>
          <textarea name="description" maxLength={1000} className={textareaClass} rows={2} />
        </label>
        <p className="text-[11px] text-muted">{SECRETS_WARNING}</p>
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

/**
 * Rename / move — the link door's own update, since 20261001120000 with the
 * folder inside the category (SCR-024), and offered for STORED files too:
 * title, category and folder are row facts; the object never moves.
 */
export function EditFileForm({ file, projectId, folder = '' }: { file: Omit<ProjectFile, 'url'> & { url?: string }; projectId: string; folder?: string }) {
  const [state, action, pending] = useActionState(updateProjectFileAction, IDLE_STATE);
  const stored = !file.url;

  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="fileId" value={file.id} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Title</span>
          <input name="title" required maxLength={200} defaultValue={file.title} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Category</span>
          <select name="category" defaultValue={file.category} className={selectClass}>
            {PROJECT_FILE_CATEGORIES.map((c) => (
              <option key={c} value={c}>{humanize(c)}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Folder (inside the category)</span>
        <input name="folder" maxLength={200} defaultValue={folder} className={inputClass} placeholder="mockups/mobile — empty for the category root" />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Description</span>
        <textarea name="description" maxLength={1000} defaultValue={file.description ?? ''} className={textareaClass} rows={2} />
      </label>
      <p className="text-xs text-muted">{stored ? 'Moving a file changes where it is filed, not the stored object — every version stays where it is.' : 'The link itself is not editable — a different place is a different file. Remove and link again.'}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

export function FileRow({ file, projectId, editable }: { file: ProjectFile; projectId: string; editable: boolean }) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <a
              href={file.url}
              target="_blank"
              rel="noreferrer noopener"
              className="block truncate text-sm font-medium text-foreground underline-offset-2 hover:underline"
            >
              {file.title}
            </a>
            <Badge mono>{humanize(file.category)}</Badge>
          </span>
          <span className="block truncate text-xs text-muted">
            {file.uploadedByName ? `${file.uploadedByName} · ` : ''}
            {file.description ?? 'No description'}
          </span>
        </div>
        {editable ? (
          <RemoveFileButton projectId={projectId} fileId={file.id} />
        ) : null}
      </div>
      {editable ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted hover:underline">Rename or refile</summary>
          <div className="pt-2">
            <EditFileForm file={file} projectId={projectId} />
          </div>
        </details>
      ) : null}
    </li>
  );
}
