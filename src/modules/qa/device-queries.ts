import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { DeviceConfiguration } from './device-config';

/** SCR-044/048 — the devices the agency registered, supported or explicitly not. RLS scopes to the organization. */
export async function listDeviceConfigurations(): Promise<DeviceConfiguration[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('qa')
    .from('device_configurations')
    .select('id, name, platform, os, browser, status, reason, created_at')
    .order('name', { ascending: true })
    .limit(500);
  if (error) unreadable('listDeviceConfigurations', error);
  return (data ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform as DeviceConfiguration['platform'],
    os: d.os,
    browser: d.browser,
    status: d.status === 'unsupported' ? 'unsupported' : 'supported',
    reason: d.reason,
    createdAt: d.created_at,
  }));
}
