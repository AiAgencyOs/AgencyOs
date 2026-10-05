import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createAdminClient } from '@/lib/db/admin';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { addProspectFact, qualifyProspect, validateOutreachDraft, type FactSource } from './email-engine';
import { createHandoff, HANDOFF_SOURCE_CHANNELS } from './handoff';
import { renderApprovedPage, verifyLandingVersion } from './landing';
import { QUALIFICATION_FACTORS, type QualificationFactor } from './qualification-vocabulary';
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

/** A person asks one of the four acquisition agents for a piece of work. This queues it; the agent drafts, and a person approves. */
export async function requestAgentTask(input: { agent: string; task: string }): Promise<Result<{ queued: true }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('request_agent_task', { p_organization_id: gate.data.organizationId, p_agent: input.agent, p_task: input.task });
  if (error) return err('INTERNAL', 'Could not queue the task.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'queued':
      return ok({ queued: true });
    case 'already_queued':
      return err('CONFLICT', 'That exact task was already asked today. Change it, or wait for the first to finish.');
    case 'agent_disabled':
      return err('CONFLICT', 'This agent is switched off. The owner turns it on under AI Workforce > Agents; until then it does no work.');
    case 'stopped':
      return err('CONFLICT', 'The channel is paused or all lead generation is stopped, so the agent is not given work.');
    case 'invalid':
      return err('VALIDATION', 'Describe the task in a sentence or two (5 to 3,000 characters).');
    case 'unknown_agent':
      return err('VALIDATION', 'That is not one of the lead-generation agents.');
    default:
      return err('FORBIDDEN', FORBIDDEN);
  }
}

export async function mergeContacts(input: { winner: string; loser: string; reason: string }): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('merge_contacts', { p_organization_id: gate.data.organizationId, p_winner: input.winner, p_loser: input.loser, p_reason: input.reason });
  if (error) return err('INTERNAL', 'Could not merge the contacts.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'merged':
      return ok(true);
    case 'needs_reason':
      return err('VALIDATION', 'Say why - the reason is kept with the merge.');
    case 'same_contact':
      return err('VALIDATION', 'Choose two different contacts.');
    case 'no_confirmed_review':
      return err('CONFLICT', 'These two have not been confirmed as the same person.');
    case 'already_merged':
      return err('CONFLICT', 'One of these contacts has already been merged.');
    case 'not_found':
      return err('NOT_FOUND', 'One of those contacts no longer exists.');
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

// ── B2B (20261022100000) ───────────────────────────────────────────────────

const B2B_FAILURES: Record<string, { code: 'VALIDATION' | 'CONFLICT' | 'NOT_FOUND' | 'FORBIDDEN'; message: string }> = {
  forbidden: { code: 'FORBIDDEN', message: FORBIDDEN },
  not_owner: { code: 'FORBIDDEN', message: 'Only the owner may loosen a marketplace rule: allowing contact off a platform, or automation.' },
  invalid: { code: 'VALIDATION', message: 'Check the values: lengths, amounts and the platform.' },
  unknown_platform: { code: 'VALIDATION', message: 'Set up B2B first - it creates a rule for each marketplace.' },
  not_found: { code: 'NOT_FOUND', message: 'That no longer exists.' },
  duplicate: { code: 'CONFLICT', message: 'That job is already recorded for this marketplace.' },
  excluded: { code: 'CONFLICT', message: 'It mentions a term you excluded, so it cannot be shortlisted.' },
  already_past_that: { code: 'CONFLICT', message: 'It has already been sent or decided.' },
  needs_reason: { code: 'VALIDATION', message: 'Say why - the reason is kept.' },
  not_shortlisted: { code: 'CONFLICT', message: 'Shortlist the job before writing a proposal, and a job that was already sent takes no further proposal.' },
  already_submitted: { code: 'CONFLICT', message: 'A proposal for this job has already been recorded as sent.' },
  not_submitted: { code: 'CONFLICT', message: 'Only a job you sent a proposal for can be won or lost, and only once.' },
  not_checked: { code: 'CONFLICT', message: 'Only a version that passed the checks can go to an admin.' },
  wrong_state: { code: 'CONFLICT', message: 'That has already moved on.' },
  unknown_lead: { code: 'NOT_FOUND', message: 'That lead does not exist.' },
  already_linked: { code: 'CONFLICT', message: 'A lead is already linked.' },
  needs_reference: { code: 'VALIDATION', message: 'Enter the platform\'s own reference for the proposal.' },
  needs_evidence: { code: 'VALIDATION', message: 'Enter the https link to the profile on the platform as evidence.' },
  already_applied: { code: 'CONFLICT', message: 'That was already recorded as applied.' },
  already_published: { code: 'CONFLICT', message: 'That was already recorded as posted.' },
  already_deployed: { code: 'CONFLICT', message: 'That page was already recorded as uploaded.' },
  not_scheduled: { code: 'CONFLICT', message: 'Only an approved post that has been scheduled can be recorded as posted.' },
  not_approved_state: { code: 'CONFLICT', message: 'It is not waiting to be applied: it may not have been submitted for approval, or it has already been applied.' },
  not_deployed: { code: 'CONFLICT', message: 'The page has not been recorded as uploaded yet.' },
};
const b2bFail = (outcome: string | undefined, reason?: string | null): Result<never> => {
  if (outcome === 'blocked' || outcome === 'not_covered') {
    const why = reason ? ` (${reason.replaceAll('_', ' ')})` : '';
    return err('CONFLICT', outcome === 'blocked' ? `It is blocked right now${why}.` : `It has not been approved as exactly this version${why}.`);
  }
  const f = B2B_FAILURES[outcome ?? ''];
  return f ? err(f.code, f.message) : err('INTERNAL', 'That did not work. Nothing was changed.');
};

export async function readyB2b(): Promise<Result<true>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('ensure_b2b_defaults');
  if (error) return err('INTERNAL', 'Could not set up B2B.');
  return first<{ outcome?: string }>(data)?.outcome === 'ready' ? ok(true) : b2bFail(first<{ outcome?: string }>(data)?.outcome);
}

