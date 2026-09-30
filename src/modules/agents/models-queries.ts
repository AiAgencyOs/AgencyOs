import 'server-only';

import { WORK_CLASSES, type WorkClass } from '@/lib/ai/autonomy';
import { PROVIDER_IDS, type ProviderId } from '@/lib/ai/model-provider';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-064 — the fallback chains and provider budgets beside the model
 * registry (`listModels` in `@/lib/admin/model-registry`). Read-only; every
 * write is one of the four doors in `models-service.ts`. Both reads answer
 * every work class / every provider so the page shows a row for each, with
 * "none set" where the owner has set nothing rather than a shorter table.
 */

export type FallbackChainRow = {
  workClass: WorkClass;
  modelIds: string[];
  updatedAt: string | null;
};

export async function listFallbackChains(): Promise<FallbackChainRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').from('fallback_chains').select('work_class, model_ids, updated_at');
  if (error) unreadable('listFallbackChains', error);

  const byClass = new Map((data ?? []).map((r) => [r.work_class, r]));
  return WORK_CLASSES.map((workClass) => {
    const row = byClass.get(workClass);
    return { workClass, modelIds: row?.model_ids ?? [], updatedAt: row?.updated_at ?? null };
  });
}

export type ProviderBudgetRow = {
  provider: ProviderId;
  /** Null when the owner has set no cap. */
  monthlyCapMinor: number | null;
  /** What the provider has cost this calendar month — from the steps, never estimated. Null when no cap is set (not computed). */
  spentMinor: number | null;
  updatedAt: string | null;
};

export async function listProviderBudgets(): Promise<ProviderBudgetRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').from('provider_budget_status').select('provider, monthly_cap_minor, spent_minor, updated_at');
  if (error) unreadable('listProviderBudgets', error);

  const byProvider = new Map((data ?? []).map((r) => [r.provider, r]));
  return PROVIDER_IDS.map((provider) => {
    const row = byProvider.get(provider);
    return {
      provider,
      monthlyCapMinor: row?.monthly_cap_minor === null || row?.monthly_cap_minor === undefined ? null : Number(row.monthly_cap_minor),
      spentMinor: row?.spent_minor === null || row?.spent_minor === undefined ? null : Number(row.spent_minor),
      updatedAt: row?.updated_at ?? null,
    };
  });
}
