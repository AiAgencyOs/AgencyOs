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
