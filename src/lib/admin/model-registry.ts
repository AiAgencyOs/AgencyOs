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

/** Which providers hold a vault key, when it was last set and by whom. Never the key. */
export async function listVaultEntries(): Promise<VaultEntry[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('provider_credentials')
    .select('provider, updated_at, updated_by')
    .order('provider', { ascending: true });

  if (error) unreadable('listVaultEntries', error);

  const rows = data ?? [];
  const userIds = [...new Set(rows.map((r) => r.updated_by))];
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', userIds);
    if (usersError) unreadable('listVaultEntries.users', usersError);
    for (const u of users ?? []) names.set(u.id, u.full_name ?? u.email);
  }

  return rows.map((r) => ({
    provider: r.provider,
    updatedAt: r.updated_at,
    updatedByName: names.get(r.updated_by) ?? r.updated_by.slice(0, 8),
  }));
}
