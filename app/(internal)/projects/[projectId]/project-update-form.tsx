'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { sendProjectUpdateAction } from '@/modules/projects/project-updates-actions';
import type { ProjectUpdate } from '@/modules/projects/project-updates-queries';
import { Badge, buttonClass, FormMessage, labelClass, selectClass, textareaClass } from '@/ui';

/**
 * SCR-019 — "Send project update". A client update goes through the
 * project's WhatsApp group and the outbound chokepoint; every refusal
 * (no group, no consent, outside the window, WhatsApp not configured) is
 * the chokepoint's own sentence, shown here. An internal update is a note
 * for the team and sends nothing — the option says so.
 */
export function ProjectUpdatePanel({
  projectId,
  updates,
  labels,
  mayMessageClient,
  mayPostInternal,
  hasClientThread,
}: {
  projectId: string;
  updates: ProjectUpdate[];
  /** Pre-formatted dates keyed by update id (the agency clock is server-side). */
  labels: Record<string, string>;
  mayMessageClient: boolean;
  mayPostInternal: boolean;
  hasClientThread: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(sendProjectUpdateAction, IDLE_STATE);
  const mayWrite = mayMessageClient || mayPostInternal;

  return (
    <div className="flex flex-col gap-2">
      {updates.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No update sent yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {updates.map((u) => (
            <li key={u.id} className="flex flex-col gap-1 px-4 py-2.5 text-[13px] sm:px-5">
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <Badge tone={u.sentTo === 'client' ? 'brand' : 'neutral'}>{u.sentTo === 'client' ? 'to the client' : 'internal'}</Badge>
                {u.sentByName ? <span>{u.sentByName}</span> : null}
                <span>{labels[u.id] ?? ''}</span>
              </span>
              <p className="whitespace-pre-wrap">{u.body}</p>
            </li>
          ))}
        </ul>
      )}
      {mayWrite ? (
        <div className="border-t border-line px-4 py-3 sm:px-5">
          {!open ? (
            <button type="button" onClick={() => setOpen(true)} className={buttonClass('secondary', 'sm')}>
              Send project update
            </button>
          ) : (
            <form action={action} className="flex flex-col gap-2">
              <input type="hidden" name="projectId" value={projectId} />
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Send to</span>
                <select name="sentTo" defaultValue={mayMessageClient && hasClientThread ? 'client' : 'internal'} className={selectClass}>
                  {mayMessageClient ? (
                    <option value="client" disabled={!hasClientThread}>
                      {hasClientThread ? 'The client — through the project’s WhatsApp group' : 'The client — no WhatsApp group is linked to this project yet'}
                    </option>
                  ) : null}
                  {mayPostInternal ? <option value="internal">The team — recorded on the project, nothing is sent</option> : null}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>Update</span>
                <textarea name="body" required maxLength={4000} rows={3} className={textareaClass} placeholder="What moved this week, what is next, what we need from you." />
              </label>
              <p className="text-xs text-muted">A client update goes through the same door every client message does: consent and the 24-hour window decide, and a refusal is shown here as it is.</p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
                  {pending ? 'Sending…' : 'Send'}
                </button>
                <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
                  Cancel
                </button>
                <FormMessage status={state.status} message={state.message} />
              </div>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
