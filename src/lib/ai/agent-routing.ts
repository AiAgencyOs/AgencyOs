import 'server-only';

// The alias rather than './router', so a test that mocks '@/lib/ai/router'
// hands this module the same fake provider it hands the runner.
import { resolveProvider } from '@/lib/ai/router';
import type { createAdminClient } from '@/lib/db/admin';

import { categoryForAgent, orderModelCandidates } from './model-choice';

/**
 * The runner's half of SCR-064's routing-by-agent: which model, if any, an
 * owner has chosen for this agent instead of the row's default.
 *
 * Consulted from `app/api/jobs/run/agent-run.ts` at the two places the model
 * is reached, under the service role (the runner has no session). Order is
 * `orderModelCandidates`': the (agent, category) override first, the category
 * policy second, and the first candidate a registered provider actually
 * serves wins. An override naming a model no provider serves is skipped
 * rather than failing the run — the owner's next preference, or the default,
 * still runs, and the routing page shows which model the runner would take.
 *
 * Returns null when nothing but the default applies, so the caller keeps its
 * own `resolveProvider(ctx.agent.default_model)` path and a tenant that set
 * nothing runs exactly as before.
 *
 * Best effort, like the stamp beside the tick: a read that fails is logged
 * and answered null. A job must not die because a routing table was
 * unreadable for a moment — the default model is the honest fallback, and
 * `ai.agent_runs.model` records which one actually ran.
 */
export async function routedCandidatesFor(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  agentKey: string,
  /** ADM-61 class of the work, so the owner's fallback chain for it is consulted (decision 2026-09-30). */
  workClass?: string,
): Promise<string[]> {
  const category = categoryForAgent(agentKey);
  if (!category && !workClass) return [];

  try {
    const [overrideRead, policyRead, chainRead] = await Promise.all([
      admin
        .schema('ai')
        .from('agent_routing_overrides')
        .select('preferred_models')
        .eq('organization_id', organizationId)
        .eq('agent_key', agentKey)
        .eq('category', category ?? '')
        .maybeSingle(),
      admin
        .schema('ai')
        .from('routing_policies')
        .select('preferred_models, admin_override_model')
        .eq('organization_id', organizationId)
        .eq('category', category ?? '')
        .maybeSingle(),
      // The owner's fallback chain for this CLASS of work — after the override
      // and the policy, before the default.
      workClass
        ? admin.schema('ai').from('fallback_chains').select('model_ids').eq('organization_id', organizationId).eq('work_class', workClass).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (overrideRead.error) throw new Error(overrideRead.error.message);
    if (policyRead.error) throw new Error(policyRead.error.message);
    if (chainRead.error) throw new Error(chainRead.error.message);

    const candidates = orderModelCandidates({
      override: overrideRead.data ? { preferredModels: overrideRead.data.preferred_models } : null,
      policy: policyRead.data
        ? { adminOverrideModel: policyRead.data.admin_override_model, preferredModels: policyRead.data.preferred_models }
        : null,
      fallbackChain: chainRead.data?.model_ids ?? [],
      // The default is the caller's own fallback; excluded here so a null
      // answer means "nothing routed" rather than "the default, again".
      agentDefault: '',
    });

    // Every candidate a registered provider serves, in the owner's order. A
    // model no provider serves is skipped here, as it always was.
    const served: string[] = [];
    for (const candidate of candidates) {
      if ((await resolveProvider(candidate.model)).ok) served.push(candidate.model);
    }
    return served;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'warn',
        scope: 'routedModelFor',
        agentKey,
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    return [];
  }
}

/** The first routed model, or null when nothing but the default applies — the original contract. */
export async function routedModelFor(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  agentKey: string,
  workClass?: string,
): Promise<string | null> {
  return (await routedCandidatesFor(admin, organizationId, agentKey, workClass))[0] ?? null;
}
