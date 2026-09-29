'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { createCalendarFeedAction, revokeCalendarFeedAction } from '@/modules/projects/calendar-feed-actions';
import type { MyCalendarFeed } from '@/modules/projects/calendar-feed-queries';
import { buttonClass, FormMessage, inputClass } from '@/ui';

/**
 * SCR-022 "Sync supported calendars" — the ICS feed. Google, Apple and
 * Outlook subscribe to the URL; the token is yours alone, and revoking
 * it stops every calendar that used it. No OAuth is claimed: this is the
 * honest sync the schema can offer.
 */
export function CalendarFeedPanel({ projectId, feed, appUrl, fetchedLabel }: { projectId: string; feed: MyCalendarFeed | null; appUrl: string; fetchedLabel: string | null }) {
  const [createState, createAction, creating] = useActionState(createCalendarFeedAction, IDLE_STATE);
  const [revokeState, revokeAction, revoking] = useActionState(revokeCalendarFeedAction, IDLE_STATE);
  const [copied, setCopied] = useState(false);
  const url = feed ? `${appUrl}/api/projects/${projectId}/calendar.ics?token=${feed.token}` : null;

  return (
    <div className="flex flex-col gap-2 px-4 pb-4 text-[13px] sm:px-5">
      {url && feed ? (
        <>
          <p className="text-muted">Subscribe to this URL in Google Calendar, Apple Calendar or Outlook. It carries this project’s dated tasks, milestones and meetings and updates when they change.</p>
          <div className="flex flex-wrap items-center gap-2">
            <input readOnly value={url} className={`${inputClass} min-w-0 flex-1 font-mono text-xs`} onFocus={(e) => e.currentTarget.select()} aria-label="Calendar feed URL" />
            <button
              type="button"
              className={buttonClass('secondary', 'sm')}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="text-xs text-muted">
            Fetched {feed.fetchCount} time{feed.fetchCount === 1 ? '' : 's'}{fetchedLabel ? ` · last ${fetchedLabel}` : ''}. The token is yours alone.
          </p>
          <form action={revokeAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="feedId" value={feed.id} />
            <button type="submit" disabled={revoking} className={buttonClass('ghost', 'sm')}>
              {revoking ? 'Revoking…' : 'Revoke this feed'}
            </button>
            <FormMessage status={revokeState.status} message={revokeState.message} />
          </form>
        </>
      ) : (
        <form action={createAction} className="flex flex-col gap-2">
          <input type="hidden" name="projectId" value={projectId} />
          <p className="text-muted">Get a private feed URL and subscribe to it from your calendar app. It updates as tasks, milestones and meetings change.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={creating} className={buttonClass('secondary', 'sm')}>
              {creating ? 'Creating…' : 'Create my feed URL'}
            </button>
            <FormMessage status={createState.status} message={createState.message} />
          </div>
        </form>
      )}
    </div>
  );
}
