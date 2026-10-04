import { orderModelCandidates, type ModelSource, type RoutingInputs } from './model-choice';
import type { HealthState } from './provider-match';

/**
 * Which provider and model a run uses - the rule, with no database and no network attached, so a test can drive every case.
 *
 * Two modes (the Admin's switch, per organization):
 *
 *   AUTO    The orchestrator chooses, but ONLY from what the Admin allowed. The owner's own preferences (the agent override, the
 *           category policy, the work class's fallback chain, the agent's default) still come first and in their order - they ARE
 *           the Admin's AUTO policy - and are kept only if their provider is enabled, has a usable key and is not known to be
 *           rejected or out of quota, and their model (when it is in the registry) is enabled. After them come other enabled models
 *           of eligible providers, ranked by what the Admin rated them for (quality, latency or cost). Nothing is guessed: a model
 *           with no rating is ranked after those with one, and a capability nobody recorded never excludes a model.
 *
 *   MANUAL  The Admin's assignment for the agent is honoured EXACTLY: that provider, that model. If either is disabled or has no
 *           key, the plan is BLOCKED with the reason - another provider is never substituted silently. Only fallbacks the Admin
 *           wrote down are used, and each must itself be enabled. An agent with no assignment runs on its own default model (the
 *           way it always has) and the plan says so.
 *
 * The plan is also the explanation: every candidate carries why it is there, and every model that was looked at and left out says why.
 */

export type RoutingMode = 'auto' | 'manual';

export type ProviderSnapshot = {
  readonly id: string;
  readonly enabled: boolean;
  readonly archived: boolean;
  readonly health: HealthState;
  readonly hasUsableKey: boolean;
  readonly priority: number;
  readonly supports: (model: string) => boolean;
};

export type ModelSnapshot = {
  readonly modelId: string;
  readonly provider: string;
  readonly enabled: boolean;
  readonly status: 'available' | 'deprecated' | 'retired' | string;
  readonly capabilities: readonly string[];
  readonly toolCalling: boolean | null;
  readonly structuredOutput: boolean | null;
  readonly qualityTier: number | null;
  readonly latencyTier: number | null;
  readonly costTier: number | null;
};

export type AssignmentSnapshot = {
  readonly providerId: string;
  readonly modelId: string;
  readonly fallbacks: readonly { readonly providerId: string; readonly modelId: string }[];
};

export type RouteInput = {
  readonly mode: RoutingMode;
  readonly configVersion: number;
  readonly agentKey: string;
  readonly agentDefault: string;
  readonly routing: Omit<RoutingInputs, 'agentDefault'>;
  readonly assignment: AssignmentSnapshot | null;
  readonly providers: readonly ProviderSnapshot[];
  readonly models: readonly ModelSnapshot[];
  readonly needsTools: boolean;
  readonly requiredCapabilities: readonly string[];
  readonly optimiseFor: 'quality' | 'cost' | 'latency' | null;
};

export type RouteSource = ModelSource | 'assignment' | 'assignment_fallback' | 'agent_default_unassigned' | 'auto_ranked';

export type RouteCandidate = { readonly providerId: string; readonly model: string; readonly source: RouteSource; readonly reason: string };
export type Considered = { readonly providerId: string | null; readonly model: string; readonly excluded: string | null };

export type RoutePlan = {
  readonly mode: RoutingMode;
  readonly configVersion: number;
  readonly candidates: readonly RouteCandidate[];
  /** MANUAL with a blocked assignment and no usable fallback; AUTO with nothing eligible. The run does not start. */
  readonly blocked: { readonly reason: string } | null;
  readonly considered: readonly Considered[];
  readonly warnings: readonly string[];
};

const MAX_EXTRAS = 4;

type Verdict = { ok: true } | { ok: false; why: string };

function providerVerdict(p: ProviderSnapshot | undefined, options: { strictHealth: boolean }): Verdict {
  if (!p) return { ok: false, why: 'provider is not configured' };
  if (p.archived) return { ok: false, why: `provider ${p.id} is archived` };
  if (!p.enabled) return { ok: false, why: `provider ${p.id} is disabled` };
  if (!p.hasUsableKey) return { ok: false, why: `provider ${p.id} has no usable key` };
  // A provider known to reject its keys, or to be out of quota, cannot recover without somebody acting; AUTO does not wait on it.
  if (options.strictHealth && (p.health === 'auth_error' || p.health === 'quota_exhausted')) return { ok: false, why: `provider ${p.id} is ${p.health.replace('_', ' ')}` };
  return { ok: true };
}

