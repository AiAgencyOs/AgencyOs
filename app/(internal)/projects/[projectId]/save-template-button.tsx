'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { createProjectTemplateFromProjectAction } from '@/modules/projects/project-template-actions';
import { buttonClass, Drawer, FormMessage, IconPortfolio, inputClass, labelClass, textareaClass } from '@/ui';

/**
 * "Save as template" on the Project 360 header. Decision: reversed by the
 * owner on 2026-09-29. Opens a small drawer for the template's name and
 * note, then calls the door; the door's own count of what was snapshotted
 * is the success message, and any refusal is shown verbatim.
 */
export function SaveTemplateButton({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(createProjectTemplateFromProjectAction, IDLE_STATE);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('secondary', 'sm')}>
        <IconPortfolio size={14} />
        Save as template
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Save as template" description="A snapshot of this project's modules, features, milestone percentages, scope items, onboarding checklist and task titles. New projects can start from it.">
        <form action={action} className="flex flex-col gap-3">
          <input type="hidden" name="projectId" value={projectId} />
          <div className="flex flex-col gap-1.5">
            <label className={labelClass} htmlFor={`template-name-${projectId}`}>
              Template name
            </label>
            <input id={`template-name-${projectId}`} name="name" required maxLength={200} defaultValue={`${projectName} template`} className={inputClass} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelClass} htmlFor={`template-description-${projectId}`}>
              Note (optional)
            </label>
            <textarea id={`template-description-${projectId}`} name="description" maxLength={1000} rows={3} className={textareaClass} placeholder="When to use this template" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
              {pending ? 'Saving…' : 'Save template'}
            </button>
            <FormMessage status={state.status} message={state.message} />
          </div>
          <p className="text-xs text-muted">Templates are listed under Settings › Templates, where an owner can delete one.</p>
        </form>
      </Drawer>
    </>
  );
}
