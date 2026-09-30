import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { addDeviceSchema, setDeviceSupportSchema, type AddDeviceInput, type SetDeviceSupportInput } from './device-config';

/**
 * SCR-044 "Add Device" and SCR-048 "unsupported devices must be recorded" —
 * `qa.add_device_configuration` and `qa.set_device_support`. `project.write`
 * (owner, ops admin, delivery lead), the roles `core.can_manage_delivery()`
 * admits; the database asks again and audits.
 */

type OutcomeRow = { outcome?: string; id?: string | null };
const first = (data: unknown) => (Array.isArray(data) ? data[0] : data) as OutcomeRow | undefined;

function refused(outcome: string | undefined): Result<never> {
  switch (outcome) {
    case 'reason_required':
      return err('VALIDATION', 'An unsupported configuration must say why.');
    case 'already_recorded':
      return err('CONFLICT', 'That device and configuration is already recorded.');
    case 'bad_name':
      return err('VALIDATION', 'A device name is 1 to 120 characters.');
    case 'bad_platform':
      return err('VALIDATION', 'That is not a platform this register knows.');
    case 'not_found':
      return err('NOT_FOUND', 'That device is not in the register.');
    default:
      return err('FORBIDDEN', 'The database refused: your role may not manage devices.');
  }
}

export async function addDevice(input: AddDeviceInput): Promise<Result<{ deviceId: string }>> {
  const parsed = addDeviceSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid device.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to add a device.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('add_device_configuration', {
    p_name: parsed.data.name,
    p_platform: parsed.data.platform,
    p_status: parsed.data.status,
    ...(parsed.data.os ? { p_os: parsed.data.os } : {}),
    ...(parsed.data.browser ? { p_browser: parsed.data.browser } : {}),
    ...(parsed.data.reason ? { p_reason: parsed.data.reason } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'addDevice', detail: error.message }));
    return err('INTERNAL', 'Could not add the device.');
  }
  const row = first(data);
  if (row?.outcome === 'added' && row.id) return ok({ deviceId: row.id });
  return refused(row?.outcome);
}

export async function setDeviceSupport(input: SetDeviceSupportInput): Promise<Result<{ status: 'supported' | 'unsupported' }>> {
  const parsed = setDeviceSupportSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid change.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change device support.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('set_device_support', {
    p_device_id: parsed.data.deviceId,
    p_status: parsed.data.status,
    ...(parsed.data.reason ? { p_reason: parsed.data.reason } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setDeviceSupport', detail: error.message }));
    return err('INTERNAL', 'Could not change device support.');
  }
  const row = first(data);
  if (row?.outcome === 'set') return ok({ status: parsed.data.status });
  return refused(row?.outcome);
}
