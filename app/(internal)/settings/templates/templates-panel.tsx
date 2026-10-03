'use client';

import { useActionState, useId, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { cloneProjectTemplateAction, deleteProjectTemplateAction } from '@/modules/projects/project-template-actions';
import { cloneName } from '@/modules/projects/project-template-schema';
import { buttonClass, FormMessage, inputClass, labelClass } from '@/ui';

/** Settings › Templates — the delete control, one form per row. Decision: reversed by the owner on 2026-09-29. */
export function DeleteTemplateButton({ templateId }: { templateId: string }) {
  const [state, action, pending] = useActionState(deleteProjectTemplateAction, IDLE_STATE);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="templateId" value={templateId} />
      <button type="submit" disabled={pending} className="text-xs text-danger hover:underline disabled:opacity-50">
        {pending ? 'Deleting…' : 'Delete'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

/** SCR-027 "Clone template": a copy under a new name, through projects.clone_project_template. */
export function CloneTemplateButton({ templateId, templateName }: { templateId: string; templateName: string }) {
  const [state, action, pending] = useActionState(cloneProjectTemplateAction, IDLE_STATE);
  const [open, setOpen] = useState(false);
  const nameId = useId();
  if (!open || state.status === 'success') {
    return (
      <span className="inline-flex items-center gap-2">
        <button type="button" onClick={() => setOpen(true)} aria-label={`Clone ${templateName}`} className="text-xs text-brand hover:underline">
          Clone
        </button>
        {state.status === 'success' ? <FormMessage status={state.status} message={state.message} /> : null}
      </span>
    );
  }
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="templateId" value={templateId} />
      <label htmlFor={nameId} className="flex flex-col gap-1">
        <span className={labelClass}>Name of the copy</span>
        <input id={nameId} name="name" required maxLength={200} defaultValue={cloneName(templateName)} className={inputClass} />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Cloning…' : 'Clone'}
      </button>
      <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
        Cancel
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
