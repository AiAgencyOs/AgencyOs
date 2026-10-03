import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { ProjectLinkKind } from './project-links-schema';

/** SCR-019 — the project's links, oldest first, grouped by kind on the page. */
export type ProjectLink = { id: string; label: string; url: string; kind: ProjectLinkKind; createdAt: string };

export async function listProjectLinks(projectId: string): Promise<ProjectLink[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('project_links')
    .select('id, label, url, kind, created_at')
    .eq('project_id', projectId)
    .order('kind', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) unreadable('listProjectLinks', error);
  return (data ?? []).map((l) => ({ id: l.id, label: l.label, url: l.url, kind: l.kind as ProjectLinkKind, createdAt: l.created_at }));
}
