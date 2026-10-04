import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What the AI Provider Manager screens read. Everything goes through the request's own session, so RLS (admin read) and the
 * `provider_key_status` door decide who sees what - and none of it carries a ciphertext: a key is only ever a label, the last four
 * characters it recorded and its health.
 */

export type ProviderRow = {
  providerId: string;
  kind: string;
  displayName: string;
  isBuiltin: boolean;
  enabled: boolean;
  archived: boolean;
  baseUrl: string;
  authScheme: string;
  apiVersion: string | null;
  matchPrefixes: string[];
  matchContains: string[];
  extraHeaders: Record<string, string>;
  modelsPath: string;
  timeoutMs: number;
  retryMax: number;
  priority: number;
  healthState: string;
  healthDetail: string | null;
  healthCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastLatencyMs: number | null;
  recentCalls: number;
  keyCount: number;
  usableKeyCount: number;
  modelCount: number;
  enabledModelCount: number;
};

export type KeyRow = {
  id: string;
  providerId: string;
  label: string;
  environment: string;
  hint: string | null;
  enabled: boolean;
  priority: number;
  expiresOn: string | null;
  healthState: string;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  cooldownUntil: string | null;
  rotatedAt: string | null;
  createdAt: string;
  createdByName: string | null;
};

export type ManagerModel = {
  modelId: string;
  provider: string;
  displayName: string | null;
  status: string;
  enabled: boolean;
  source: string;
  capabilities: string[];
  contextTokens: number | null;
  toolCalling: boolean | null;
  structuredOutput: boolean | null;
  inputCostMinorPerMtok: number | null;
  outputCostMinorPerMtok: number | null;
  lastSeenAt: string | null;
};

export async function listProviderKeys(providerId?: string): Promise<KeyRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').rpc('provider_key_status', providerId ? { p_provider_id: providerId } : {});
  if (error) unreadable('listProviderKeys', error);
  return (data ?? []).map((k) => ({
    id: k.id ?? '',
    providerId: k.provider_id ?? '',
    label: k.label ?? '',
    environment: k.environment ?? 'production',
    hint: k.hint,
    enabled: k.enabled ?? false,
    priority: k.priority ?? 100,
    expiresOn: k.expires_on,
    healthState: k.health_state ?? 'unknown',
    lastUsedAt: k.last_used_at,
    lastSuccessAt: k.last_success_at,
    lastError: k.last_error,
    lastErrorAt: k.last_error_at,
    consecutiveFailures: k.consecutive_failures ?? 0,
    cooldownUntil: k.cooldown_until,
    rotatedAt: k.rotated_at,
    createdAt: k.created_at ?? '',
    createdByName: k.created_by_name,
  }));
}

export async function listManagerModels(providerId?: string): Promise<ManagerModel[]> {
  const supabase = await createClient();
  let query = supabase
    .schema('ai')
    .from('models')
    .select('model_id, provider, display_name, status, enabled, source, capabilities, context_tokens, tool_calling, structured_output, input_cost_minor_per_mtok, output_cost_minor_per_mtok, last_seen_at')
    .order('provider')
    .order('model_id')
    .limit(1000);
  if (providerId) query = query.eq('provider', providerId);
  const { data, error } = await query;
  if (error) unreadable('listManagerModels', error);
  return (data ?? []).map((m) => ({
    modelId: m.model_id,
    provider: m.provider,
    displayName: m.display_name,
    status: m.status,
    enabled: m.enabled,
    source: m.source,
    capabilities: m.capabilities ?? [],
    contextTokens: m.context_tokens,
    toolCalling: m.tool_calling,
    structuredOutput: m.structured_output,
    inputCostMinorPerMtok: m.input_cost_minor_per_mtok,
    outputCostMinorPerMtok: m.output_cost_minor_per_mtok,
    lastSeenAt: m.last_seen_at,
  }));
}

