'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { approveCampaign, cancelCampaign, createCampaign, previewCampaignAudience } from './campaign-service';
import type { CampaignAudienceInput, CampaignPreviewState } from './campaign-types';

/**
 * The campaign forms' server actions — SCR-059, owner decision 2026-09-30.
 * Thin: the doors in `campaign-service.ts` check the capability, the
 * template, the four-eyes rule and the reason, and every refusal is shown
 * as written.
 */

function audienceFrom(formData: FormData): CampaignAudienceInput {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  return {
    status: text('status'),
    source: text('source'),
    owner: text('owner'),
    service: text('service'),
    tag: text('tag'),
    lastActivityDays: text('lastActivityDays'),
    createdFrom: text('createdFrom'),
    createdTo: text('createdTo'),
    projectId: text('projectId'),
  };
}

/** The live "N recipients" figure beside the audience form. Re-checks the session and the capability every time. */
export async function previewCampaignAudienceAction(input: CampaignAudienceInput): Promise<CampaignPreviewState> {
  const result = await previewCampaignAudience(input);
  if (!result.ok) return { status: 'error', message: result.error.message };
  return { status: 'ok', ...result.data };
}

export async function createCampaignAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();

  const result = await createCampaign({
    name: text('name'),
    templateId: text('templateId'),
    audience: audienceFrom(formData),
    scheduledFor: text('scheduledFor'),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/communication/campaigns');
  return { status: 'success', message: 'Draft saved. A second owner or ops admin has to approve it before anything is sent.' };
}

export async function approveCampaignAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const campaignId = String(formData.get('campaignId') ?? '').trim();

  const result = await approveCampaign({ campaignId });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/communication/campaigns');
  revalidatePath(`/communication/campaigns/${campaignId}`);
  return {
    status: 'success',
    message: `Approved for ${result.data.recipients} recipient${result.data.recipients === 1 ? '' : 's'}. The next tick starts sending, 25 at a time, each through the consent, window and outreach rules.`,
  };
}

export async function cancelCampaignAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const campaignId = String(formData.get('campaignId') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();

  const result = await cancelCampaign({ campaignId, reason });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/communication/campaigns');
  revalidatePath(`/communication/campaigns/${campaignId}`);
  return {
    status: 'success',
    message:
      result.data.withdrawn > 0
        ? `Cancelled. ${result.data.withdrawn} pending recipient${result.data.withdrawn === 1 ? '' : 's'} will not be written to.`
        : 'Cancelled.',
  };
}
