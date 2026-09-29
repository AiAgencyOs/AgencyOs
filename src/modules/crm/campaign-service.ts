import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { readAudienceCandidates } from './campaign-queries';
import {
  approveCampaignSchema,
  campaignAudienceSchema,
  cancelCampaignSchema,
  createCampaignSchema,
  expandAudience,
  type CancelCampaignInput,
  type CreateCampaignInput,
} from './campaign-schema';
import type { CampaignAudienceInput } from './campaign-types';

/**
 * The campaign doors — SCR-059, owner decision 2026-09-30 (broadcast
 * reopened as a governed campaign).
 *
 * A campaign is a plan, not a send. These doors write the plan
 * (`create_campaign`), have a SECOND person approve it and expand the
 * audience at that moment (`approve_campaign`, four-eyes in the database),
 * and withdraw it with a reason (`cancel_campaign`). Nothing here reaches
 * the provider: the cron tick's `runCampaigns` sends, one governed message
 * per recipient, through the same chokepoint the composer uses.
 *
 * Capability first (`lead.write` — owner and ops_admin), then the RPC, whose
 * RLS and its own checks decide again. Every refusal is returned as written.
 */

async function readAudience(): Promise<Result<Awaited<ReturnType<typeof readAudienceCandidates>>>> {
  try {
    return ok(await readAudienceCandidates());
  } catch (e) {
    return err('INTERNAL', e instanceof Error ? e.message : 'The leads could not be read.');
  }
}

export async function previewCampaignAudience(
  input: CampaignAudienceInput,
): Promise<Result<{ count: number; withThread: number; withoutThread: number }>> {
  const parsed = campaignAudienceSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'That audience filter could not be read.');

  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to plan campaigns.');

  const candidates = await readAudience();
  if (!candidates.ok) return candidates;

  const recipients = expandAudience(candidates.data, parsed.data, new Date());
  const withThread = recipients.filter((r) => r.conversationId !== null).length;
  return ok({ count: recipients.length, withThread, withoutThread: recipients.length - withThread });
}

export async function createCampaign(input: CreateCampaignInput): Promise<Result<{ campaignId: string }>> {
  const parsed = createCampaignSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'That campaign could not be validated.');

  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to plan campaigns.');

  // SCR-059 (bucket F): a scheduled campaign waits for its hour; the worker's
  // claim honours it in the database.
  let scheduledFor: string | null = null;
  if (parsed.data.scheduledFor) {
    const at = new Date(parsed.data.scheduledFor);
    if (Number.isNaN(at.getTime())) return err('VALIDATION', 'That schedule is not a date and time.');
    if (at.getTime() <= Date.now()) return err('VALIDATION', 'A scheduled send is in the future.');
    scheduledFor = at.toISOString();
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('create_campaign', {
    p_name: parsed.data.name,
    p_template_id: parsed.data.templateId,
    p_audience: parsed.data.audience,
    p_scheduled_for: scheduledFor,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'createCampaign', detail: error.message }));
    return err('INTERNAL', 'The campaign could not be saved.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome: string; campaign_id: string | null } | undefined;
  switch (row?.outcome) {
    case 'created':
      return row.campaign_id ? ok({ campaignId: row.campaign_id }) : err('INTERNAL', 'The campaign could not be saved.');
    case 'forbidden':
      return err('FORBIDDEN', 'Only an owner or ops admin may plan a campaign.');
    case 'template_not_found':
      return err('NOT_FOUND', 'That template is not registered here.');
    case 'template_not_approved':
      return err('CONFLICT', 'That template is not approved and active at Meta. Only a template Meta approved can carry a campaign.');
    case 'in_the_past':
      return err('VALIDATION', 'A scheduled send is in the future.');
    case 'no_actor':
      return err('UNAUTHORIZED', 'No signed-in person on this session.');
    default:
      return err('INTERNAL', 'The campaign could not be saved.');
  }
}

/**
 * Four eyes. The approver must not be the creator and must be owner or
 * ops_admin — decided in the database, not here. The audience is expanded
 * NOW, from the same rows and the same pure function the preview used, and
 * handed to the RPC as the list of recipients it writes.
 */