function modelVerdict(m: ModelSnapshot | undefined): Verdict {
  if (!m) return { ok: true }; // not in the registry: a legacy id the Admin named - allowed only when the Admin named it
  if (!m.enabled) return { ok: false, why: `model ${m.modelId} is disabled` };
  if (m.status !== 'available') return { ok: false, why: `model ${m.modelId} is ${m.status}` };
  return { ok: true };
}

const healthRank: Record<HealthState, number> = { healthy: 0, unknown: 1, degraded: 2, rate_limited: 3, unavailable: 4, quota_exhausted: 5, auth_error: 6 };

export function planRoute(input: RouteInput): RoutePlan {
  const providerById = new Map(input.providers.map((p) => [p.id, p]));
  // A model id is unique only within a provider: the same id may be offered by two (the real API and a gateway in front of it).
  const modelByKey = new Map(input.models.map((m) => [`${m.provider}::${m.modelId}`, m]));
  const offersOf = (model: string): ModelSnapshot[] => input.models.filter((m) => m.modelId === model);
  const byPriority = (a: ProviderSnapshot, b: ProviderSnapshot) => a.priority - b.priority || a.id.localeCompare(b.id);
  const considered: Considered[] = [];
  const warnings: string[] = [];

  /** The providers that serve a model id: those that registered it (best priority first), else the first one that recognises its id. */
  const providersFor = (model: string): ProviderSnapshot[] => {
    const registered = offersOf(model)
      .map((m) => providerById.get(m.provider))
      .filter((p): p is ProviderSnapshot => p !== undefined)
      .sort(byPriority);
    if (registered.length > 0) return registered;
    const recognised = [...input.providers].sort(byPriority).find((p) => p.supports(model));
    return recognised ? [recognised] : [];
  };
  const providerFor = (model: string): ProviderSnapshot | undefined => providersFor(model)[0];

  if (input.mode === 'manual') {
    const a = input.assignment;
    if (!a) {
      // Nothing assigned: the agent keeps running on its own default, exactly as before. Said plainly, so the page can warn.
      const p = providerFor(input.agentDefault);
      const v = providerVerdict(p, { strictHealth: false });
      considered.push({ providerId: p?.id ?? null, model: input.agentDefault, excluded: v.ok ? null : v.why });
      warnings.push(`MANUAL mode but ${input.agentKey} has no assignment: it runs on its own default model.`);
      if (!v.ok || !p) return { mode: 'manual', configVersion: input.configVersion, candidates: [], blocked: { reason: v.ok ? `no provider serves ${input.agentDefault}` : v.why }, considered, warnings };
      return {
        mode: 'manual', configVersion: input.configVersion, warnings, considered,
        candidates: [{ providerId: p.id, model: input.agentDefault, source: 'agent_default_unassigned', reason: 'no manual assignment; the agent\'s own default' }],
        blocked: null,
      };
    }

    const candidates: RouteCandidate[] = [];
    const check = (providerId: string, model: string, source: RouteSource, reason: string): string | null => {
      const p = providerById.get(providerId);
      const pv = providerVerdict(p, { strictHealth: false });
      const m = modelByKey.get(`${providerId}::${model}`);
      const elsewhere = offersOf(model).map((o) => o.provider);
      const mv = !m
        ? ({ ok: false, why: elsewhere.length > 0 ? `model ${model} is registered under ${elsewhere.join(', ')}, not ${providerId}` : `model ${model} is not in the registry` } as const)
        : modelVerdict(m);
      const why = !pv.ok ? pv.why : !mv.ok ? mv.why : input.needsTools && m?.toolCalling === false ? `model ${model} does not support tool calling` : null;
      considered.push({ providerId, model, excluded: why });
      if (!why) candidates.push({ providerId, model, source, reason });
      return why;
    };

    const primaryWhy = check(a.providerId, a.modelId, 'assignment', 'the Admin\'s manual assignment');
    for (const f of a.fallbacks) {
      const why = check(f.providerId, f.modelId, 'assignment_fallback', 'an explicit fallback the Admin configured');
      if (why) warnings.push(`Fallback ${f.providerId}/${f.modelId} is not usable: ${why}.`);
    }
    if (candidates.length === 0) {
      return { mode: 'manual', configVersion: input.configVersion, candidates, blocked: { reason: `Manual assignment ${a.providerId}/${a.modelId} cannot run: ${primaryWhy}. No fallback is configured, so nothing else was substituted.` }, considered, warnings };
    }
    if (primaryWhy) warnings.push(`The manual assignment ${a.providerId}/${a.modelId} cannot run (${primaryWhy}); only its configured fallbacks are used.`);
    return { mode: 'manual', configVersion: input.configVersion, candidates, blocked: null, considered, warnings };
  }

  // ── AUTO ──
  const out: RouteCandidate[] = [];
  const seen = new Set<string>();
  const considerOffer = (p: ProviderSnapshot | undefined, m: ModelSnapshot | undefined, model: string, source: RouteSource, reason: string): void => {
    const key = `${p?.id ?? ''}::${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    const pv = providerVerdict(p, { strictHealth: true });
    const mv = modelVerdict(m);
    const toolsWhy = input.needsTools && m?.toolCalling === false ? `model ${model} does not support tool calling` : null;
    const why = !pv.ok ? pv.why : !mv.ok ? mv.why : toolsWhy;
    considered.push({ providerId: p?.id ?? null, model, excluded: why });
    if (!why && p) out.push({ providerId: p.id, model, source, reason });
  };
  // A model id the Admin ranked is offered by EVERY provider that registered it, best provider first - a gateway and the real API
  // for the same id are two candidates, so one being down does not lose the model.
  const consider = (model: string, source: RouteSource, reason: string): void => {
    const providers = providersFor(model);
    if (providers.length === 0) return considerOffer(undefined, undefined, model, source, reason);
    for (const p of providers) considerOffer(p, modelByKey.get(`${p.id}::${model}`), model, source, reason);
  };

  // 1. the Admin's own preferences, in their order (the agent default is always last of them)
  for (const c of orderModelCandidates({ ...input.routing, agentDefault: input.agentDefault })) {
    consider(c.model, c.source, c.source === 'agent_default' ? 'the agent\'s own default model' : `the Admin's routing (${c.source.replace('_', ' ')})`);
  }

  // 2. then other enabled models of eligible providers, ranked by the Admin's own ratings
  const extraWhy = (m: ModelSnapshot): string | null => {
    const p = providerById.get(m.provider);
    const pv = providerVerdict(p, { strictHealth: true });
    if (!pv.ok) return pv.why;
    const mv = modelVerdict(m);
    if (!mv.ok) return mv.why;
    if (input.needsTools && m.toolCalling === false) return `model ${m.modelId} does not support tool calling`;
    // A capability nobody recorded never excludes a model; one that was recorded and lacks the need does.
    if (input.requiredCapabilities.length > 0 && m.capabilities.length > 0 && !input.requiredCapabilities.every((c) => m.capabilities.includes(c))) {
      return `model ${m.modelId} lacks ${input.requiredCapabilities.filter((c) => !m.capabilities.includes(c)).join(', ')}`;
    }
    return null;
  };
  const extras: ModelSnapshot[] = [];
  for (const m of input.models) {
    if (seen.has(`${m.provider}::${m.modelId}`)) continue;
    const why = extraWhy(m);
    if (why) considered.push({ providerId: m.provider, model: m.modelId, excluded: why });
    else extras.push(m);
  }
  const rate = (m: ModelSnapshot): number => {
    const tier = input.optimiseFor === 'cost' ? m.costTier : input.optimiseFor === 'latency' ? m.latencyTier : m.qualityTier;
    if (tier === null) return Number.POSITIVE_INFINITY; // unrated: after every rated model
    // quality: higher is better; latency and cost: lower is better
    return input.optimiseFor === 'cost' || input.optimiseFor === 'latency' ? tier : 6 - tier;
  };
  extras.sort((a, b) => {
    const pa = providerById.get(a.provider) as ProviderSnapshot;
    const pb = providerById.get(b.provider) as ProviderSnapshot;
    return healthRank[pa.health] - healthRank[pb.health] || rate(a) - rate(b) || pa.priority - pb.priority || a.modelId.localeCompare(b.modelId);
  });
  for (const m of extras.slice(0, MAX_EXTRAS)) considerOffer(providerById.get(m.provider), m, m.modelId, 'auto_ranked', `an enabled model ranked by ${input.optimiseFor ?? 'quality'}${rate(m) === Number.POSITIVE_INFINITY ? ' (unrated)' : ''}`);

  // Providers in a rate-limited or unavailable state are still allowed, but after healthy ones: stale health must not deadlock routing.
  const sorted = out
    .map((c, i) => ({ c, i, h: healthRank[providerById.get(c.providerId)?.health ?? 'unknown'] }))
    .sort((a, b) => Number(a.h >= 3) - Number(b.h >= 3) || a.i - b.i)
    .map((x) => x.c);

  if (sorted.length === 0) {
    const first = considered.find((c) => c.excluded)?.excluded;
    return { mode: 'auto', configVersion: input.configVersion, candidates: [], blocked: { reason: first ?? 'No enabled provider and model can serve this agent.' }, considered, warnings };
  }
  return { mode: 'auto', configVersion: input.configVersion, candidates: sorted, blocked: null, considered, warnings };
}
