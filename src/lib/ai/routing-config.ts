import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { serverEnv } from '@/lib/env';

import { categoryForAgent } from './model-choice';
import { keyEligibility, modelMatches, type HealthState } from './provider-match';
import type { AssignmentSnapshot, ModelSnapshot, ProviderSnapshot, RouteInput, RoutingMode } from './route-plan';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Reads everything the pure planner needs, for one run, in one place: the organization's routing mode and configuration version, this
 * agent's manual assignment, the provider and model registry, and the Admin's existing routing preferences (override, policy,
 * fallback chain). Under the service role, because the runner has no session.
 *
 * Returns null when anything cannot be read, so the caller keeps the routing it always had. A routing table that is unreadable for a
 * moment must not stop a job: the default model is the honest fallback, and the run records which model actually ran.
 */

const BUILTIN_KEY_ENV: Record<string, 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY' | 'XAI_API_KEY' | 'OPENROUTER_API_KEY'> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/** The pieces a decision row and the cost calculation need beyond the plan itself. */
/** A price belongs to a provider's offer of a model: the same id can cost different amounts through a gateway. */
export const priceKey = (provider: string, model: string): string => `${provider}::${model}`;

export type LoadedRouting = {
  readonly input: Omit<RouteInput, 'needsTools' | 'requiredCapabilities'>;
  readonly category: string | null;
  /** Prices the Admin recorded, in minor units per million tokens. A model with no price is not costed (cost is never invented). */
  readonly prices: ReadonlyMap<string, { readonly input: number; readonly output: number }>;
};

export async function loadRouting(
  admin: Admin,
  args: { organizationId: string; agentKey: string; agentDefault: string; workClass?: string },
): Promise<LoadedRouting | null> {
  const category = categoryForAgent(args.agentKey);
  try {
    const [settings, assignment, providers, keys, models, override, policy, chain] = await Promise.all([
      admin.schema('ai').from('routing_settings').select('mode, version').eq('organization_id', args.organizationId).maybeSingle(),
      admin.schema('ai').from('agent_model_assignments').select('provider_id, model_id, fallbacks').eq('organization_id', args.organizationId).eq('agent_key', args.agentKey).maybeSingle(),
      admin.schema('ai').from('providers').select('provider_id, enabled, archived_at, health_state, priority, match_prefixes, match_contains'),
      admin.schema('ai').from('provider_keys').select('provider_id, enabled, health_state, cooldown_until, priority, label'),
      admin
        .schema('ai')
        .from('models')
        .select('model_id, provider, enabled, status, capabilities, tool_calling, structured_output, quality_tier, latency_tier, cost_tier, input_cost_minor_per_mtok, output_cost_minor_per_mtok')
        .eq('organization_id', args.organizationId),
      category
        ? admin.schema('ai').from('agent_routing_overrides').select('preferred_models').eq('organization_id', args.organizationId).eq('agent_key', args.agentKey).eq('category', category).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      category
        ? admin.schema('ai').from('routing_policies').select('preferred_models, admin_override_model, optimise_for').eq('organization_id', args.organizationId).eq('category', category).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      args.workClass
        ? admin.schema('ai').from('fallback_chains').select('model_ids').eq('organization_id', args.organizationId).eq('work_class', args.workClass).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    for (const r of [settings, assignment, providers, keys, models, override, policy, chain]) if (r.error) return null;
    if (!providers.data) return null;

    const env = serverEnv() as unknown as Record<string, string | undefined>;
    const now = new Date();
    const providerSnapshots: ProviderSnapshot[] = providers.data.map((p) => {
      const envKey = BUILTIN_KEY_ENV[p.provider_id];
      const hasEnv = Boolean(envKey && env[envKey]?.trim());
      const stored = (keys.data ?? [])
        .filter((k) => k.provider_id === p.provider_id)
        .some((k) => keyEligibility({ enabled: k.enabled, health: k.health_state as HealthState, priority: k.priority, cooldownUntil: k.cooldown_until ? new Date(k.cooldown_until) : null, label: k.label }, now).usable);
      return {
        id: p.provider_id,
        enabled: p.enabled,
        archived: p.archived_at !== null,
        health: p.health_state as HealthState,
        hasUsableKey: hasEnv || stored,
        priority: p.priority,
        supports: (m) => modelMatches({ prefixes: p.match_prefixes, contains: p.match_contains }, m),
      };
    });

    const modelSnapshots: ModelSnapshot[] = (models.data ?? []).map((m) => ({
      modelId: m.model_id,
      provider: m.provider,
      enabled: m.enabled,
      status: m.status,
      capabilities: m.capabilities ?? [],
      toolCalling: m.tool_calling,
      structuredOutput: m.structured_output,
      qualityTier: m.quality_tier,
      latencyTier: m.latency_tier,
      costTier: m.cost_tier,
    }));
    const prices = new Map<string, { input: number; output: number }>();
    for (const m of models.data ?? []) {
      if (m.input_cost_minor_per_mtok !== null && m.output_cost_minor_per_mtok !== null) {
        prices.set(priceKey(m.provider, m.model_id), { input: Number(m.input_cost_minor_per_mtok), output: Number(m.output_cost_minor_per_mtok) });
      }
    }

    const a = assignment.data;
    const assignmentSnapshot: AssignmentSnapshot | null = a
      ? {
          providerId: a.provider_id,
          modelId: a.model_id,
          fallbacks: Array.isArray(a.fallbacks) ? (a.fallbacks as { providerId: string; modelId: string }[]).filter((f) => f && typeof f.providerId === 'string' && typeof f.modelId === 'string') : [],
        }
      : null;

    const optimise = policy.data?.optimise_for;
    return {
      category,
      prices,
      input: {
        mode: (settings.data?.mode === 'manual' ? 'manual' : 'auto') as RoutingMode,
        configVersion: settings.data?.version ?? 0,
        agentKey: args.agentKey,
        agentDefault: args.agentDefault,
        routing: {
          override: override.data ? { preferredModels: override.data.preferred_models } : null,
          policy: policy.data ? { adminOverrideModel: policy.data.admin_override_model, preferredModels: policy.data.preferred_models } : null,
          fallbackChain: chain.data?.model_ids ?? [],
        },
        assignment: assignmentSnapshot,
        providers: providerSnapshots,
        models: modelSnapshots,
        optimiseFor: optimise === 'cost' || optimise === 'latency' || optimise === 'quality' ? optimise : null,
      },
    };
  } catch (error) {
    console.error(JSON.stringify({ level: 'warn', scope: 'loadRouting', agentKey: args.agentKey, detail: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

/** Cost in minor units from the usage a provider reported and a price the Admin recorded. No price, no cost: never an estimate. */
export function costMinorFor(price: { input: number; output: number } | undefined, usage: { inputTokens: number; outputTokens: number }): number {
  if (!price) return 0;
  return Math.ceil((price.input * usage.inputTokens + price.output * usage.outputTokens) / 1_000_000);
}

/** What a category needs of a model beyond what every model must do. Only what the Admin has actually recorded can exclude a model. */
export function requiredCapabilitiesFor(category: string | null): string[] {
  return category === 'engineering' ? ['coding'] : [];
}
