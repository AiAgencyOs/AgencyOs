import 'server-only';

import { isValidTimeZone } from '@/lib/admin/timezone';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

/**
 * The owner-operable half of settings: the two organization-level configuration
 * writes an owner should be able to make without SQL — the agency timezone
 * (G-137, which gates all follow-up sending) and the reactivation pilot switch
 * (G-140/ADM-87, off by default).
 *
 * Both go through the same discipline the requeue write established: check the
 * capability HERE, but never rely on that check alone — the database has the
 * final word. The timezone update runs under `organizations_update` RLS (owner
 * only) and the IANA CHECK; the pilot toggle runs through
 * `core.set_reactivation_pilot`, which re-checks owner/ops_admin and audits.
 * `lib/` may not import `modules/` (ARCHITECTURE.md §3.2), and there is no
 * settings domain, so this platform-settings write lives here beside the reads.
 */

export async function setAgencyTimezone(timezone: string): Promise<Result<{ timezone: string }>> {
  const tz = timezone.trim();
  if (!isValidTimeZone(tz)) {
    return err('VALIDATION', `"${timezone}" is not a valid IANA timezone. Try one like "Asia/Kolkata".`);
  }

  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to change organization settings.');
  }
  if (!context.organizationId) return err('INTERNAL', 'No organization in your session.');

  const supabase = await createClient();
  const { error } = await supabase
    .schema('core')
    .from('organizations')
    .update({ timezone: tz })
    .eq('id', context.organizationId);

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setAgencyTimezone', detail: error.message }));
    return err('INTERNAL', 'Could not set the timezone. The database requires a valid IANA zone.');
  }
  return ok({ timezone: tz });
}

type PilotRow = { outcome: 'enabled' | 'disabled' | 'forbidden' | 'not_found' };

export async function setReactivationPilot(enabled: boolean): Promise<Result<{ enabled: boolean }>> {
  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to change organization settings.');
  }
  if (!context.organizationId) return err('INTERNAL', 'No organization in your session.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('set_reactivation_pilot', {
    p_organization_id: context.organizationId,
    p_enabled: enabled,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setReactivationPilot', detail: error.message }));
    return err('INTERNAL', 'Could not change the reactivation pilot.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as PilotRow | undefined;
  if (!row) return err('INTERNAL', 'Could not change the reactivation pilot.');
  if (row.outcome === 'forbidden') {
    return err('FORBIDDEN', 'The database refused: only an owner or ops-admin may change this.');
  }
  if (row.outcome === 'not_found') return err('NOT_FOUND', 'Organization not found.');
  return ok({ enabled: row.outcome === 'enabled' });
}
