import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { departmentOf, type Department } from './member-department-schema';

/** The department of each given person (null = not set), in one read. */
export async function readDepartments(userIds: readonly string[]): Promise<Record<string, Department | null>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return {};
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('memberships').select('user_id, department').in('user_id', ids);
  if (error) unreadable('readDepartments', error);
  const out: Record<string, Department | null> = {};
  for (const id of ids) out[id] = null;
  for (const m of data ?? []) out[m.user_id] = departmentOf(m.department) ?? out[m.user_id] ?? null;
  return out;
}
