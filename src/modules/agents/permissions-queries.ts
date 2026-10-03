import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

export type AgentToolPermissionRow = {
  toolKey: string;
  allowed: boolean;
  note: string | null;
  updatedAt: string;
};

/** This tenant's recorded tool permissions for one agent — SCR-063. */
export async function listAgentToolPermissions(agentKey: string): Promise<AgentToolPermissionRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('agent_tool_permissions')
    .select('tool_key, allowed, note, updated_at')
    .eq('agent_key', agentKey)
    .order('tool_key');
  if (error) unreadable('listAgentToolPermissions', error);

  return (data ?? []).map((r) => ({ toolKey: r.tool_key, allowed: r.allowed, note: r.note, updatedAt: r.updated_at }));
}

export type AgentProjectAssignmentRow = {
  projectId: string;
  projectName: string;
  projectCode: string;
  active: boolean;
  updatedAt: string;
};

/** Every project this agent has been assigned to, withdrawn ones included and marked — SCR-063. */
export async function listAgentProjectAssignments(agentKey: string): Promise<AgentProjectAssignmentRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('agent_project_assignments')
    .select('project_id, active, updated_at')
    .eq('agent_key', agentKey)
    .order('updated_at', { ascending: false });
  if (error) unreadable('listAgentProjectAssignments', error);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const { data: projects, error: projectsError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name, code')
    .in('id', [...new Set(rows.map((r) => r.project_id))]);
  if (projectsError) unreadable('listAgentProjectAssignments.projects', projectsError);
  const byId = new Map((projects ?? []).map((p) => [p.id, p]));

  return rows.map((r) => ({
    projectId: r.project_id,
    projectName: byId.get(r.project_id)?.name ?? 'Unknown project',
    projectCode: byId.get(r.project_id)?.code ?? '',
    active: r.active,
    updatedAt: r.updated_at,
  }));
}

export type AssignedAgentRow = { agentKey: string; displayName: string; enabled: boolean };

/** The agents assigned to one project, active only — the project overview's card. */
export async function listAssignedAgents(projectId: string): Promise<AssignedAgentRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('agent_project_assignments')
    .select('agent_key')
    .eq('project_id', projectId)
    .eq('active', true)
    .order('agent_key');
  if (error) unreadable('listAssignedAgents', error);

  const keys = (data ?? []).map((r) => r.agent_key);
  if (keys.length === 0) return [];

  const { data: agents, error: agentsError } = await supabase
    .schema('ai')
    .from('agents')
    .select('key, display_name, enabled')
    .in('key', keys);
  if (agentsError) unreadable('listAssignedAgents.agents', agentsError);
  const byKey = new Map((agents ?? []).map((a) => [a.key, a]));

  return keys.map((k) => ({ agentKey: k, displayName: byKey.get(k)?.display_name ?? k, enabled: byKey.get(k)?.enabled ?? false }));
}
