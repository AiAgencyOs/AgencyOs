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
