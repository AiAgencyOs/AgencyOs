'use client';

import { useActionState, useId } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { attachFileAction } from '@/modules/projects/attached-files-actions';
import { AREA_EXTENSIONS } from '@/modules/projects/attachment-rules';
import type { AttachedSubjectKind } from '@/modules/projects/attached-files-schema';
import { FormMessage, buttonClass, inputClass, labelClass } from '@/ui';

/**
 * "Attach a file" on a build (apk, ipa, zip), a test run or a bug (a
 * screenshot, a log, a report) — Q-C1 and Q-C6. The file is stored in the
 * project-files bucket under the 50 MB limit and the credentials guard; an
 * unreachable store is said in words rather than pretending the file landed.
 */
export function AttachFileForm({ projectId, subjectKind, subjectId }: { projectId: string; subjectKind: AttachedSubjectKind; subjectId: string }) {
  const [state, action, pending] = useActionState(attachFileAction, IDLE_STATE);
  const fileId = useId();
  const extensions = AREA_EXTENSIONS[subjectKind === 'build' ? 'build' : 'evidence'];
  const noun = subjectKind === 'build' ? 'build file' : 'evidence file';
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="subjectKind" value={subjectKind} />
      <input type="hidden" name="subjectId" value={subjectId} />
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={fileId} className={labelClass}>
          Attach a {noun} (up to 50 MB)
        </label>
        <input id={fileId} name="file" type="file" required accept={extensions.map((e) => `.${e}`).join(',')} className={`${inputClass} h-auto max-w-full py-1.5`} />
      </div>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Uploading…' : 'Attach file'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
