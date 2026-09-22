import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';
import { unreadable } from '@/lib/result';

/**
 * Model routing — ADM-84, ai.routing_policies (20260814120004). Per
 * category, not per agent: thirteen agents would be thirteen independent
 * knobs, and the seven categories correspond to behaviour that genuinely
 * differs. `routing_policies_write` already admits owner/ops_admin directly
 * (`core.is_admin()`) — no door function, so this reads and writes the
 * table plainly under RLS, the same as any other admin-config row.
 *
 * `ai.models` ships empty by design (ADM-84 deferred the second provider,
 * and seeding rows would be writing provider facts nobody established) —
 * so `preferredModels` and `adminOverrideModel` are free text here rather
 * than a picker against a registry that has nothing in it yet.
 */

export const ROUTING_CATEGORIES = [
  'engineering',
  'coordination',
  'client_facing',
  'extraction',
  'design',
  'money',
  'certification',
] as const;
export type RoutingCategory = (typeof ROUTING_CATEGORIES)[number];

export const OPTIMISE_FOR = ['quality', 'cost', 'latency'] as const;
export type OptimiseFor = (typeof OPTIMISE_FOR)[number];

export type RoutingPolicyRow = {
  category: RoutingCategory;
  optimiseFor: OptimiseFor;
  preferredModels: string[];
  adminOverrideModel: string | null;
  /** False when this category has never been configured — every field is the resolver's own default. */
  configured: boolean;
};

export async function listRoutingPolicies(): Promise<RoutingPolicyRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('routing_policies')
    .select('category, optimise_for, preferred_models, admin_override_model');

  if (error) unreadable('listRoutingPolicies', error);

  const byCategory = new Map((data ?? []).map((r) => [r.category, r]));

  return ROUTING_CATEGORIES.map((category) => {
    const row = byCategory.get(category);
    return {
      category,
      optimiseFor: (row?.optimise_for as OptimiseFor) ?? 'quality',
      preferredModels: row?.preferred_models ?? [],
      adminOverrideModel: row?.admin_override_model ?? null,
      configured: row !== undefined,
    };
  });
}

export async function setRoutingPolicy(input: {
  category: RoutingCategory;
  optimiseFor: OptimiseFor;
  preferredModels: string[];
  adminOverrideModel?: string;
}): Promise<Result<{ category: RoutingCategory }>> {
  if (!ROUTING_CATEGORIES.includes(input.category)) {
    return err('VALIDATION', 'Not a routing category this system recognises.');
  }
  if (!OPTIMISE_FOR.includes(input.optimiseFor)) {
    return err('VALIDATION', 'Not an optimisation this system recognises.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'Only an owner may change model routing.');
  }
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { error } = await supabase
    .schema('ai')
    .from('routing_policies')
    .upsert(
      {
        organization_id: context.organizationId,
        category: input.category,
        optimise_for: input.optimiseFor,
        preferred_models: input.preferredModels,
        admin_override_model: input.adminOverrideModel ?? null,
      },
      { onConflict: 'organization_id,category' },
    );

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setRoutingPolicy', detail: error.message }));
    return err('INTERNAL', 'Could not save the routing policy.');
  }

  return ok({ category: input.category });
}
