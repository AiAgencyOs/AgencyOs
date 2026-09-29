'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { setProjectTemplateAction } from '@/modules/projects/project-template-select-actions';
import type { ProjectTemplateSummary } from '@/modules/projects/project-template-queries';
import { buttonClass, FormMessage, labelClass, selectClass } from '@/ui';

/**
 * SCR-027 — "Template selection" on project settings: which saved
 * template this project follows. Informational — nothing is re-applied,
 * and the panel says so; the template's detail is drawn by the page from
 * `getProjectTemplate`.
 */
export function TemplateSelectForm({ projectId, current, templates }: { projectId: string; current: string | null; templates: ProjectTemplateSummary[] }) {
  const [state, action, pending] = useActionState(setProjectTemplateAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" key={current ?? 'none'}>
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Template</span>
        <select name="templateId" defaultValue={current ?? ''} className={selectClass}>
          <option value="">None</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {!t.valid ? ' (unreadable)' : ''}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