export async function listProviders(): Promise<ProviderRow[]> {
  const supabase = await createClient();
  const [providers, keys, models] = await Promise.all([
    supabase.schema('ai').from('providers').select('*').order('priority').order('provider_id'),
    listProviderKeys(),
    listManagerModels(),
  ]);
  if (providers.error) unreadable('listProviders', providers.error);
  const now = Date.now();
  return (providers.data ?? []).map((p) => {
    const mine = keys.filter((k) => k.providerId === p.provider_id);
    const theirs = models.filter((m) => m.provider === p.provider_id);
    return {
      providerId: p.provider_id,
      kind: p.kind,
      displayName: p.display_name,
      isBuiltin: p.is_builtin,
      enabled: p.enabled,
      archived: Boolean(p.archived_at),
      baseUrl: p.base_url,
      authScheme: p.auth_scheme,
      apiVersion: p.api_version,
      matchPrefixes: p.match_prefixes ?? [],
      matchContains: p.match_contains ?? [],
      extraHeaders: (p.extra_headers ?? {}) as Record<string, string>,
      modelsPath: p.models_path,
      timeoutMs: p.timeout_ms,
      retryMax: p.retry_max,
      priority: p.priority,
      healthState: p.health_state,
      healthDetail: p.health_detail,
      healthCheckedAt: p.health_checked_at,
      lastSuccessAt: p.last_success_at,
      lastFailureAt: p.last_failure_at,
      lastLatencyMs: p.last_latency_ms,
      recentCalls: p.recent_calls,
      keyCount: mine.length,
      usableKeyCount: mine.filter((k) => k.enabled && k.healthState !== 'auth_error' && !(k.cooldownUntil && new Date(k.cooldownUntil).getTime() > now)).length,
      modelCount: theirs.length,
      enabledModelCount: theirs.filter((m) => m.enabled && m.status === 'available').length,
    };
  });
}

export type AssignmentRow = { agentKey: string; providerId: string; modelId: string; fallbacks: { providerId: string; modelId: string }[]; note: string | null; updatedAt: string };

export async function readRoutingMode(): Promise<{ mode: 'auto' | 'manual'; version: number; reason: string | null; changedAt: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').from('routing_settings').select('mode, version, reason, changed_at').maybeSingle();
  if (error) unreadable('readRoutingMode', error);
  return { mode: data?.mode === 'manual' ? 'manual' : 'auto', version: data?.version ?? 1, reason: data?.reason ?? null, changedAt: data?.changed_at ?? null };
}

export async function listAssignments(): Promise<AssignmentRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').from('agent_model_assignments').select('agent_key, provider_id, model_id, fallbacks, note, updated_at');
  if (error) unreadable('listAssignments', error);
  return (data ?? []).map((a) => ({
    agentKey: a.agent_key,
    providerId: a.provider_id,
    modelId: a.model_id,
    fallbacks: Array.isArray(a.fallbacks) ? (a.fallbacks as { providerId: string; modelId: string }[]) : [],
    note: a.note,
    updatedAt: a.updated_at,
  }));
}

export type DecisionRow = {
  id: string;
  createdAt: string;
  agentKey: string;
  mode: string;
  configVersion: number;
  providerId: string | null;
  modelId: string | null;
  selectionSource: string | null;
  fallbackUsed: boolean;
  outcome: string;
  blockedReason: string | null;
  considered: { providerId: string; model: string; excluded: string | null }[];
  attempts: { model: string; providerId: string; ok: boolean; error: string | null }[];
  warnings: string[];
};

export async function listDecisions(filter: { providerId?: string; limit?: number } = {}): Promise<DecisionRow[]> {
  const supabase = await createClient();
  let query = supabase
    .schema('ai')
    .from('routing_decisions')
    .select('id, created_at, agent_key, mode, config_version, provider_id, model_id, selection_source, fallback_used, outcome, blocked_reason, plan, attempts')
    .order('created_at', { ascending: false })
    .limit(filter.limit ?? 30);
  if (filter.providerId) query = query.eq('provider_id', filter.providerId);
  const { data, error } = await query;
  if (error) unreadable('listDecisions', error);
  return (data ?? []).map((d) => {
    const plan = (d.plan ?? {}) as { considered?: DecisionRow['considered']; warnings?: string[] };
    return {
      id: d.id,
      createdAt: d.created_at,
      agentKey: d.agent_key,
      mode: d.mode,
      configVersion: d.config_version,
      providerId: d.provider_id,
      modelId: d.model_id,
      selectionSource: d.selection_source,
      fallbackUsed: d.fallback_used,
      outcome: d.outcome,
      blockedReason: d.blocked_reason,
      considered: plan.considered ?? [],
      attempts: Array.isArray(d.attempts) ? (d.attempts as DecisionRow['attempts']) : [],
      warnings: plan.warnings ?? [],
    };
  });
}

export type AuditEntry = { at: string; action: string; actor: string | null; detail: string };

