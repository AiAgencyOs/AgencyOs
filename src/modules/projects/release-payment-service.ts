import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { overrideReleasePaymentSchema, type OverrideReleasePaymentInput } from './release-payment-schema';

/**
 * The owner's override of the payment gate — decision F1 of 2026-09-30.
 * `organization.settings` is the capability only the owner holds;
 * `projects.override_release_payment` asks `core.is_owner()` again, refuses
 * when there is nothing to override (the payment is verified, or no priced
 * milestone exists) and audits `release.payment_overridden` with the reason.
 */
export async function overrideReleasePayment(input: OverrideReleasePaymentInput): Promise<Result<{ overrideId: string }>> {
  const parsed = overrideReleasePaymentSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid override.');

  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) return err('FORBIDDEN', 'Only the owner may override the payment gate.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('override_release_payment', {
    p_project_id: parsed.data.projectId,
    p_reason: parsed.data.reason,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'overrideReleasePayment', detail: error.message }));
    return err('INTERNAL', 'Could not record the override.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome: string; id: string | null } | undefined;
  switch (row?.outcome) {
    case 'overridden':
      return row.id ? ok({ overrideId: row.id }) : err('INTERNAL', 'Could not record the override.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: owner only.');
    case 'no_reason':
      return err('VALIDATION', 'A reason of at least ten characters is required.');
    case 'not_found':
      return err('NOT_FOUND', 'That project is not in this organization.');
    case 'nothing_to_override':
      return err('CONFLICT', 'The final payment is verified (or there is no priced milestone) — the gate is already open.');
    case 'already_overridden':
      return err('CONFLICT', 'An override is already recorded on this project.');
    default:
      return err('INTERNAL', `Could not record the override (${row?.outcome ?? 'no answer'}).`);
  }
}
