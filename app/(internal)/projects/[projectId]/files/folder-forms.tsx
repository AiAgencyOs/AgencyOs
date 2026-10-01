'use client';

import { useActionState, useId, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { createProjectFolderAction, fileIntoFolderAction } from '@/modules/projects/project-folder-actions';
import { buttonClass, FormMessage, humanize, inputClass, labelClass, selectClass } from '@/ui';

/** "New Folder" — the create_project_folder door: a category and a name ("a/b" is a folder b inside a). */
export function NewFolderForm({ projectId, categories, defaultCategory, parent }: { projectId: string; categories: readonly string[]; defaultCategory: string; parent: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(async (prev: Parameters<typeof createProjectFolderAction>[0], fd: FormData) => {
    const result = await createProjectFolderAction(prev, fd);
    if (result.status === 'success') setOpen(false);
    return result;
  }, IDLE_STATE);
  const categoryId = useId();
  const nameId = useId();
  if (!open) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOpen(true)} className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-4 text-[13px] font-semibold text-foreground shadow-xs hover:bg-surface-hover">
          New Folder
        </button>
        <FormMessage status={state.status} message={state.message} />
      </span>
    );
  }
  return (
    <form action={action} className="flex w-full flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-3 shadow-xs">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-col gap-1">
        <label htmlFor={categoryId} className={labelClass}>Category</label>
        <select id={categoryId} name="category" defaultValue={defaultCategory} className={selectClass}>
          {categories.map((c) => (
            <option key={c} value={c}>{humanize(c)}</option>
          ))}
        </select>
      </div>
      <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
        <label htmlFor={nameId} className={labelClass}>Folder name</label>
        <input id={nameId} name="path" required maxLength={200} defaultValue={parent ? `${parent}/` : ''} placeholder="mockups/mobile" className={inputClass} autoFocus />
      </div>
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>{pending ? 'Creating…' : 'Create folder'}</button>
      <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>Cancel</button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

/** File a file into one of the folders of its own category (or back to the category root). */
export function FileIntoFolderForm({ projectId, fileId, title, current, folders }: { projectId: string; fileId: string; title: string; current: string; folders: string[] }) {
  const [state, action, pending] = useActionState(fileIntoFolderAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} key={current} className="flex flex-col gap-1">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="fileId" value={fileId} />
      <label htmlFor={id} className={labelClass}>Folder for {title}</label>
      <div className="flex flex-wrap items-center gap-2">
        <select id={id} name="path" defaultValue={current} className={`${selectClass} min-w-0 flex-1`}>
          <option value="">Category root</option>
          {folders.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Filing…' : 'File here'}</button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
