'use client';

import { useActionState, useId } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { setOrgProjectDefaultsAction } from '@/modules/projects/org-project-defaults-actions';
import { WATCH_PHASES, WATCH_PHASE_LABEL, type WatchPhase } from '@/modules/projects/project-defaults-schema';
import { buttonClass, FormMessage, labelClass, textareaClass } from '@/ui';

/** Settings › Project defaults — the two editable defaults, one form, one door. */
export function ProjectDefaultsForm({ watchPhases, folderText, mayEdit }: { watchPhases: readonly WatchPhase[]; folderText: string; mayEdit: boolean }) {
  const [state, action, pending] = useActionState(setOrgProjectDefaultsAction, IDLE_STATE);
  const foldersId = useId();
  return (
    <form action={action} className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2" disabled={!mayEdit}>
        <legend className={labelClass}>Phase changes a new watcher follows</legend>
        <p className="text-[13px] text-muted">Who watches a project is chosen per project; this is only what they are offered first.</p>
        {WATCH_PHASES.map((p) => (
          <label key={p} className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" name="watchPhase" value={p} defaultChecked={watchPhases.includes(p)} />
            {WATCH_PHASE_LABEL[p]}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={foldersId} className={labelClass}>
          Standard folders for new projects
        </label>
        <textarea id={foldersId} name="folderText" rows={6} maxLength={8000} defaultValue={folderText} disabled={!mayEdit} className={textareaClass} placeholder={'documents/Contracts\nqa/Test reports\nmeetings/Minutes'} />
        <p className="text-[11px] text-muted">One folder per line, written category/path. Categories: requirements, design, development, qa, deployment, marketing, documents, meetings, assets, builds, other. Copied onto every project created after you save; existing projects are not changed.</p>
      </div>
      {mayEdit ? (
        <div className="flex items-center gap-3">
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Saving…' : 'Save defaults'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </div>
      ) : null}
    </form>
  );
}
