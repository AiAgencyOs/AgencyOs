'use client';

import { useActionState } from 'react';

import { setDefaultAssigneeAction, unwatchProjectAction, watchProjectAction } from '@/modules/projects/project-defaults-actions';
import { WATCH_PHASES, WATCH_PHASE_LABEL, type WatchPhase } from '@/modules/projects/project-defaults-schema';
import type { ProjectWatcher } from '@/modules/projects/project-defaults-queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, FormMessage, buttonClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-027's two settings — the default assignee a new task goes to, and who
 * watches the project's phase changes. Both write through their own doors;
 * the database decides again (`projects_write`, `project_watchers_write`).
 */

type Member = { userId: string; fullName: string };

export function DefaultAssigneeForm({ projectId, current, roster }: { projectId: string; current: string | null; roster: readonly Member[] }) {
  const [state, action, pending] = useActionState(setDefaultAssigneeAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-56 flex-col gap-1">
          <label htmlFor="default-assignee" className={labelClass}>Default assignee</label>
          <select id="default-assignee" name="defaultAssigneeId" defaultValue={current ?? ''} className={selectClass}>
            <option value="">Nobody — tasks start unassigned</option>
            {roster.map((m) => (
              <option key={m.userId} value={m.userId}>{m.fullName}</option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="text-xs text-muted">
        A task created on this project with nobody named goes to this person. Tasks that already exist are not moved.
      </p>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function RemoveWatcherButton({ projectId, userId }: { projectId: string; userId: string }) {
  const [state, action, pending] = useActionState(unwatchProjectAction, IDLE_STATE);
  return (
    <form action={action} className="inline-flex items-center gap-1">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="userId" value={userId} />
      <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
        {pending ? 'Removing…' : 'Remove'}
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

export function WatchersPanel({
  projectId,
  watchers,
  roster,
  mayManageOthers,
  selfId,
}: {
  projectId: string;
  watchers: readonly ProjectWatcher[];
  roster: readonly Member[];
  /** owner / ops_admin — may add or remove anyone; everyone else only themself. */
  mayManageOthers: boolean;
  selfId: string;
}) {
  const [state, action, pending] = useActionState(watchProjectAction, IDLE_STATE);
  const candidates = mayManageOthers ? roster : roster.filter((m) => m.userId === selfId);

  return (
    <div className="flex flex-col gap-3">
      {watchers.length === 0 ? (
        <p className="text-[13px] text-muted">Nobody is watching this project yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {watchers.map((w) => (
            <li key={w.userId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{w.fullName}</span>
                {w.userId === selfId ? <Badge tone="brand">you</Badge> : null}
                {w.phases.length === 0 ? (
                  <span className="text-xs text-muted">hears about nothing</span>
                ) : (
                  w.phases.map((p) => <Badge key={p} tone="neutral">{WATCH_PHASE_LABEL[p]}</Badge>)
                )}
              </span>
              {mayManageOthers || w.userId === selfId ? <RemoveWatcherButton projectId={projectId} userId={w.userId} /> : null}
            </li>
          ))}
        </ul>
      )}

      <form action={action} className="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="phasesForm" value="1" />
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-56 flex-col gap-1">
            <label htmlFor="watcher-user" className={labelClass}>Watcher</label>
            <select id="watcher-user" name="userId" defaultValue={selfId} className={selectClass}>
              {candidates.map((m) => (
                <option key={m.userId} value={m.userId}>{m.fullName}{m.userId === selfId ? ' (you)' : ''}</option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
            {pending ? 'Saving…' : 'Add or update'}
          </button>
        </div>
        <fieldset className="flex flex-wrap gap-3 text-[13px]">
          <legend className={labelClass}>Hear about</legend>
          {WATCH_PHASES.map((p: WatchPhase) => (
            <label key={p} className="inline-flex items-center gap-1.5">
              <input type="checkbox" name="phases" value={p} defaultChecked />
              {WATCH_PHASE_LABEL[p]}
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-muted">
          A change on a watched phase appears in the watcher&apos;s Action Center.
          {mayManageOthers ? '' : ' Only the owner or an ops admin may add somebody else.'}
        </p>
        <FormMessage status={state.status} message={state.message} />
      </form>
    </div>
  );
}
