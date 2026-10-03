'use client';

import { useActionState } from 'react';

import { draftMilestoneAnnouncementAction } from '@/modules/crm/announcement-templates-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage } from '@/ui';

/**
 * SCR-059 — "project milestone announcements". A met, client-visible
 * milestone drafts its announcement from the active milestone template when
 * it is met; this is the owner's button for one that was met before a
 * template existed. It prepares a DRAFT — publishing is a separate act, and
 * nothing is sent (`crm.draft_milestone_announcement`).
 */
export function DraftMilestoneAnnouncementForm({ milestoneId }: { milestoneId: string }) {
  const [state, action, pending] = useActionState(draftMilestoneAnnouncementAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="milestoneId" value={milestoneId} />
      <button type="submit" disabled={pending} className={`${buttonClass('secondary', 'md')} justify-center`}>
        {pending ? 'Drafting…' : 'Draft its announcement'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
