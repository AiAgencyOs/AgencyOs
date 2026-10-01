import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { parseBandLines } from './budget-bands';
import { setBudgetBandsSchema, type SetBudgetBandsInput } from './budget-bands-schema';

/** `crm.set_budget_bands` (owner / ops admin, audited). Blank text clears the setting. */
export async function setBudgetBands(input: SetBudgetBandsInput): Promise<Result<{ outcome: 'set' | 'cleared'; bands: number }>> {
  const parsed = setBudgetBandsSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid budget bands.');
  const { bands, problem } = parseBandLines(parsed.data.bandText);
  if (problem) return err('VALIDATION', problem);

  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'You do not have permission to change the budget bands.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('set_budget_bands', { p_bands: bands });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setBudgetBands', detail: error.message }));
    return err('INTERNAL', 'Could not save the budget bands.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ outcome: 'set', bands: bands.length });
    case 'cleared':
      return ok({ outcome: 'cleared', bands: 0 });
    case 'invalid_bands':
      return err('VALIDATION', 'The database refused those bands: the first must start at 0 and each must start higher than the one before.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner or ops admin may change the budget bands.');
    default:
      return err('INTERNAL', 'Could not save the budget bands.');
  }
}
