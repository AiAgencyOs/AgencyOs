import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

export type AgentPolicyRefusalRow = {
  id: string;
  kind: 'tool_denied' | 'tool_unrecorded' | 'project_unassigned';
  toolKey: string | null;
  projectId: string | null;
  projectName: string | null;
  runId: string | null;
  reason: string;
  createdAt: string;
};

/**
 * What the runner refused this agent under this tenant's policy — decision 3
 * of 2026-09-29, `ai.agent_policy_refusals`. Newest first, bounded: the page
 * shows the recent ones, and the audit log holds every one.
 */
export async function listAgentPolicyRefusals(agentKey: string, limit = 50): Promise<AgentPolicyRefusalRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('agent_policy_refusals')
    .select('id, kind, tool_key, project_id, run_id, reason, created_at')
    .eq('agent_key', agentKey)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listAgentPolicyRefusals', error);

  const rows = data ?? [];
  const projectIds = [...new Set(rows.map((r) => r.project_id).filter((id): id is string => id !== null))];
  const nameById = new Map<string, string>();
  if (projectIds.length > 0) {
    const { data: projects, error: projectsError } = await supabase
      .schema('projects')
      .from('projects')
      .select('id, name')
      .in('id', projectIds);
    if (projectsError) unreadable('listAgentPolicyRefusals.projects', projectsError);
    for (const p of projects ?? []) nameById.set(p.id, p.name);
  }

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as AgentPolicyRefusalRow['kind'],
    toolKey: r.tool_key,
    projectId: r.project_id,
    projectName: r.project_id ? (nameById.get(r.project_id) ?? null) : null,
    runId: r.run_id,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}
