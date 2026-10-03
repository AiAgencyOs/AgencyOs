import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/** The caller's role on one project (`projects.project_members`), or null when they are not on its roster. */
export async function readMyProjectRole(projectId: string, userId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('project_members')
    .select('project_role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) unreadable('readMyProjectRole', error);
  return data?.project_role ?? null;
}
