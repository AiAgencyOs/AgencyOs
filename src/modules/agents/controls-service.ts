import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { setAgentCapsSchema, setAgentStatusSchema, type SetAgentCapsInput, type SetAgentStatusInput } from './controls-schema';

/**
 * ADM-82 — Decision: reversed by the owner on 2026-09-29.
 *
 * Owner only, twice: `context.role === 'owner'` plus `organization.settings`
 * here, and `core.is_owner()` again inside the SECURITY DEFINER doors, which
 * is the guard that actually holds because `ai.agents` has no end-user write
 * policy (20260815380000) for RLS to decide with.
 */
async function requireOwner(verb: string): Promise<Result<true>> {
  const context = await requireInternal();
  if (context.role !== 'owner' || !can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', `Only the owner may ${verb}.`);
  }
  return ok(true);
}

function outcomeOf(data: unknown): string | undefined {
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  return row?.outcome;
}

export async function setAgentStatus(input: SetAgentStatusInput): Promise<Result<{ enabled: boolean }>> {
  const parsed = setAgentStatusSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid status.');

  const gate = await requireOwner('enable or disable an agent');
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').rpc('set_agent_status', {
    p_agent_key: parsed.data.agentKey,
    p_enabled: parsed.data.enabled,
    ...(parsed.data.reason ? { p_reason: parsed.data.reason } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setAgentStatus', detail: error.message }));
    return err('INTERNAL', 'Could not change the agent’s status.');
  }

  switch (outcomeOf(data)) {
    case 'set':
      return ok({ enabled: parsed.data.enabled });
    case 'unchanged':
      return err('CONFLICT', parsed.data.enabled ? 'The agent is already enabled.' : 'The agent is already disabled.');
    case 'not_found':
      return err('NOT_FOUND', 'Agent not found in the registry.');
    case 'reason_required':
      return err('VALIDATION', 'Disabling an agent needs a reason.');
    default:
      return err('FORBIDDEN', 'Only the owner may enable or disable an agent.');
  }
}

export async function setAgentCaps(input: SetAgentCapsInput): Promise<Result<{ maxSteps: number; maxCostMinor: number }>> {
  const parsed = setAgentCapsSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid caps.');

  const gate = await requireOwner('change an agent’s ceilings');
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').rpc('set_agent_caps', {
    p_agent_key: parsed.data.agentKey,
    p_max_steps: parsed.data.maxSteps,
    p_max_cost_minor: parsed.data.maxCostMinor,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setAgentCaps', detail: error.message }));
    return err('INTERNAL', 'Could not change the agent’s ceilings.');
  }

  switch (outcomeOf(data)) {
    case 'set':
      return ok({ maxSteps: parsed.data.maxSteps, maxCostMinor: parsed.data.maxCostMinor });
    case 'unchanged':
      return err('CONFLICT', 'Those are already the agent’s ceilings.');
    case 'not_found':
      return err('NOT_FOUND', 'Agent not found in the registry.');
    case 'bad_caps':
      return err('VALIDATION', 'Steps must be 1–1000 and the cost cap between ₹0.01 and ₹10,00,000.');
    default:
      return err('FORBIDDEN', 'Only the owner may change an agent’s ceilings.');
  }
}
