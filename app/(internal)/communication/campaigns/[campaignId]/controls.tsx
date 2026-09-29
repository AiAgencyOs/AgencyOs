'use client';

import { useActionState } from 'react';

import { approveCampaignAction, cancelCampaignAction } from '@/modules/crm/campaign-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, Field, FormMessage, textareaClass } from '@/ui';

/**
 * The two decisions a campaign takes from a person — SCR-059, owner
 * decision 2026-09-30. Both are rendered only when the page's own check
 * says this person may take them; the door and the database check again
 * and their refusal is shown as written.
 */
export function ApproveCampaignForm({ campaignId, recipientsNow }: { campaignId: string; recipientsNow: number }) {
  const [state, action, pending] = useActionState(approveCampaignAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="campaignId" value={campaignId} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending || recipientsNow === 0} className={buttonClass('primary', 'sm')}>
          {pending ? 'Approving…' : `Approve for ${recipientsNow} recipient${recipientsNow === 1 ? '' : 's'}`}
        </button>
        <span className="text-xs text-muted">
          The audience is expanded now, from the filter as saved. The next tick starts sending, 25 per tick, each through the consent, window and outreach rules.
        </span>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function CancelCampaignForm({ campaignId }: { campaignId: string }) {
  const [state, action, pending] = useActionState(cancelCampaignAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="campaignId" value={campaignId} />
      <Field label="Why it is withdrawn" htmlFor="cancel-reason" required hint="Recorded on the campaign and in the audit trail. What already went stays sent; what is pending is refused as cancelled.">
        <textarea id="cancel-reason" name="reason" required minLength={1} maxLength={600} rows={2} className={textareaClass} placeholder="Wrong audience — the filter matched every lead, not the qualified ones." />
      </Field>
      <div>
        <button type="submit" disabled={pending} className={buttonClass('danger', 'sm')}>
          {pending ? 'Cancelling…' : 'Cancel campaign'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
