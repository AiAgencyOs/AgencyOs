'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef } from 'react';

import { IDLE_STATE, type FormState } from '@/modules/identity/types';
import { addTimeLogAction, deleteTimeLogAction, updateTimeLogAction } from '@/modules/projects/time-log-actions';
import type { TaskTime } from '@/modules/projects/time-log-queries';
import { buttonClass, FormMessage, IconClock, inputClass, labelClass, textareaClass } from '@/ui';

/**
 * Time on a task — decision 4 of 2026-09-29. The "Log time" form, the
 * task's total, and its entries with edit-own / delete-own controls
 * (a project lead may delete any). One component for the My Tasks drawer
 * and the task page. Every write is a Server Action through
 * time-log-actions.ts and the page is refreshed after a success so the
 * rows are the server's; refusals are shown beside the control. Nothing
 * here is money: hours are hours.
 */

function useRefreshOnSuccess(state: FormState) {
  const router = useRouter();
  const handled = useRef<FormState | null>(null);
  useEffect(() => {
    if (state.status === 'success' && handled.current !== state) {
      handled.current = state;
      router.refresh();
    }
  }, [state, router]);
}

export function formatHours(h: number): string {
  return `${Number.isInteger(h) ? h : h.toFixed(2).replace(/0$/, '')} h`;
}

function LogTimeForm({ projectId, taskId, today }: { projectId: string; taskId: string; today: string }) {
  const [state, action, pending] = useActionState(addTimeLogAction, IDLE_STATE);
  useRefreshOnSuccess(state);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status === 'success') formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Hours</span>
          <input name="hours" type="number" min="0.25" max="24" step="0.25" required className={inputClass} placeholder="1.5" />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>On</span>
          <input name="loggedOn" type="date" required defaultValue={today} max={today} className={inputClass} />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Note (optional)</span>
        <textarea name="note" maxLength={1000} rows={2} className={textareaClass} placeholder="What the time went on" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          <IconClock size={14} />
          {pending ? 'Logging…' : 'Log time'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

function EditEntryForm({ projectId, taskId, entry, today }: { projectId: string; taskId: string; entry: TaskTime['entries'][number]; today: string }) {
  const [state, action, pending] = useActionState(updateTimeLogAction, IDLE_STATE);
  useRefreshOnSuccess(state);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="timeLogId" value={entry.id} />
      <div className="grid grid-cols-2 gap-2">
        <input name="hours" type="number" min="0.25" max="24" step="0.25" required defaultValue={entry.hours} className={inputClass} aria-label="Hours" />
        <input name="loggedOn" type="date" required defaultValue={entry.loggedOn} max={today} className={inputClass} aria-label="Date" />
      </div>
      <textarea name="note" maxLength={1000} rows={2} defaultValue={entry.note ?? ''} className={textareaClass} aria-label="Note" />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

function DeleteEntryButton({ projectId, taskId, timeLogId }: { projectId: string; taskId: string; timeLogId: string }) {
  const [state, action, pending] = useActionState(deleteTimeLogAction, IDLE_STATE);
  useRefreshOnSuccess(state);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="timeLogId" value={timeLogId} />
      <button type="submit" disabled={pending} className="text-xs text-danger hover:underline disabled:opacity-50">
        {pending ? 'Deleting…' : 'Delete'}
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

export function TimeLogPanel({
  projectId,
  taskId,
  time,
  currentUserId,
  canDeleteAny,
  canWrite,
  today,
  compact,
}: {
  projectId: string;
  taskId: string;
  time: TaskTime;
  currentUserId: string;
  /** Owner, ops admin, delivery lead: the roles holding project.write. */
  canDeleteAny: boolean;
  canWrite: boolean;
  /** The agency's today as YYYY-MM-DD, from the server clock. */
  today: string;
  compact?: boolean;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
          <IconClock size={14} />
          Time
        </h3>
        <span className="text-[13px] tabular">
          <span className="font-medium">{formatHours(time.totalHours)}</span>
          <span className="text-muted"> · {time.entries.length} entr{time.entries.length === 1 ? 'y' : 'ies'}</span>
        </span>
      </div>

      {canWrite ? <LogTimeForm projectId={projectId} taskId={taskId} today={today} /> : null}

      {time.entries.length === 0 ? (
        <p className="text-xs text-muted">No time logged on this task yet.</p>
      ) : (
        <ul className={compact ? 'flex max-h-56 flex-col gap-1 overflow-y-auto' : 'flex flex-col gap-1'}>
          {time.entries.map((e) => {
            const own = e.personId === currentUserId;
            return (
              <li key={e.id} className="flex flex-col gap-1 rounded-lg border border-line px-2.5 py-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium tabular">{formatHours(e.hours)}</span>
                    <span className="text-muted"> · {e.personName} · {e.loggedOn}</span>
                  </span>
                  {canWrite && (own || canDeleteAny) ? <DeleteEntryButton projectId={projectId} taskId={taskId} timeLogId={e.id} /> : null}
                </div>
                {e.note ? <p className="text-muted">{e.note}</p> : null}
                {canWrite && own ? (
                  <details>
                    <summary className="cursor-pointer text-muted hover:underline">Edit</summary>
                    <div className="pt-1">
                      <EditEntryForm projectId={projectId} taskId={taskId} entry={e} today={today} />
                    </div>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