export async function saveB2bRule(input: { platform: string; offplatform: string; mode: string; note: string }): Promise<Result<true>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('set_b2b_platform_rule', { p_platform: input.platform, p_offplatform: input.offplatform, p_mode: input.mode, p_note: input.note });
  if (error) return err('INTERNAL', 'Could not save the rule.');
  const o = first<{ outcome?: string }>(data)?.outcome;
  return o === 'saved' ? ok(true) : b2bFail(o);
}

export async function saveB2bSettings(input: { minBudgetMinor: number | null; excludedTerms: string[]; scoreThreshold: number; monthlyConnectsCap: number | null }): Promise<Result<true>> {
  const gate = await manager();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('set_b2b_settings', {
    p_min_budget_minor: input.minBudgetMinor as never, p_excluded_terms: input.excludedTerms, p_score_threshold: input.scoreThreshold, p_monthly_connects_cap: input.monthlyConnectsCap as never,
  });
  if (error) return err('INTERNAL', 'Could not save the thresholds.');
  const o = first<{ outcome?: string }>(data)?.outcome;
  return o === 'saved' ? ok(true) : b2bFail(o);
}

export type OpportunityInput = { platform: string; externalRef: string; url: string; title: string; description: string; budgetMinMinor: number | null; budgetMaxMinor: number | null; currency: string; country: string };

/** A person pastes in a job they found. The fit is judged by the database, from the Admin's own thresholds. */
export async function importB2bOpportunity(input: OpportunityInput): Promise<Result<{ opportunityId: string; status: string; score: number }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('record_b2b_opportunity', {
    p_organization_id: gate.data.organizationId, p_platform: input.platform, p_external_ref: input.externalRef, p_url: input.url as never, p_title: input.title, p_description: input.description,
    p_budget_min_minor: input.budgetMinMinor as never, p_budget_max_minor: input.budgetMaxMinor as never, p_currency: input.currency, p_client_country: input.country as never, p_posted_at: undefined as never, p_source: 'assisted_import',
  });
  if (error) return err('INTERNAL', 'Could not record the job.');
  const r = first<{ outcome?: string; opportunity_id?: string; status?: string; score?: number }>(data);
  return r?.outcome === 'recorded' && r.opportunity_id ? ok({ opportunityId: r.opportunity_id, status: r.status ?? '', score: r.score ?? 0 }) : b2bFail(r?.outcome);
}

export async function decideB2bOpportunity(input: { opportunityId: string; decision: 'shortlist' | 'skip'; reason: string }): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('decide_b2b_opportunity', { p_organization_id: gate.data.organizationId, p_opportunity: input.opportunityId, p_decision: input.decision, p_reason: input.reason });
  if (error) return err('INTERNAL', 'Could not record the decision.');
  const o = first<{ outcome?: string }>(data)?.outcome;
  return o === 'decided' ? ok(true) : b2bFail(o);
}

