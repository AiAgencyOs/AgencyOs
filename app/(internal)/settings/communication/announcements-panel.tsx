'use client';

import { useActionState, useEffect, useRef } from 'react';

import { createAnnouncementAction, setAnnouncementStatusAction } from '@/modules/crm/announcements-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, buttonClass, cx, FormMessage, inputClass, selectClass, StatusBadge, textareaClass } from '@/ui';

/** One announcement as the page formatted it (dates already through the agency clock). */
export type AnnouncementView = {
  id: string;
  title: string;
  body: string;
  audience: string;
  status: string;
  when: string;
};

/**
 * Settings › Communication › Announcements — draft, publish, archive
 * (`crm.announcements`). Publishing RECORDS the announcement so the
 * Communication Center and every Client 360 can show it; nothing here
 * sends. WhatsApp broadcast is declined on record (traceability row 59)
 * and the page says so beside the button.
 */
export function AnnouncementsPanel({ announcements, canWrite }: { announcements: AnnouncementView[]; canWrite: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      {canWrite ? <DraftForm /> : <p className="text-xs text-muted">Only the owner can write announcements.</p>}
      {announcements.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-muted">No announcement yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {announcements.map((a) => (
            <li key={a.id} className="flex flex-col gap-1.5 px-4 py-3 text-[13px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{a.title}</span>
                  <Badge tone={a.audience === 'clients' ? 'info' : 'neutral'}>{a.audience === 'clients' ? 'For clients' : 'Internal'}</Badge>
                  <StatusBadge status={a.status} />
                </span>
                <span className="text-xs text-muted">{a.when}</span>
              </div>
              <p className="whitespace-pre-wrap text-muted">{a.body}</p>
              {canWrite && a.status !== 'archived' ? <StatusButtons id={a.id} status={a.status} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DraftForm() {
  const [state, action, pending] = useActionState(createAnnouncementAction, IDLE_STATE);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status === 'success') ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <input name="title" required maxLength={160} placeholder="Title" aria-label="Announcement title" className={cx(inputClass, 'h-9 flex-1 text-[13px]')} />
        <select name="audience" defaultValue="internal" aria-label="Audience" className={cx(selectClass, 'h-9 w-40 text-[13px]')}>
          <option value="internal">Internal</option>
          <option value="clients">Clients</option>
        </select>
      </div>
      <textarea name="body" required maxLength={5000} rows={3} placeholder="What is being announced" aria-label="Announcement body" className={cx(textareaClass, 'text-[13px]')} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Save draft'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}

function StatusButtons({ id, status }: { id: string; status: string }) {
  const [state, action, pending] = useActionState(setAnnouncementStatusAction, IDLE_STATE);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === 'draft' ? (
        <form action={action}>
          <input type="hidden" name="announcementId" value={id} />
          <input type="hidden" name="status" value="published" />
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Publishing…' : 'Publish (record only)'}
          </button>
        </form>
      ) : null}
      <form action={action}>
        <input type="hidden" name="announcementId" value={id} />
        <input type="hidden" name="status" value="archived" />
        <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
          {pending ? 'Archiving…' : 'Archive'}
        </button>
      </form>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </div>
  );
}
