import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-043 — the technical dependencies still open, across every project,
 * for the Development dashboard's blockers panel. The plan's own register
 * (`plan_dependencies`) is read by `blockers-queries.ts`; this is the other
 * register, the one a person can close from the Builds tab.
 */
export type OpenTechnicalDependency = {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  version: string | null;
  createdAt: string;
};

export async function listOpenTechnicalDependencies(): Promise<OpenTechnicalDependency[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('dependencies')
    .select('id, project_id, name, version, created_at')
    .eq('status', 'open')
    .order('created_at', { ascending: true });
  if (error) unreadable('listOpenTechnicalDependencies', error);

  type Row = { id: string; project_id: string; name: string; version: string | null; created_at: string };
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return [];

  const projectIds = [...new Set(rows.map((r) => r.project_id))];
  const { data: projects, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name')
    .in('id', projectIds)
    .is('deleted_at', null);
  if (projectsError) unreadable('listOpenTechnicalDependencies.projects', projectsError);
  const nameOf = new Map((projects ?? []).map((p) => [p.id, p.name]));

  return rows.flatMap((r) => {
    const projectName = nameOf.get(r.project_id);
    return projectName ? [{ id: r.id, projectId: r.project_id, projectName, name: r.name, version: r.version, createdAt: r.created_at }] : [];
  });
}