export async function saveB2bProposal(input: { opportunityId: string; body: string; priceMinor: number | null; timelineDays: number | null; connects: number; portfolioIds: string[] }): Promise<Result<{ versionId: string }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('add_b2b_proposal_version', {
    p_organization_id: gate.data.organizationId, p_opportunity: input.opportunityId, p_body: input.body, p_price_minor: input.priceMinor as never, p_timeline_days: input.timelineDays as never,
    p_connects_cost: input.connects, p_portfolio_item_ids: input.portfolioIds, p_by_type: 'human',
  });
  if (error) return err('INTERNAL', 'Could not save the proposal.');
  const r = first<{ outcome?: string; version_id?: string }>(data);
  return r?.outcome === 'added' && r.version_id ? ok({ versionId: r.version_id }) : b2bFail(r?.outcome);
}

export async function checkB2bProposal(versionId: string): Promise<Result<{ passed: boolean; problems: string[] }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('check_b2b_proposal', { p_organization_id: gate.data.organizationId, p_version: versionId });
  if (error) return err('INTERNAL', 'Could not run the checks.');
  const r = first<{ outcome?: string; problems?: unknown }>(data);
  if (r?.outcome !== 'checked' && r?.outcome !== 'check_failed') return b2bFail(r?.outcome);
  return ok({ passed: r.outcome === 'checked', problems: Array.isArray(r.problems) ? (r.problems as string[]) : [] });
}

export async function submitB2bProposal(versionId: string): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('submit_b2b_proposal', { p_organization_id: gate.data.organizationId, p_version: versionId });
  if (error) return err('INTERNAL', 'Could not submit it.');
  const o = first<{ outcome?: string }>(data)?.outcome;
  return o === 'submitted' || o === 'already_pending' ? ok(true) : b2bFail(o);
}

/** A person sent the approved proposal on the platform and records it. Accepted only for the exact approved version, once. */
export async function recordB2bSent(input: { versionId: string; externalRef: string }): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('record_manual_b2b_submission', { p_organization_id: gate.data.organizationId, p_version: input.versionId, p_external_ref: input.externalRef });
  if (error) return err('INTERNAL', 'Could not record it.');
  const r = first<{ outcome?: string; reason?: string | null }>(data);
  return r?.outcome === 'recorded' ? ok(true) : b2bFail(r?.outcome, r?.reason);
}

export async function recordB2bOutcome(input: { opportunityId: string; outcome: 'won' | 'lost'; valueMinor: number | null; note: string }): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('record_b2b_outcome', { p_organization_id: gate.data.organizationId, p_opportunity: input.opportunityId, p_outcome: input.outcome, p_value_minor: input.valueMinor as never, p_note: input.note });
  if (error) return err('INTERNAL', 'Could not record the outcome.');
  const o = first<{ outcome?: string }>(data)?.outcome;
  return o === 'recorded' ? ok(true) : b2bFail(o);
}

export async function saveB2bProfile(input: { platform: string; content: Record<string, unknown> }): Promise<Result<{ versionId: string }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('add_b2b_profile_version', { p_organization_id: gate.data.organizationId, p_platform: input.platform, p_content: input.content as never, p_by_type: 'human' });
  if (error) return err('INTERNAL', 'Could not save the profile.');
  const r = first<{ outcome?: string; version_id?: string }>(data);
  return r?.outcome === 'added' && r.version_id ? ok({ versionId: r.version_id }) : b2bFail(r?.outcome);
}

export async function checkB2bProfile(versionId: string): Promise<Result<{ passed: boolean; problems: string[] }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('check_b2b_profile', { p_organization_id: gate.data.organizationId, p_version: versionId });
  if (error) return err('INTERNAL', 'Could not run the checks.');
  const r = first<{ outcome?: string; problems?: unknown }>(data);
  if (r?.outcome !== 'checked' && r?.outcome !== 'check_failed') return b2bFail(r?.outcome);
  return ok({ passed: r.outcome === 'checked', problems: Array.isArray(r.problems) ? (r.problems as string[]) : [] });
}

export async function submitB2bProfile(versionId: string): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('submit_b2b_profile', { p_organization_id: gate.data.organizationId, p_version: versionId });
  if (error) return err('INTERNAL', 'Could not submit it.');
  const o = first<{ outcome?: string }>(data)?.outcome;
  return o === 'submitted' || o === 'already_pending' ? ok(true) : b2bFail(o);
}

export async function recordB2bProfileApplied(input: { versionId: string; evidenceUrl: string }): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('record_manual_profile_update', { p_organization_id: gate.data.organizationId, p_version: input.versionId, p_evidence_url: input.evidenceUrl });
  if (error) return err('INTERNAL', 'Could not record it.');
  const r = first<{ outcome?: string; reason?: string | null }>(data);
  return r?.outcome === 'recorded' ? ok(true) : b2bFail(r?.outcome, r?.reason);
}