/** The provider's own audit trail: provider, key and model changes, each recorded by its door. */
export async function listProviderAudit(providerId: string, modelIds: readonly string[] = []): Promise<AuditEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('audit')
    .from('audit_log')
    .select('created_at, action, actor_id, before, after')
    .or('action.like.ai_provider%,action.like.ai_model%,action.like.ai_routing%')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) unreadable('listProviderAudit', error);
  const names = [providerId, ...modelIds];
  const mentions = (value: unknown) => {
    const json = JSON.stringify(value ?? {});
    return names.some((n) => json.includes(`"${n}"`));
  };
  return (data ?? [])
    .filter((r) => mentions(r.after) || mentions(r.before))
    .slice(0, 50)
    .map((r) => ({ at: r.created_at, action: r.action, actor: r.actor_id, detail: summarise(r.before, r.after) }));
}

function summarise(before: unknown, after: unknown): string {
  const pick = (v: unknown) => {
    const o = (v ?? {}) as Record<string, unknown>;
    // Labels, hints and flags only: the doors never put a secret in an audit row, and this does not go looking for one.
    return ['label', 'enabled', 'priority', 'display_name', 'base_url', 'reason', 'model_id', 'model', 'mode', 'agent', 'added', 'gone'].filter((k) => o[k] !== undefined).map((k) => `${k}=${String(o[k])}`).join(' ');
  };
  const b = pick(before);
  const a = pick(after);
  return b && a ? `${b} → ${a}` : a || b || '';
}

export type UsageByModel = { modelId: string; runs: number; failed: number; inputTokens: number; outputTokens: number; costMinor: number; pricedRuns: number };
export type ProviderUsage = {
  since: string;
  runs: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  /** Only what an Admin-recorded price produced - never an estimate. */
  costMinor: number;
  /** Runs whose model had no price, so their cost is unknown rather than zero. */
  unpricedRuns: number;
  byModel: UsageByModel[];
  capMinor: number | null;
  spentAgainstCapMinor: number | null;
  fallbackServed: number;
};

/** This calendar month's usage of one provider, from the runs that recorded it as the provider that actually served them. */
export async function readProviderUsage(providerId: string, now = new Date()): Promise<ProviderUsage> {
  const supabase = await createClient();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [runs, budget, fallbacks] = await Promise.all([
    supabase.schema('ai').from('agent_runs').select('model, status, input_tokens, output_tokens, cost_minor').eq('provider_id', providerId).gte('created_at', since).limit(5000),
    supabase.schema('ai').from('provider_budget_status').select('monthly_cap_minor, spent_minor').eq('provider', providerId).maybeSingle(),
    supabase.schema('ai').from('routing_decisions').select('id', { count: 'exact', head: true }).eq('provider_id', providerId).eq('fallback_used', true).gte('created_at', since),
  ]);
  if (runs.error) unreadable('readProviderUsage.runs', runs.error);
  if (budget.error) unreadable('readProviderUsage.budget', budget.error);
  if (fallbacks.error) unreadable('readProviderUsage.fallbacks', fallbacks.error);

  const byModel = new Map<string, UsageByModel>();
  const usage: ProviderUsage = { since, runs: 0, failed: 0, inputTokens: 0, outputTokens: 0, costMinor: 0, unpricedRuns: 0, byModel: [], capMinor: budget.data?.monthly_cap_minor === null || budget.data?.monthly_cap_minor === undefined ? null : Number(budget.data.monthly_cap_minor), spentAgainstCapMinor: budget.data?.spent_minor === null || budget.data?.spent_minor === undefined ? null : Number(budget.data.spent_minor), fallbackServed: fallbacks.count ?? 0 };
  for (const r of runs.data ?? []) {
    const model = r.model ?? 'unknown';
    const m = byModel.get(model) ?? { modelId: model, runs: 0, failed: 0, inputTokens: 0, outputTokens: 0, costMinor: 0, pricedRuns: 0 };
    const failed = r.status === 'failed' || r.status === 'budget_exceeded';
    const cost = Number(r.cost_minor ?? 0);
    m.runs += 1;
    m.failed += failed ? 1 : 0;
    m.inputTokens += Number(r.input_tokens ?? 0);
    m.outputTokens += Number(r.output_tokens ?? 0);
    m.costMinor += cost;
    m.pricedRuns += cost > 0 ? 1 : 0;
    byModel.set(model, m);
    usage.runs += 1;
    usage.failed += failed ? 1 : 0;
    usage.inputTokens += Number(r.input_tokens ?? 0);
    usage.outputTokens += Number(r.output_tokens ?? 0);
    usage.costMinor += cost;
    usage.unpricedRuns += cost > 0 ? 0 : 1;
  }
  usage.byModel = [...byModel.values()].sort((a, b) => b.runs - a.runs);
  return usage;
}
