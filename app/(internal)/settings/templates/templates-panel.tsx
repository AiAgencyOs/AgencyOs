'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { deleteProjectTemplateAction } from '@/modules/projects/project-template-actions';
import { FormMessage } from '@/ui';

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