export async function linkB2bLead(input: { opportunityId: string; leadId: string }): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('link_b2b_opportunity_lead', { p_organization_id: gate.data.organizationId, p_opportunity: input.opportunityId, p_lead: input.leadId });
  if (error) return err('INTERNAL', 'Could not link it.');
  const o = first<{ outcome?: string }>(data)?.outcome;
  return o === 'linked' ? ok(true) : b2bFail(o);
}

// ── the by-hand path (20261024100000) ──────────────────────────────────────
// Until a connector exists, "apply it on the platform, then record it here" is the process. Each record is accepted only for the exact
// approved version, once, with the stops, the policy, the plan, the limits and the cap re-read at that moment.

export async function recordAdLaunched(input: { versionId: string; providerCampaignId: string; objects: { objectType: string; providerId: string }[] }): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('record_manual_ad_apply', {
    p_organization_id: gate.data.organizationId, p_version: input.versionId, p_provider_campaign_id: input.providerCampaignId,
    p_objects: input.objects.map((o) => ({ object_type: o.objectType, provider_id: o.providerId })) as never,
  });
  if (error) return err('INTERNAL', 'Could not record it.');
  const r = first<{ outcome?: string; reason?: string | null }>(data);
  return r?.outcome === 'recorded' ? ok(true) : b2bFail(r?.outcome, r?.reason);
}

export async function recordAdChangeDone(input: { campaignId: string; confirmed: boolean; detail: string }): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('record_manual_ad_change', { p_organization_id: gate.data.organizationId, p_campaign: input.campaignId, p_confirmed: input.confirmed, p_detail: input.detail as never });
  if (error) return err('INTERNAL', 'Could not record it.');
  const o = first<{ outcome?: string }>(data)?.outcome;
  if (o === 'confirmed' || o === 'left_pending') return ok(true);
  if (o === 'nothing_pending') return err('CONFLICT', 'Nothing is waiting for the platform on that campaign.');
  return b2bFail(o);
}

export async function recordAdFigures(input: { campaignId: string; date: string; spendMinor: number; impressions: number; clicks: number; platformLeads: number }): Promise<Result<{ countedMinor: number }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('record_manual_ad_metrics', {
    p_organization_id: gate.data.organizationId, p_campaign: input.campaignId, p_date: input.date, p_spend_minor: input.spendMinor, p_impressions: input.impressions, p_clicks: input.clicks, p_platform_leads: input.platformLeads,
  });
  if (error) return err('INTERNAL', 'Could not record the figures.');
  const r = first<{ outcome?: string; counted_minor?: number }>(data);
  if (r?.outcome === 'recorded') return ok({ countedMinor: Number(r.counted_minor ?? 0) });
  if (r?.outcome === 'never_launched') return err('CONFLICT', 'That campaign has not been recorded as launched, so there is nothing to report on.');
  return b2bFail(r?.outcome);
}

export async function recordPosted(input: { versionId: string; externalRef: string; url: string }): Promise<Result<true>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('record_manual_publish', { p_organization_id: gate.data.organizationId, p_version: input.versionId, p_external_ref: input.externalRef, p_url: (input.url || undefined) as never });
  if (error) return err('INTERNAL', 'Could not record it.');
  const r = first<{ outcome?: string; reason?: string | null }>(data);
  return r?.outcome === 'recorded' ? ok(true) : b2bFail(r?.outcome, r?.reason);
}

export type LandingUploadResult = { verification: 'verified' | 'failed' | 'not_recorded' };

/**
 * A person uploaded exactly the approved page (the app rendered it for them). The record is accepted only for the exact approved
 * version; whether the PUBLIC ADDRESS really carries it is then FETCHED and recorded - a person saying so never makes a page verified.
 */
export async function recordLandingUploaded(versionId: string): Promise<Result<LandingUploadResult>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const admin = createAdminClient();
  const page = await renderApprovedPage(admin, gate.data.organizationId, versionId);
  if (!page) return err('NOT_FOUND', 'That page version no longer exists.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('record_manual_landing_deploy', { p_organization_id: gate.data.organizationId, p_version: versionId, p_html_hash: page.htmlHash });
  if (error) return err('INTERNAL', 'Could not record it.');
  const r = first<{ outcome?: string; reason?: string | null }>(data);
  if (r?.outcome !== 'recorded') return b2bFail(r?.outcome, r?.reason);
  return ok({ verification: await verifyLandingVersion(admin, { organizationId: gate.data.organizationId, versionId }) });
}

