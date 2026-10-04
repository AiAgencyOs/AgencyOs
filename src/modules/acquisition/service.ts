import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { ACQUISITION_CHANNELS, PAUSE_REASON_MAX, type AcquisitionChannel, type IcpDefinition } from './schema';

/**
 * Lead generation's write surface. Thin on purpose: every rule (admin only, the closed channel list, the ICP
 * vocabulary, the version history, the audit row) lives in the crm.* doors; this layer keeps a reader off a
 * form they cannot submit and turns an outcome into a sentence.
 */

const first = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

async function manager(): Promise<Result<true>> {
  const context = await requireInternal();
  if (!can(context, 'acquisition.manage')) return err('FORBIDDEN', 'You do not have permission to manage lead generation.');
  return ok(true);
}

const FORBIDDEN = 'Only the owner or an ops admin may change lead generation.';

export async function seedAcquisitionDefaults(): Promise<Result<{ seeded: boolean }>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('ensure_acquisition_defaults');
  if (error) return err('INTERNAL', 'Could not set up lead generation.');
  // The approval engine refuses a subject type that has no policy, so the engines' approvals need one before they can be asked.
  const { error: policyError } = await supabase.schema('crm').rpc('ensure_acquisition_approval_policies');
  if (policyError) return err('INTERNAL', 'Could not set up the approval policies.');
  const outcome = first<{ outcome?: string }>(data)?.outcome;
  if (outcome === 'seeded' || outcome === 'ready') return ok({ seeded: outcome === 'seeded' });
  return err('FORBIDDEN', FORBIDDEN);
}

