import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-061 (bucket G-3) — one model's record, for `/agents/models/[modelId]`:
 * the registry row (`ai.models`), who added it and when (the `model.added`
 * / `model.reactivated` audit entry whose `after` carries this model id),
 * what routes to it (`ai.routing_policies`, `ai.agent_routing_overrides`,
 * `ai.fallback_chains`), what the runs that carried it did in the period
 * (`ai.agent_runs.model = id`: count, tokens, cost, average latency), and
 * the last twenty of those runs. Nothing is estimated; `null` for a model
 * the registry does not hold is the page's not-found; a failed read refuses.
 */

export const MODEL_PERIOD_DAYS = 30;
const SAMPLE = 2_000;

export type ModelRegistryEntry = {
  modelId: string;
  provider: string;
  status: string;
  capabilities: string[];
  contextTokens: number | null;
  inputCostMinorPerMtok: number | null;
  outputCostMinorPerMtok: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ModelRouting = {
  policies: { category: string; role: 'preferred' | 'admin_override'; position: number | null }[];
  overrides: { agentKey: string; category: string; position: number }[];
  chains: { workClass: string; position: number }[];
};

export type ModelRunRow = {
  id: string;
  agentKey: string;
  status: string;
  trigger: string;
  inputTokens: number;
  outputTokens: number;
  costMinor: number;
  latencyMs: number | null;
  createdAt: string;
};

export type ModelDetail = {
  model: ModelRegistryEntry;
  addedBy: { actorId: string | null; actorName: string | null; at: string; action: string } | null;
  routing: ModelRouting;
  period: { days: number; runs: number; failed: number; inputTokens: number; outputTokens: number; costMinor: number; averageLatencyMs: number | null };
  recentRuns: ModelRunRow[];
};

export async function readModelDetail(modelId: string, recentLimit = 20): Promise<ModelDetail | null> {
  const supabase = await createClient();

  const { data: row, error: modelError } = await supabase
    .schema('ai')
    .from('models')
    .select('model_id, provider, status, capabilities, context_tokens, input_cost_minor_per_mtok, output_cost_minor_per_mtok, created_at, updated_at')
    .eq('model_id', modelId)
    // The same id can be offered by two providers; this page shows the first (by provider id) - the Provider Manager has each offer.
    .order('provider')
    .limit(1)
    .maybeSingle();
  if (modelError) unreadable('readModelDetail.model', modelError);
  if (!row) return null;

  const since = new Date(Date.now() - MODEL_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [policies, overrides, chains, runs, audit] = await Promise.all([
    supabase.schema('ai').from('routing_policies').select('category, preferred_models, admin_override_model'),
    supabase.schema('ai').from('agent_routing_overrides').select('agent_key, category, preferred_models'),
    supabase.schema('ai').from('fallback_chains').select('work_class, model_ids'),
    supabase
      .schema('ai')
      .from('agent_runs')
      .select('id, agent_key, status, trigger, input_tokens, output_tokens, cost_minor, latency_ms, created_at')
      .eq('model', modelId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(SAMPLE),
    supabase
      .schema('audit')
      .from('audit_log')
      .select('actor_id, action, created_at, after')
      .in('action', ['model.added', 'model.reactivated'])
      .eq('after->>model_id', modelId)
      .order('created_at', { ascending: false })
      .limit(1),
  ]);
  if (policies.error) unreadable('readModelDetail.policies', policies.error);
  if (overrides.error) unreadable('readModelDetail.overrides', overrides.error);
  if (chains.error) unreadable('readModelDetail.chains', chains.error);
  if (runs.error) unreadable('readModelDetail.runs', runs.error);
  if (audit.error) unreadable('readModelDetail.audit', audit.error);

  const routing: ModelRouting = { policies: [], overrides: [], chains: [] };
  for (const p of policies.data ?? []) {
    const position = (p.preferred_models ?? []).indexOf(modelId);
    if (position >= 0) routing.policies.push({ category: p.category, role: 'preferred', position: position + 1 });
    if (p.admin_override_model === modelId) routing.policies.push({ category: p.category, role: 'admin_override', position: null });
  }
  for (const o of overrides.data ?? []) {
    const position = (o.preferred_models ?? []).indexOf(modelId);
    if (position >= 0) routing.overrides.push({ agentKey: o.agent_key, category: o.category, position: position + 1 });
  }
  for (const c of chains.data ?? []) {
    const position = (c.model_ids ?? []).indexOf(modelId);
    if (position >= 0) routing.chains.push({ workClass: c.work_class, position: position + 1 });
  }

  const runRows = runs.data ?? [];
  const latencies = runRows.map((r) => r.latency_ms).filter((l): l is number => l !== null && Number.isFinite(l));

  const entry = audit.data?.[0] ?? null;
  let actorName: string | null = null;
  if (entry?.actor_id) {
    const { data: user, error: userError } = await supabase.schema('core').from('users').select('full_name, email').eq('id', entry.actor_id).maybeSingle();
    if (userError) unreadable('readModelDetail.actor', userError);
    actorName = user?.full_name ?? user?.email ?? null;
  }

  return {
    model: {
      modelId: row.model_id,
      provider: row.provider,
      status: row.status,
      capabilities: row.capabilities ?? [],
      contextTokens: row.context_tokens,
      inputCostMinorPerMtok: row.input_cost_minor_per_mtok,
      outputCostMinorPerMtok: row.output_cost_minor_per_mtok,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    addedBy: entry ? { actorId: entry.actor_id, actorName, at: entry.created_at, action: entry.action } : null,
    routing,
    period: {
      days: MODEL_PERIOD_DAYS,
      runs: runRows.length,
      failed: runRows.filter((r) => r.status === 'failed').length,
      inputTokens: runRows.reduce((n, r) => n + r.input_tokens, 0),
      outputTokens: runRows.reduce((n, r) => n + r.output_tokens, 0),
      costMinor: runRows.reduce((n, r) => n + r.cost_minor, 0),
      averageLatencyMs: latencies.length > 0 ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length) : null,
    },
    recentRuns: runRows.slice(0, recentLimit).map((r) => ({
      id: r.id,
      agentKey: r.agent_key,
      status: r.status,
      trigger: r.trigger,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costMinor: r.cost_minor,
      latencyMs: r.latency_ms,
      createdAt: r.created_at,
    })),
  };
}