/** Fetch the public address again and record what was found. Anyone allowed to manage may ask; nobody may say the answer. */
export async function recheckLanding(versionId: string): Promise<Result<LandingUploadResult>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data: v, error } = await supabase.schema('crm').from('landing_page_versions').select('id, state').eq('id', versionId).maybeSingle();
  if (error) return err('INTERNAL', 'Could not read the page.');
  if (!v) return err('NOT_FOUND', 'That page version no longer exists.');
  if (!['DEPLOYED', 'VERIFY_FAILED', 'VERIFIED'].includes(v.state)) return b2bFail('not_deployed');
  return ok({ verification: await verifyLandingVersion(createAdminClient(), { organizationId: gate.data.organizationId, versionId }) });
}

// ── the Email engine's decisions, run by a person (20261018100000) ─────────
// The same doors an agent calls. A person scores from what they know; nothing is inferred, and a factor left empty is MISSING and lowers the score.

export async function scoreProspect(input: { prospectId: string; factors: Partial<Record<QualificationFactor, number>>; reasoning: string }): Promise<Result<{ decision: string; score: number; disqualifiers: string[]; missing: string[] }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  for (const [k, v] of Object.entries(input.factors)) {
    if (!(QUALIFICATION_FACTORS as readonly string[]).includes(k) || !Number.isInteger(v) || (v as number) < 0 || (v as number) > 100) return err('VALIDATION', 'Each factor is a whole number from 0 to 100.');
  }
  const r = await qualifyProspect(createAdminClient(), { organizationId: gate.data.organizationId, prospectId: input.prospectId, factors: input.factors, reasoning: input.reasoning || undefined, evaluatedBy: 'human' });
  if (!r.ok) return err(r.refusal === 'unknown_prospect' ? 'NOT_FOUND' : 'VALIDATION', r.refusal === 'unknown_prospect' ? 'That prospect no longer exists.' : 'Check the scores.');
  return ok({ decision: r.decision, score: r.score, disqualifiers: r.disqualifiers, missing: r.missing });
}

export async function recordProspectFact(input: { prospectId: string; fact: string; sourceKind: FactSource; sourceUrl: string }): Promise<Result<{ factId: string }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  const r = await addProspectFact(createAdminClient(), { organizationId: gate.data.organizationId, prospectId: input.prospectId, fact: input.fact, sourceKind: input.sourceKind, sourceUrl: input.sourceUrl || undefined, recordedBy: 'human' });
  return r.ok ? ok({ factId: r.factId }) : err('VALIDATION', 'A fact needs its words, a source kind and, for a web source, the link it came from.');
}

export async function checkDraft(input: { prospectId: string; subject: string; body: string; claims: { text: string; factId: string }[] }): Promise<Result<{ valid: boolean; problems: string[] }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  return ok(await validateOutreachDraft(createAdminClient(), { organizationId: gate.data.organizationId, ...input }));
}

/** An admin makes a tracked WhatsApp link for a lead who is somewhere else (email, a profile, a marketplace). The reference is shown once and never stored. */
export async function createTrackedLink(input: { leadId: string; sourceChannel: string; sourcePlatform: string; nextAction: string }): Promise<Result<{ link: string; expiresAt: string; reused: boolean }>> {
  const gate = await managerWithOrg();
  if (!gate.ok) return gate;
  if (!(HANDOFF_SOURCE_CHANNELS as readonly string[]).includes(input.sourceChannel)) return err('VALIDATION', 'Choose where the person is now.');
  let r;
  try {
    r = await createHandoff(createAdminClient(), {
      organizationId: gate.data.organizationId, leadId: input.leadId, sourceChannel: input.sourceChannel as (typeof HANDOFF_SOURCE_CHANNELS)[number],
      sourcePlatform: input.sourcePlatform || undefined, sourceAgent: 'human', nextAction: input.nextAction || undefined,
    });
  } catch {
    return err('INTERNAL', 'A tracked link needs the vault key and the app address to be configured.');
  }
  if (r.ok) return ok({ link: r.handoff.link, expiresAt: r.handoff.expiresAt, reused: r.handoff.outcome === 'exists' });
  const messages: Record<string, string> = {
    unknown_lead: 'That lead does not exist.', lead_merged: 'That lead was merged into another; use the one it was merged into.', closed: 'That lead is already won, lost or disqualified.',
    platform_required: 'Say which marketplace the person is on.', offplatform_forbidden: 'That marketplace\'s rule does not allow moving a conversation to WhatsApp (see the B2B tab).',
    forbidden: FORBIDDEN, invalid: 'Check the lead id and where the person is now.',
  };
  return err(r.refusal === 'unknown_lead' ? 'NOT_FOUND' : 'CONFLICT', messages[r.refusal] ?? 'That was refused.');
}
