import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { parseDeploymentDependencies, type DeploymentDependency } from './deployment-deps-schema';

export type { DeploymentDependency } from './deployment-deps-schema';

/** SCR-049 — the deployment dependencies on a project's newest handover, or null when there is no handover. */
export async function readDeploymentDependencies(projectId: string): Promise<{ handoverId: string; dependencies: DeploymentDependency[] } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('handovers')
    .select('id, deployment_dependencies')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) unreadable('readDeploymentDependencies', error);
  if (!data) return null;
  return { handoverId: data.id, dependencies: parseDeploymentDependencies(data.deployment_dependencies) };
}
