import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { bandsProblem, STARTING_BANDS, type BudgetBand } from './budget-bands';

export type BudgetBandSetting = { bands: BudgetBand[]; configured: boolean; updatedAt: string | null };

/** The organization's budget bands; nothing saved means the starting bands. */
export async function readBudgetBands(): Promise<BudgetBandSetting> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('budget_bands').select('bands, updated_at').maybeSingle();
  if (error) unreadable('readBudgetBands', error);
  const saved = Array.isArray(data?.bands)
    ? (data.bands as { label?: unknown; minMinor?: unknown }[]).flatMap((b) =>
        typeof b?.label === 'string' && typeof b?.minMinor === 'number' ? [{ label: b.label, minMinor: b.minMinor }] : [],
      )
    : [];
  if (!data || saved.length === 0 || bandsProblem(saved) !== null) return { bands: [...STARTING_BANDS], configured: false, updatedAt: null };
  return { bands: saved, configured: true, updatedAt: data.updated_at };
}
