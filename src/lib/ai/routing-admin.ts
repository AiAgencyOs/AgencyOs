import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import type { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { resetProviderRegistry } from './router';

type RequestClient = Awaited<ReturnType<typeof createClient>>;
const first = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

/**
 * The write surface for the routing mode and the manual per-agent assignments. Like provider-admin, it is thin: the `ai.*` doors
 * own who may, what is validated and what is audited; this layer only maps their outcomes to sentences and forgets the cached
 * registry so the change is felt by the next run.
 */

async function gate(): Promise<Result<true>> {
  const context = await requireInternal();
  if (!can(context, 'ai.routing.manage')) return err('FORBIDDEN', 'You do not have permission to change routing.');
  return ok(true);
}

export async function setRoutingMode(supabase: RequestClient, mode: 'auto' | 'manual', reason: string): Promise<Result<{ changed: boolean }>> {
  const g = await gate();
  if (!g.ok) return g;
  const { data, error } = await supabase.schema('ai').rpc('set_routing_mode', { p_mode: mode, p_reason: reason });
  if (error) return err('INTERNAL', 'Could not change the routing mode.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'changed':
      resetProviderRegistry();
      return ok({ changed: true });
    case 'unchanged':
      return ok({ changed: false });
    case 'needs_reason':
      return err('VALIDATION', 'Say why you are changing the routing mode - every agent is affected and the reason is kept in the audit trail.');
    case 'bad_mode':
      return err('VALIDATION', 'The mode must be auto or manual.');
    default:
      return err('FORBIDDEN', 'Only the owner may switch the routing mode.');
  }
}

export type Fallback = { providerId: string; modelId: string };

const REFUSAL: Record<string, string> = {
  unknown_agent: 'That agent was not found.',
  unknown_provider: 'That provider was not found.',
  unknown_model: 'That model is not in the registry. Refresh the provider\'s models or register it first.',
  provider_mismatch: 'That model belongs to a different provider.',
  provider_archived: 'That provider is archived.',
  too_many_fallbacks: 'At most three fallbacks.',
};

export async function setAssignment(
  supabase: RequestClient,
  input: { agentKey: string; providerId: string; modelId: string; fallbacks: Fallback[]; note: string },
): Promise<Result<true>> {
  const g = await gate();
  if (!g.ok) return g;
  const { data, error } = await supabase.schema('ai').rpc('set_agent_assignment', {
    p_agent_key: input.agentKey,
    p_provider_id: input.providerId,
    p_model_id: input.modelId,
    p_fallbacks: input.fallbacks as unknown as never,
    p_note: input.note,
  });
  if (error) return err('INTERNAL', 'Could not save the assignment.');
  const row = first<{ outcome?: string; detail?: string }>(data);
  if (row?.outcome === 'saved') {
    resetProviderRegistry();
    return ok(true);
  }
  const base = REFUSAL[row?.outcome ?? ''];
  if (base) return err('VALIDATION', row?.detail ? `${base} (${row.detail})` : base);
  return err('FORBIDDEN', 'Only the owner may assign models to agents.');
}

export async function clearAssignment(supabase: RequestClient, agentKey: string): Promise<Result<true>> {
  const g = await gate();
  if (!g.ok) return g;
  const { data, error } = await supabase.schema('ai').rpc('clear_agent_assignment', { p_agent_key: agentKey });
  if (error) return err('INTERNAL', 'Could not clear the assignment.');
  const outcome = first<{ outcome?: string }>(data)?.outcome;
  if (outcome === 'cleared' || outcome === 'none') {
    resetProviderRegistry();
    return ok(true);
  }
  return err('FORBIDDEN', 'Only the owner may clear an assignment.');
}
