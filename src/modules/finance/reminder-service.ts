import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { reminderPolicySchema, type ReminderPolicyInput } from './reminder-schema';

type PolicyRow = { outcome: 'enabled' | 'disabled' | 'forbidden' | 'not_found' | 'invalid_interval' };

/**
 * Settings › Finance › past-due reminders — owner decision 2026-09-29.
 *
 * `organization.settings` (owner, ops_admin), the same gate every other
 * switch on the settings screens uses; the database door
 * `core.set_invoice_reminder_policy` checks is_admin again and audits the
 * old and new values in its own transaction. Two real columns on
 * core.organizations, so the runner's sweep reads a boolean and a number
 * rather than parsing a setting.
 */
export async function setInvoiceReminderPolicy(
  input: ReminderPolicyInput,
): Promise<Result<{ enabled: boolean; intervalDays: number }>> {
  const parsed = reminderPolicySchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid reminder policy.');

  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to change organization settings.');
  }
  if (!context.organizationId) return err('INTERNAL', 'No organization in your session.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('set_invoice_reminder_policy', {
    p_organization_id: context.organizationId,
    p_enabled: parsed.data.enabled,
    p_interval_days: parsed.data.intervalDays,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setInvoiceReminderPolicy', detail: error.message }));
    return err('INTERNAL', 'Could not change the reminder policy.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as PolicyRow | undefined;
  if (!row) return err('INTERNAL', 'Could not change the reminder policy.');

  switch (row.outcome) {
    case 'enabled':
    case 'disabled':
      return ok({ enabled: row.outcome === 'enabled', intervalDays: parsed.data.intervalDays });
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner or ops admin may change this.');
    case 'invalid_interval':
      return err('VALIDATION', 'The interval must be between 1 and 90 days.');
    case 'not_found':
      return err('NOT_FOUND', 'Organization not found.');
    default:
      return err('INTERNAL', 'Could not change the reminder policy.');
  }
}
