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

/**
 * Rename the agency — the name every quotation PDF wears as its letterhead
 * (G-156, brief §12 "branded"). Found one step before the first real client:
 * the letterhead still said "Demo Agency" and nothing but SQL could change
 * it. Owner only — narrower than the timezone's owner-or-ops, because this
 * is the signature on money documents — audited as organization.renamed,
 * and the column guard refuses any other authenticated write (G-160).
 */
export async function setOrganizationName(name: string): Promise<Result<{ name: string }>> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 120) {
    return err('VALIDATION', 'The agency needs a name between 1 and 120 characters.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'Only an owner may rename the agency.');
  }
  if (!context.organizationId) return err('INTERNAL', 'No organization in your session.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('core')
    .rpc('set_organization_name', { p_organization_id: context.organizationId, p_name: trimmed });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setOrganizationName', detail: error.message }));
    return err('INTERNAL', 'Could not rename the agency.');
  }

  const outcome = (Array.isArray(data) ? data[0]?.outcome : undefined) as string | undefined;
  switch (outcome) {
    case 'set':
      return ok({ name: trimmed });
    case 'forbidden':
      return err('FORBIDDEN', 'Only an owner may rename the agency.');
    case 'invalid':
      return err('VALIDATION', 'The agency needs a name between 1 and 120 characters.');
    default:
      return err('INTERNAL', 'Could not rename the agency.');
  }
}

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
  // Through the audited setter, not a direct UPDATE: it re-checks authority in
  // the database, validates against pg_timezone_names (so UTC is accepted), and
  // writes an audit row — a guard now refuses any other authenticated write of
  // the column, so the trail cannot be sidestepped.
  const { data, error } = await supabase
    .schema('core')
    .rpc('set_agency_timezone', { p_organization_id: context.organizationId, p_timezone: tz });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setAgencyTimezone', detail: error.message }));
    return err('INTERNAL', 'Could not set the timezone.');
  }

  const outcome = (Array.isArray(data) ? data[0]?.outcome : undefined) as string | undefined;
  switch (outcome) {
    case 'set':
      return ok({ timezone: tz });
    case 'forbidden':
      return err('FORBIDDEN', 'You do not have permission to change organization settings.');
    case 'not_found':
      return err('INTERNAL', 'No organization in your session.');
    case 'invalid':
      return err('VALIDATION', `"${timezone}" is not a timezone the database recognises. Try one like "Asia/Kolkata".`);
    default:
      return err('INTERNAL', 'Could not set the timezone.');
  }
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

/** The non-secret operational keys the product may set (never a token or key). */
export type OrganizationSettingKey = 'whatsapp_phone_number_id' | 'whatsapp_test_recipient';

const SETTING_HINT: Record<OrganizationSettingKey, string> = {
  whatsapp_phone_number_id: 'a numeric WhatsApp phone_number_id (digits only)',
  whatsapp_test_recipient: 'a WhatsApp number in digits, optionally with a leading +',
};

type SettingRow = {
  outcome: 'set' | 'cleared' | 'forbidden' | 'not_found' | 'invalid_key' | 'invalid_value';
};

/**
 * Sets or clears one whitelisted, NON-SECRET operational setting. An empty value
 * clears it. The database is the final word — it re-checks authority, refuses any
 * key outside the whitelist (so no secret can be smuggled in), validates the
 * shape, and audits. A guard refuses any other authenticated write of these keys.
 */
export async function setOrganizationSetting(
  key: OrganizationSettingKey,
  value: string,
): Promise<Result<{ key: OrganizationSettingKey; cleared: boolean }>> {
  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to change organization settings.');
  }
  if (!context.organizationId) return err('INTERNAL', 'No organization in your session.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('set_organization_setting', {
    p_organization_id: context.organizationId,
    p_key: key,
    p_value: value.trim(),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setOrganizationSetting', detail: error.message }));
    return err('INTERNAL', 'Could not save the setting.');
  }
  const outcome = (Array.isArray(data) ? (data[0] as SettingRow | undefined)?.outcome : undefined);
  switch (outcome) {
    case 'set':
      return ok({ key, cleared: false });
    case 'cleared':
      return ok({ key, cleared: true });
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner or ops-admin may change this.');
    case 'not_found':
      return err('NOT_FOUND', 'Organization not found.');
    case 'invalid_key':
      return err('VALIDATION', 'That setting cannot be changed here.');
    case 'invalid_value':
      return err('VALIDATION', `That value is not valid — expected ${SETTING_HINT[key]}.`);
    default:
      return err('INTERNAL', 'Could not save the setting.');
  }
}