export async function approveCampaign(input: { campaignId: string }): Promise<Result<{ recipients: number }>> {
  const parsed = approveCampaignSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'That campaign could not be identified.');

  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to approve campaigns.');

  const supabase = await createClient();
  const { data: campaign, error: readError } = await supabase
    .schema('crm')
    .from('campaigns')
    .select('id, status, audience, created_by')
    .eq('id', parsed.data.campaignId)
    .maybeSingle();
  if (readError) {
    console.error(JSON.stringify({ level: 'error', scope: 'approveCampaign.read', detail: readError.message }));
    return err('INTERNAL', 'The campaign could not be read.');
  }
  if (!campaign) return err('NOT_FOUND', 'That campaign does not exist here.');
  if (campaign.status !== 'draft') return err('CONFLICT', `This campaign is ${campaign.status}, not a draft; only a draft is approved.`);
  if (campaign.created_by === context.userId) {
    return err('FORBIDDEN', 'You planned this campaign, so a second owner or ops admin has to approve it.');
  }

  const audience = campaignAudienceSchema.safeParse(campaign.audience ?? {});
  if (!audience.success) return err('CONFLICT', 'The saved audience filter could not be read. Cancel this campaign and plan it again.');

  const candidates = await readAudience();
  if (!candidates.ok) return candidates;
  const recipients = expandAudience(candidates.data, audience.data, new Date());
  if (recipients.length === 0) return err('VALIDATION', 'The audience filter matches nobody right now. Nothing to approve.');

  const { data, error } = await supabase.schema('crm').rpc('approve_campaign', {
    p_campaign_id: parsed.data.campaignId,
    p_recipients: recipients.map((r) => ({ lead_id: r.leadId, conversation_id: r.conversationId })),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'approveCampaign', detail: error.message }));
    return err('INTERNAL', 'The approval could not be recorded.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome: string; recipients: number } | undefined;
  switch (row?.outcome) {
    case 'approved':
      return ok({ recipients: row.recipients });
    case 'forbidden':
      return err('FORBIDDEN', 'Only an owner or ops admin may approve a campaign.');
    case 'same_person':
      return err('FORBIDDEN', 'You planned this campaign, so a second owner or ops admin has to approve it.');
    case 'not_draft':
      return err('CONFLICT', 'This campaign is no longer a draft.');
    case 'not_found':
      return err('NOT_FOUND', 'That campaign does not exist here.');
    case 'template_not_approved':
      return err('CONFLICT', 'The template is no longer approved and active at Meta. Register an approved one and plan again.');
    case 'no_recipients':
      return err('VALIDATION', 'The audience filter matches nobody right now. Nothing to approve.');
    case 'no_actor':
      return err('UNAUTHORIZED', 'No signed-in person on this session.');
    default:
      return err('INTERNAL', 'The approval could not be recorded.');
  }
}

export async function cancelCampaign(input: CancelCampaignInput): Promise<Result<{ withdrawn: number }>> {
  const parsed = cancelCampaignSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'That cancellation could not be validated.');

  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to withdraw campaigns.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('cancel_campaign', {
    p_campaign_id: parsed.data.campaignId,
    p_reason: parsed.data.reason,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'cancelCampaign', detail: error.message }));
    return err('INTERNAL', 'The cancellation could not be recorded.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome: string; withdrawn: number } | undefined;
  switch (row?.outcome) {
    case 'cancelled':
      return ok({ withdrawn: row.withdrawn });
    case 'forbidden':
      return err('FORBIDDEN', 'Only the person who planned this campaign, or the owner, may withdraw it.');
    case 'finished':
      return err('CONFLICT', 'This campaign has already finished or been cancelled.');
    case 'no_reason':
      return err('VALIDATION', 'Say why the campaign is withdrawn.');
    case 'not_found':
      return err('NOT_FOUND', 'That campaign does not exist here.');
    case 'no_actor':
      return err('UNAUTHORIZED', 'No signed-in person on this session.');
    default:
      return err('INTERNAL', 'The cancellation could not be recorded.');
  }
}
