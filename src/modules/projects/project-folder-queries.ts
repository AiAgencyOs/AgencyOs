import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/** The project's folder records, every category — empty folders included. */
export async function listProjectFolders(projectId: string): Promise<{ id: string; category: string; path: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('project_folders').select('id, category, path').eq('project_id', projectId).order('path', { ascending: true });
  if (error) unreadable('listProjectFolders', error);
  return data ?? [];
}
