import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  setAgentProjectAssignmentSchema,
  setAgentToolPermissionSchema,
  type SetAgentProjectAssignmentInput,
  type SetAgentToolPermissionInput,
} from './permissions-schema';

/**
 * Owner only. `hasRole(context, 'owner')` plus `organization.settings`: the
 * owner is the one role holding every capability, and ADM-82 puts agent
 * activation with the owner; a tool grant is the same kind of decision.
 * The database asks again through RLS (`core.is_owner()`, security invoker).
 */
async function requireOwner(verb: string): Promise<Result<true>> {
  const context = await requireInternal();
  if (!hasRole(context, 'owner') || !can(context, 'organization.settings')) {
    return err('FORBIDDEN', `Only the owner may ${verb}.`);
  }
  return ok(true);
}

export async function setAgentToolPermission(input: SetAgentToolPermissionInput): Promise<Result<{ allowed: boolean }>> {
  const parsed = setAgentToolPermissionSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid tool permission.');

  const gate = await requireOwner('change an agent’s tool permissions');
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').rpc('set_agent_tool_permission', {
    p_agent_key: parsed.data.agentKey,
    p_tool_key: parsed.data.toolKey,
    p_allowed: parsed.data.allowed,
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setAgentToolPermission', detail: error.message }));
    return err('INTERNAL', 'Could not record the tool permission.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ allowed: parsed.data.allowed });
    case 'not_found':
      return err('NOT_FOUND', 'Agent not found in the registry.');
    case 'bad_tool':
      return err('VALIDATION', 'Not a tool key.');
    default:
      return err('FORBIDDEN', 'Only the owner may change an agent’s tool permissions.');
  }
}

export async function setAgentProjectAssignment(
  input: SetAgentProjectAssignmentInput,
): Promise<Result<{ active: boolean }>> {
  const parsed = setAgentProjectAssignmentSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid assignment.');

  const gate = await requireOwner('assign an agent to a project');
  if (!gate.ok) return gate;

  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').rpc('set_agent_project_assignment', {
    p_agent_key: parsed.data.agentKey,
    p_project_id: parsed.data.projectId,
    p_active: parsed.data.active,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setAgentProjectAssignment', detail: error.message }));
    return err('INTERNAL', 'Could not record the assignment.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ active: parsed.data.active });
    case 'not_found':
      return err('NOT_FOUND', 'Agent or project not found.');
    default:
      return err('FORBIDDEN', 'Only the owner may assign an agent to a project.');
  }
}
