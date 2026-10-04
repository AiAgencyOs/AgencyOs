import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The model registry and the vault's non-secret face — SCR-064.
 *
 * `ai.models` ships empty by design (ADM-84 deferred the second provider);
 * the page says so rather than inventing rows. `ai.provider_credentials` is
 * read for `provider`, `updated_at` and `updated_by` ONLY — the three
 * ciphertext columns are never selected, so nothing here can print a key
 * even by accident. RLS (`provider_credentials_admin_rw`, core.is_admin())
 * refuses a non-admin before the select runs.
 */

export type ModelRow = {
  modelId: string;
  provider: string;
  status: string;
  capabilities: string[];
  contextTokens: number | null;
  inputCostMinorPerMtok: number | null;
  outputCostMinorPerMtok: number | null;
  updatedAt: string;
};

export async function listModels(): Promise<ModelRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('models')
    .select('model_id, provider, status, capabilities, context_tokens, input_cost_minor_per_mtok, output_cost_minor_per_mtok, updated_at')
    .order('provider', { ascending: true })
    .order('model_id', { ascending: true })
    .limit(500);

  if (error) unreadable('listModels', error);

  return (data ?? []).map((m) => ({
    modelId: m.model_id,
    provider: m.provider,
    status: m.status,
    capabilities: m.capabilities ?? [],
    contextTokens: m.context_tokens,
    inputCostMinorPerMtok: m.input_cost_minor_per_mtok,
    outputCostMinorPerMtok: m.output_cost_minor_per_mtok,
    updatedAt: m.updated_at,
  }));
}

export type VaultEntry = { provider: string; updatedAt: string; updatedByName: string };

/** Which providers hold a stored key, when it was last set and by whom. Never the key. (Read from the Provider Manager's key store.) */
export async function listVaultEntries(): Promise<VaultEntry[]> {
  const supabase = await createClient();

  const { data, error } = await supabase.schema('ai').rpc('provider_key_status', {});
  if (error) unreadable('listVaultEntries', error);

  // One entry per provider: the most recently set of its keys.
  const latest = new Map<string, { updatedAt: string; by: string }>();
  for (const k of data ?? []) {
    const at = k.rotated_at ?? k.created_at;
    if (!k.provider_id || !at) continue;
    const seen = latest.get(k.provider_id);
    if (!seen || at > seen.updatedAt) latest.set(k.provider_id, { updatedAt: at, by: k.created_by_name ?? 'recorded' });
  }
  return [...latest.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, v]) => ({ provider, updatedAt: v.updatedAt, updatedByName: v.by }));
}