export async function saveTargetService(input: { id: string | null; name: string; description: string; priority: number; active: boolean }): Promise<Result<{ id: string }>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('set_target_service', {
    p_id: input.id as never,
    p_name: input.name,
    p_description: input.description as never,
    p_priority: input.priority,
    p_active: input.active,
  });
  if (error) return err('INTERNAL', 'Could not save the service.');
  const row = first<{ outcome?: string; service_id?: string }>(data);
  switch (row?.outcome) {
    case 'saved':
      return ok({ id: row.service_id ?? '' });
    case 'duplicate':
      return err('CONFLICT', 'A target service with that name already exists.');
    case 'invalid':
      return err('VALIDATION', 'Give the service a name of 2-80 characters and a priority from 1 to 1000.');
    case 'not_found':
      return err('NOT_FOUND', 'That service no longer exists.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export async function saveChannelSettings(input: {
  channel: string;
  enabled: boolean;
  monthlyQualifiedTarget: number | null;
  monthlyBudgetMinor: number | null;
  dailyLimit: number | null;
}): Promise<Result<true>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  if (!(ACQUISITION_CHANNELS as readonly string[]).includes(input.channel)) return err('VALIDATION', 'That is not one of the five channels.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('set_channel_settings', {
    p_channel: input.channel,
    p_enabled: input.enabled,
    p_monthly_qualified_target: input.monthlyQualifiedTarget as never,
    p_monthly_budget_minor: input.monthlyBudgetMinor as never,
    p_daily_limit: input.dailyLimit as never,
  });
  if (error) return err('INTERNAL', 'Could not save the channel settings.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'saved':
      return ok(true);
    case 'invalid':
      return err('VALIDATION', 'Targets, budgets and limits must be whole numbers of zero or more.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export async function setChannelPause(input: { channel: AcquisitionChannel; paused: boolean; reason: string }): Promise<Result<true>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const reason = input.reason.trim();
  if (input.paused && !reason) return err('VALIDATION', 'Say why - the reason is what the audit row and the banner carry.');
  if (reason.length > PAUSE_REASON_MAX) return err('VALIDATION', `Keep the reason under ${PAUSE_REASON_MAX} characters.`);
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('set_channel_pause', { p_channel: input.channel, p_paused: input.paused, p_reason: reason as never });
  if (error) return err('INTERNAL', 'Could not change the channel pause.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'set':
    case 'unchanged':
      return ok(true);
    case 'no_reason':
      return err('VALIDATION', 'Say why - a pause needs a reason.');
    case 'invalid':
      return err('VALIDATION', 'That is not one of the five channels.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export async function saveIcp(input: { definition: IcpDefinition; note: string }): Promise<Result<{ version: number }>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('save_icp', { p_definition: input.definition as never, p_note: input.note as never });
  if (error) return err('INTERNAL', 'Could not save the ideal customer profile.');
  const row = first<{ outcome?: string; version?: number }>(data);
  switch (row?.outcome) {
    case 'saved':
      return ok({ version: row.version ?? 0 });
    case 'invalid':
      return err('VALIDATION', 'The profile is not valid: the minimum score must be 0-100.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export async function decideDuplicateReview(input: { reviewId: string; decision: 'confirmed_same' | 'kept_separate' | 'dismissed'; note: string }): Promise<Result<true>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('decide_duplicate_review', { p_review: input.reviewId, p_decision: input.decision, p_note: input.note as never });
  if (error) return err('INTERNAL', 'Could not record the decision.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'decided':
      return ok(true);
    case 'needs_note':
      return err('VALIDATION', 'Say why - the reason is kept with the decision.');
    case 'already_decided':
      return err('CONFLICT', 'Someone has already decided this one.');
    case 'not_found':
      return err('NOT_FOUND', 'That review no longer exists.');
    case 'invalid':
      return err('VALIDATION', 'Choose one of the three decisions.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export async function saveHandoffSettings(input: { businessNumber: string; linkTtlDays: number }): Promise<Result<true>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('set_handoff_settings', { p_business_number: input.businessNumber, p_link_ttl_days: input.linkTtlDays });
  if (error) return err('INTERNAL', 'Could not save the handoff settings.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'saved':
      return ok(true);
    case 'invalid':
      return err('VALIDATION', 'Use the number with its country code, like +91 98765 43210, and a lifetime of 1 to 90 days.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export async function cancelHandoff(input: { handoffId: string; reason: string }): Promise<Result<true>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('cancel_channel_handoff', { p_handoff_id: input.handoffId, p_reason: input.reason });
  if (error) return err('INTERNAL', 'Could not cancel the handoff.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'cancelled':
      return ok(true);
    case 'needs_reason':
      return err('VALIDATION', 'Say why - the reason is kept.');
    case 'not_live':
      return err('CONFLICT', 'That handoff is no longer live.');
    case 'not_found':
      return err('NOT_FOUND', 'That handoff no longer exists.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export async function cancelSubtask(input: { subtaskId: string; reason: string }): Promise<Result<true>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const context = await requireInternal();
  if (!context.organizationId) return err('FORBIDDEN', 'Your account is not attached to an organisation.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('cancel_subtask', { p_organization_id: context.organizationId, p_subtask: input.subtaskId, p_reason: input.reason });
  if (error) return err('INTERNAL', 'Could not cancel the request.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'cancelled':
      return ok(true);
    case 'needs_reason':
      return err('VALIDATION', 'Say why - the reason is kept.');
    case 'not_live':
      return err('CONFLICT', 'That request has already ended.');
    case 'not_found':
      return err('NOT_FOUND', 'That request no longer exists.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export async function saveQualificationModel(input: { weights: Record<string, number>; note: string }): Promise<Result<{ version: number }>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('save_qualification_model', { p_weights: input.weights as never, p_note: input.note as never });
  if (error) return err('INTERNAL', 'Could not save the weights.');
  const row = first<{ outcome?: string; version?: number }>(data);
  switch (row?.outcome) {
    case 'saved':
      return ok({ version: row.version ?? 0 });
    case 'invalid':
      return err('VALIDATION', 'Weights are numbers from 0 to 100, and at least one must be above zero.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export async function blockProspect(input: { kind: string; value: string; reason: string }): Promise<Result<true>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('block_prospect', { p_kind: input.kind, p_value: input.value, p_reason: input.reason });
  if (error) return err('INTERNAL', 'Could not add the block.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'blocked':
      return ok(true);
    case 'already_blocked':
      return err('CONFLICT', 'That is already blocked.');
    case 'invalid':
      return err('VALIDATION', 'Give a real email address, domain or company, and a reason of a few words.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export async function liftProspectBlock(input: { blockId: string; reason: string }): Promise<Result<true>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('lift_prospect_block', { p_block: input.blockId, p_reason: input.reason });
  if (error) return err('INTERNAL', 'Could not lift the block.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'lifted':
      return ok(true);
    case 'needs_reason':
      return err('VALIDATION', 'Say why - the reason is kept.');
    case 'already_lifted':
      return err('CONFLICT', 'That block was already lifted.');
    case 'not_owner':
      return err('FORBIDDEN', 'Only the owner can lift a block - it removes a safety rule.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

async function managerWithOrg(): Promise<Result<{ organizationId: string }>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const context = await requireInternal();
  if (!context.organizationId) return err('FORBIDDEN', 'Your account is not attached to an organisation.');
  return ok({ organizationId: context.organizationId });
}

export async function createContentDraft(input: {
  platform: string; objective: string; format: string; title: string; service: string; body: string; cta: string; hashtags: string[];
}): Promise<Result<{ versionId: string }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const org = gate.data.organizationId;
  const { data: made, error } = await supabase.schema('crm').rpc('create_content_item', {
    p_organization_id: org, p_platform: input.platform, p_objective: input.objective, p_format: input.format, p_strategy: undefined as never,
    p_service: (input.service || null) as never, p_title: input.title, p_by_type: 'human',
  });
  if (error) return err('INTERNAL', 'Could not start the draft.');
  const item = first<{ outcome?: string; item_id?: string }>(made);
  if (item?.outcome !== 'created' || !item.item_id) return err('VALIDATION', 'Check the platform, objective, format and a title of a few words.');
  const { data, error: vError } = await supabase.schema('crm').rpc('add_content_version', {
    p_organization_id: org, p_item: item.item_id, p_body: input.body, p_cta: (input.cta || null) as never, p_hashtags: input.hashtags,
    p_asset_ids: [], p_reference_ids: [], p_by_type: 'human',
  });
  if (vError) return err('INTERNAL', 'Could not save the draft.');
  const v = first<{ outcome?: string; version_id?: string }>(data);
  if (v?.outcome !== 'created' || !v.version_id) return err('VALIDATION', 'The text is empty or too long for that platform (LinkedIn 3,000, Instagram 2,200 characters).');
  return ok({ versionId: v.version_id });
}

export async function reviewContentVersion(versionId: string): Promise<Result<{ passed: boolean; blocking: string[] }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('review_content_version', { p_organization_id: gate.data.organizationId, p_version: versionId });
  if (error) return err('INTERNAL', 'Could not run the review.');
  const r = first<{ outcome?: string; passed?: boolean; blocking?: unknown }>(data);
  if (r?.outcome === 'wrong_state') return err('CONFLICT', 'That version has already been reviewed.');
  if (r?.outcome !== 'reviewed') return err('NOT_FOUND', 'That version no longer exists.');
  return ok({ passed: r.passed === true, blocking: Array.isArray(r.blocking) ? (r.blocking as string[]) : [] });
}

export async function submitContentForApproval(versionId: string): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('submit_for_admin_review', { p_organization_id: gate.data.organizationId, p_version: versionId });
  if (error) return err('INTERNAL', 'Could not submit it.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'submitted':
    case 'already_pending':
      return ok(true);
    case 'not_reviewed':
      return err('CONFLICT', 'Only a version that passed the automated review can go to an admin.');
    case 'no_policy':
      return err('CONFLICT', 'Set up lead generation first - it creates the approval rule for social content.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export async function scheduleContentVersion(input: { versionId: string; when: string }): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const when = new Date(input.when);
  if (Number.isNaN(when.getTime())) return err('VALIDATION', 'Choose a date and time.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('schedule_content', { p_organization_id: gate.data.organizationId, p_version: input.versionId, p_when: when.toISOString() });
  if (error) return err('INTERNAL', 'Could not schedule it.');
  const r = first<{ outcome?: string; reason?: string }>(data);
  switch (r?.outcome) {
    case 'scheduled':
      return ok(true);
    case 'not_approved':
      return err('CONFLICT', r.reason === 'expired' ? 'The approval has expired. Submit it again.' : 'It has not been approved yet - an admin must approve exactly this version first.');
    case 'wrong_state':
      return err('CONFLICT', 'It is not waiting for approval any more.');
    case 'invalid_time':
      return err('VALIDATION', 'Choose a time that is not in the past.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export async function cancelContentVersion(input: { versionId: string; reason: string }): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('cancel_content_version', { p_organization_id: gate.data.organizationId, p_version: input.versionId, p_reason: input.reason });
  if (error) return err('INTERNAL', 'Could not cancel it.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'cancelled':
      return ok(true);
    case 'needs_reason':
      return err('VALIDATION', 'Say why - the reason is kept.');
    case 'publishing_in_progress':
      return err('CONFLICT', 'It is being posted right now.');
    case 'not_live':
      return err('CONFLICT', 'It has already ended.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export async function activateSocialStrategy(strategyId: string): Promise<Result<true>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('activate_social_strategy', { p_strategy: strategyId });
  if (error) return err('INTERNAL', 'Could not activate it.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'activated':
      return ok(true);
    case 'not_a_draft':
      return err('CONFLICT', 'Only a draft strategy can be activated.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export type AdPlanInput = {
  platform: string; campaignId: string | null; name: string; service: string; plan: Record<string, unknown>;
  dailyMinor: number; totalMinor: number | null; startDate: string | null; endDate: string | null;
};

/** Save a plan as the NEXT version of a campaign, creating the campaign first when it is new. Nothing is sent to a platform. */
export async function saveAdPlan(input: AdPlanInput): Promise<Result<{ versionId: string }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const org = gate.data.organizationId;
  let campaignId = input.campaignId;
  if (!campaignId) {
    const { data, error } = await supabase.schema('crm').rpc('create_ad_campaign', { p_organization_id: org, p_platform: input.platform, p_name: input.name, p_target_service: (input.service || undefined) as never });
    if (error) return err('INTERNAL', 'Could not start the campaign.');
    const made = first<{ outcome?: string; campaign_id?: string }>(data);
    if (made?.outcome !== 'created' || !made.campaign_id) return err(made?.outcome === 'forbidden' ? 'FORBIDDEN' : 'VALIDATION', made?.outcome === 'forbidden' ? FORBIDDEN : 'Check the platform and give the campaign a name of a few words.');
    campaignId = made.campaign_id;
  }
  const { data, error } = await supabase.schema('crm').rpc('add_ad_version', {
    p_organization_id: org, p_campaign: campaignId, p_plan: input.plan as never, p_daily_minor: input.dailyMinor,
    p_total_minor: (input.totalMinor ?? undefined) as never, p_start: (input.startDate ?? undefined) as never, p_end: (input.endDate ?? undefined) as never,
  });
  if (error) return err('INTERNAL', 'Could not save the plan.');
  const v = first<{ outcome?: string; version_id?: string }>(data);
  switch (v?.outcome) {
    case 'added':
      return ok({ versionId: v.version_id as string });
    case 'apply_in_progress':
      return err('CONFLICT', 'A change is being applied to the platform right now. Wait until it is confirmed or reconciled.');
    case 'campaign_ended':
      return err('CONFLICT', 'That campaign has ended. Start a new one.');
    case 'forbidden':
      return err('FORBIDDEN', FORBIDDEN);
    default:
      return err('VALIDATION', 'Check the budget (it must be above zero, the total not below the daily amount) and the dates.');
  }
}

export async function checkAdVersion(versionId: string): Promise<Result<{ passed: boolean; problems: string[] }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('check_ad_version', { p_organization_id: gate.data.organizationId, p_version: versionId });
  if (error) return err('INTERNAL', 'Could not run the checks.');
  const r = first<{ outcome?: string; problems?: unknown }>(data);
  if (r?.outcome === 'wrong_state') return err('CONFLICT', 'That version has already been checked.');
  if (r?.outcome !== 'checked' && r?.outcome !== 'check_failed') return err(r?.outcome === 'forbidden' ? 'FORBIDDEN' : 'NOT_FOUND', r?.outcome === 'forbidden' ? FORBIDDEN : 'That version no longer exists.');
  return ok({ passed: r.outcome === 'checked', problems: Array.isArray(r.problems) ? (r.problems as string[]) : [] });
}

export async function submitAdVersion(versionId: string): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('submit_ad_version', { p_organization_id: gate.data.organizationId, p_version: versionId });
  if (error) return err('INTERNAL', 'Could not submit it.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'submitted':
    case 'already_pending':
      return ok(true);
    case 'not_checked':
      return err('CONFLICT', 'Only a version that passed the checks can go to an admin.');
    case 'content_changed':
      return err('CONFLICT', 'This version changed after it was first submitted. Make a new version.');
    case 'forbidden':
      return err('FORBIDDEN', FORBIDDEN);
    default:
      return err('CONFLICT', 'Set up lead generation first - it creates the approval rule for ad campaigns.');
  }
}

export async function requestAdChange(input: { campaignId: string; action: 'pause' | 'resume' | 'end'; reason: string }): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('request_ad_change', { p_organization_id: gate.data.organizationId, p_campaign: input.campaignId, p_action: input.action, p_reason: input.reason });
  if (error) return err('INTERNAL', 'Could not record the request.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'requested':
      return ok(true);
    case 'invalid':
      return err('VALIDATION', 'Say why - the reason is kept.');
    case 'blocked':
      return err('CONFLICT', 'The channel is stopped, so it cannot be resumed. Lift the stop first.');
    case 'not_running':
    case 'not_paused':
    case 'not_live':
      return err('CONFLICT', 'The campaign is not in a state where that applies.');
    case 'not_found':
      return err('NOT_FOUND', 'That campaign no longer exists.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export type LandingInput = { pageId: string | null; name: string; slug: string; service: string; content: Record<string, unknown>; publicUrl: string };

/** Save content as the NEXT version of a landing page, creating the page first when it is new. Nothing is sent to a host. */
export async function saveLandingVersion(input: LandingInput): Promise<Result<{ versionId: string }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const org = gate.data.organizationId;
  let pageId = input.pageId;
  if (!pageId) {
    const { data, error } = await supabase.schema('crm').rpc('create_landing_page', { p_organization_id: org, p_name: input.name, p_slug: input.slug, p_target_service: (input.service || undefined) as never });
    if (error) return err('INTERNAL', 'Could not start the page.');
    const made = first<{ outcome?: string; page_id?: string }>(data);
    if (made?.outcome === 'slug_taken') return err('CONFLICT', 'That address name is already used by another page.');
    if (made?.outcome === 'forbidden') return err('FORBIDDEN', FORBIDDEN);
    if (made?.outcome !== 'created' || !made.page_id) return err('VALIDATION', 'Give the page a name of a few words and an address name of lowercase words joined by hyphens.');
    pageId = made.page_id;
  }
  const { data, error } = await supabase.schema('crm').rpc('add_landing_version', { p_organization_id: org, p_page: pageId, p_content: input.content as never, p_public_url: input.publicUrl });
  if (error) return err('INTERNAL', 'Could not save the page.');
  const v = first<{ outcome?: string; version_id?: string }>(data);
  switch (v?.outcome) {
    case 'added':
      return ok({ versionId: v.version_id as string });
    case 'no_whatsapp_number':
      return err('CONFLICT', 'Set the WhatsApp business number first (Settings): a page is approved with the number it links to.');
    case 'deploy_in_progress':
      return err('CONFLICT', 'A deploy is in progress. Wait until it is confirmed or reconciled.');
    case 'page_retired':
      return err('CONFLICT', 'That page was retired. Start a new one.');
    case 'forbidden':
      return err('FORBIDDEN', FORBIDDEN);
    default:
      return err('VALIDATION', 'The public address must be https, e.g. https://lp.youragency.com/website.');
  }
}

export async function checkLandingVersion(versionId: string): Promise<Result<{ passed: boolean; problems: string[] }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('check_landing_version', { p_organization_id: gate.data.organizationId, p_version: versionId });
  if (error) return err('INTERNAL', 'Could not run the checks.');
  const r = first<{ outcome?: string; problems?: unknown }>(data);
  if (r?.outcome === 'wrong_state') return err('CONFLICT', 'That version has already been checked.');
  if (r?.outcome !== 'checked' && r?.outcome !== 'check_failed') return err(r?.outcome === 'forbidden' ? 'FORBIDDEN' : 'NOT_FOUND', r?.outcome === 'forbidden' ? FORBIDDEN : 'That version no longer exists.');
  return ok({ passed: r.outcome === 'checked', problems: Array.isArray(r.problems) ? (r.problems as string[]) : [] });
}

export async function submitLandingVersion(versionId: string): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('submit_landing_version', { p_organization_id: gate.data.organizationId, p_version: versionId });
  if (error) return err('INTERNAL', 'Could not submit it.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'submitted':
    case 'already_pending':
      return ok(true);
    case 'not_checked':
      return err('CONFLICT', 'Only a version that passed the checks can go to an admin.');
    case 'forbidden':
      return err('FORBIDDEN', FORBIDDEN);
    default:
      return err('CONFLICT', 'Set up lead generation first - it creates the approval rule for this.');
  }
}

export async function retireLandingPage(input: { pageId: string; reason: string }): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('retire_landing_page', { p_organization_id: gate.data.organizationId, p_page: input.pageId, p_reason: input.reason });
  if (error) return err('INTERNAL', 'Could not retire it.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'retired':
      return ok(true);
    case 'needs_reason':
      return err('VALIDATION', 'Say why - the reason is kept.');
    case 'already_retired':
      return err('CONFLICT', 'It is already retired.');
    case 'not_found':
      return err('NOT_FOUND', 'That page no longer exists.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}
