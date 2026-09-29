import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { setMemberCostRateSchema, type SetMemberCostRateInput } from './cost-rate-schema';

type DoorRow = { outcome: string; rate_id: string | null };

/**
 * A person's cost rate — decision E2 of 2026-09-30.
 *
 * `organization.settings` is the capability only the owner holds, the same
 * check `grantSecondaryRole` makes for the roster's other owner-only door;
 * `core.set_member_cost_rate` asks `core.is_owner()` again and the insert
 * policy a third time. The door appends a row and audits `cost_rate.set`
 * with the rate that was in force on that date as before — nothing here
 * edits or deletes a rate, because the table allows neither.
 */
export async function setMemberCostRate(input: SetMemberCostRateInput): Promise<Result<{ rateId: string }>> {
  const parsed = setMemberCostRateSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid cost rate.');

  const context = await requireInternal();
  if (!can(context, 'organization.settings')) {
    return err('FORBIDDEN', 'Only an owner may set a cost rate.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('set_member_cost_rate', {
    p_user_id: parsed.data.userId,
    p_hourly_cost_minor: parsed.data.hourlyCostMinor,
    p_effective_from: parsed.data.effectiveFrom,
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setMemberCostRate', detail: error.message }));
    return err('INTERNAL', 'Could not set the cost rate.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as DoorRow | undefined;
  if (!row) return err('INTERNAL', 'Could not set the cost rate.');

  switch (row.outcome) {
    case 'set':
      if (!row.rate_id) return err('INTERNAL', 'Could not set the cost rate.');
      return ok({ rateId: row.rate_id });
    case 'not_authorized':
      return err('FORBIDDEN', 'Only an owner may set a cost rate.');
    case 'not_a_member':
      return err('NOT_FOUND', 'That person is not an active member of this organization.');
    case 'bad_rate':
      return err('VALIDATION', 'The rate must be more than zero.');
    case 'bad_date':
      return err('VALIDATION', 'Say the date the rate applies from.');
    case 'no_actor':
      return err('UNAUTHORIZED', 'No signed-in person to record this against.');
    default:
      console.error(JSON.stringify({ level: 'error', scope: 'setMemberCostRate', detail: `unrecognised outcome "${row.outcome}"` }));
      return err('INTERNAL', 'Could not set the cost rate.');
  }
}
