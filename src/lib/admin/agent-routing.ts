import 'server-only';

import { ROUTING_CATEGORIES, type RoutingCategory } from '@/lib/ai/model-choice';
import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

/**
 * Routing by agent — SCR-064, `ai.agent_routing_overrides` (20260929210000).
 *
 * The screen's half. `src/lib/ai/model-choice.ts` holds the rule (override →
 * category policy → agent default) and `src/lib/ai/agent-routing.ts` applies
 * it in the runner; this reads what an owner has set and writes it through
 * `ai.set_agent_routing_override`, which is owner-only, audited, and clears
 * by deleting the row when the list is empty.
 */

export type AgentRoutingOverrideRow = {
  agentKey: string;
  category: RoutingCategory;
  preferredModels: string[];
  note: string | null;
  updatedAt: string;
};

export async function listAgentRoutingOverrides(): Promise<AgentRoutingOverrideRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('agent_routing_overrides')
    .select('agent_key, category, preferred_models, note, updated_at')
    .order('agent_key')
    .order('category');

  if (error) unreadable('listAgentRoutingOverrides', error);

  return (data ?? []).map((r) => ({
    agentKey: r.agent_key,
    category: r.category as RoutingCategory,
    preferredModels: r.preferred_models,
    note: r.note,
    updatedAt: r.updated_at,
  }));
}

export async function setAgentRoutingOverride(input: {
  agentKey: string;
  category: string;
  preferredModels: string[];
  note?: string;
}): Promise<Result<{ outcome: 'set' | 'cleared' }>> {
  if (!/^[a-z][a-z0-9_]{2,48}$/.test(input.agentKey)) return err('VALIDATION', 'Not an agent key.');
  if (!(ROUTING_CATEGORIES as readonly string[]).includes(input.category)) {
    return err('VALIDATION', 'Not a routing category this system recognises.');
  }
  const models = input.preferredModels.map((m) => m.trim()).filter(Boolean);
  if (models.length > 8) return err('VALIDATION', 'At most eight models, in order of preference.');
  if (models.some((m) => m.length > 120)) return err('VALIDATION', 'That is not a model id.');

  // Owner only: which model an agent spends the agency's money on is the
  // owner's decision (ADM-84), and the function and RLS both say so again.
  const context = await requireInternal();
  if (!hasRole(context, 'owner') || !can(context, 'organization.settings')) {
    return err('FORBIDDEN', 'Only the owner may set a routing override.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').rpc('set_agent_routing_override', {
    p_agent_key: input.agentKey,
    p_category: input.category,
    p_preferred_models: models,
    ...(input.note?.trim() ? { p_note: input.note.trim() } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setAgentRoutingOverride', detail: error.message }));
    return err('INTERNAL', 'Could not save the routing override.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ outcome: 'set' });
    case 'cleared':
      return ok({ outcome: 'cleared' });
    case 'not_found':
      return err('NOT_FOUND', 'Agent not found in the registry.');
    case 'bad_category':
      return err('VALIDATION', 'Not a routing category this system recognises.');
    case 'bad_models':
      return err('VALIDATION', 'At most eight models, in order of preference.');
    default:
      return err('FORBIDDEN', 'Only the owner may set a routing override.');
  }
}
