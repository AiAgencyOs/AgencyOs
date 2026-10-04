import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

export type FigmaImportRow = { id: string; createdAt: string; fileKey: string | null; pageName: string | null; frameCount: number };

/** What the Figma plugin has reported for a project, newest first (a record of what was built - it links nothing by itself). */
export async function listFigmaImports(projectId: string): Promise<FigmaImportRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').from('figma_plugin_imports').select('id, created_at, file_key, page_name, frames').eq('project_id', projectId).order('created_at', { ascending: false }).limit(10);
  if (error) unreadable('listFigmaImports', error);
  return (data ?? []).map((r) => ({ id: r.id, createdAt: r.created_at, fileKey: r.file_key, pageName: r.page_name, frameCount: Array.isArray(r.frames) ? r.frames.length : 0 }));
}
