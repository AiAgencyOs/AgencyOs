import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { firstRow, userRpc } from '@/lib/db/p1o-rpc';
import { err, ok, type Result } from '@/lib/result';

import { policyFromRow, type SchedulingPolicy } from './p1o-policy';

/**
 * The organisation's scheduling policy, for the booking path (booking.ts). It used to run on constants ("no policy rows yet"); it now reads what an administrator
 * saved through `crm.p1o_set_scheduling_policy`, and an organisation that saved nothing gets exactly the old values. A failed read is an error to the caller, never
 * a quiet fall back to the defaults: offering times under rules the owner changed is the false success this path exists to avoid.
 */
export async function currentSchedulingPolicy(): Promise<Result<SchedulingPolicy>> {
  const context = await requireInternal();
  if (!context.organizationId) return err('FORBIDDEN', 'No organisation is selected.');
  const rpc = await userRpc('crm');
  const { data, error } = await rpc('p1o_scheduling_policy_for', { p_organization_id: context.organizationId });
  if (error) return err('INTERNAL', `The scheduling policy could not be read: ${error.message}. Nothing was offered or booked.`);
  return ok(policyFromRow(firstRow(data)));
}

/** The two numbers booking.ts calls CONSTRAINTS, from the policy. */
export function constraintsOf(policy: SchedulingPolicy): { minimumNoticeMinutes: number; bufferMinutes: number } {
  return { minimumNoticeMinutes: policy.minNoticeMinutes, bufferMinutes: policy.bufferMinutes };
}

/** A saved policy limits the durations offered; with none saved any sensible duration stands, as before. */
export function durationAllowed(policy: SchedulingPolicy, minutes: number): boolean {
  return !policy.configured || policy.durations.includes(minutes);
}
