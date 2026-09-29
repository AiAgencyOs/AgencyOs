import type { createAdminClient } from '@/lib/db/admin';

import { decideProjectAction, decideToolCall, projectIdOf, type PolicyVerdict } from './policy-decision';

/**
 * The runner's side of decision 3 (2026-09-29): loading this tenant's policy
 * rows with the service-role client, asking `policy-decision.ts`, and
 * recording what was refused.
 *
 * Service role, so the tenant is a PARAMETER on every read and write here —
 * RLS does not see this client, and a loader that forgot the organisation
 * would read another tenant's permissions as this one's.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type AgentPolicy = {
  organizationId: string;
  agentKey: string;
  /** tool_key → allowed, for every row the tenant recorded. Absent = unrecorded. */
  permissions: ReadonlyMap<string, boolean>;
  /** Every project the agent is ACTIVELY assigned to. Empty = all projects. */
  assignedProjectIds: readonly string[];
};

/**
 * A refusal the runner raises where it cannot return a `Result` — `openRun`
 * is called by every workflow and returns a run id, so a project the agent
 * may not work on has to stop the workflow by throwing. `route.ts` catches
 * exactly this class, settles the job, and reports it.
 */
export class AgentPolicyRefusal extends Error {
  readonly kind: Exclude<PolicyVerdict, { allowed: true }>['kind'];
  readonly agentKey: string;
  readonly runId: string | null;

  constructor(args: { kind: Exclude<PolicyVerdict, { allowed: true }>['kind']; agentKey: string; reason: string; runId: string | null }) {
    super(args.reason);
    this.name = 'AgentPolicyRefusal';
    this.kind = args.kind;
    this.agentKey = args.agentKey;
    this.runId = args.runId;
  }
}

/** Both policy tables for one agent in one tenant, read once per decision. */
export async function loadAgentPolicy(admin: Admin, organizationId: string, agentKey: string): Promise<AgentPolicy> {
  const [permissions, assignments] = await Promise.all([
    admin
      .schema('ai')
      .from('agent_tool_permissions')
      .select('tool_key, allowed')
      .eq('organization_id', organizationId)
      .eq('agent_key', agentKey),
    admin
      .schema('ai')
      .from('agent_project_assignments')
      .select('project_id')
      .eq('organization_id', organizationId)
      .eq('agent_key', agentKey)
      .eq('active', true),
  ]);

  // A policy that cannot be read is not "no policy": an unreadable table
  // fails closed, exactly as an unrecorded tool does.
  if (permissions.error) throw new Error(`agent policy could not be read: ${permissions.error.message}`);
  if (assignments.error) throw new Error(`agent assignments could not be read: ${assignments.error.message}`);

  return {
    organizationId,
    agentKey,
    permissions: new Map((permissions.data ?? []).map((r) => [r.tool_key, r.allowed])),
    assignedProjectIds: (assignments.data ?? []).map((r) => r.project_id),
  };
}

/**
 * The refusal row and its audit entry, in one transaction
 * (`ai.record_agent_policy_refusal`). A failure to record is logged and
 * never fatal: the refusal itself has already happened, and a call that was
 * stopped must stay stopped whether or not the record landed.
 */
export async function recordAgentPolicyRefusal(
  admin: Admin,
  args: {
    organizationId: string;
    agentKey: string;
    kind: Exclude<PolicyVerdict, { allowed: true }>['kind'];
    reason: string;
    runId: string | null;
    toolKey?: string | null;
    projectId?: string | null;
  },
): Promise<void> {
  const { error } = await admin.schema('ai').rpc('record_agent_policy_refusal', {
    p_organization_id: args.organizationId,
    p_agent_key: args.agentKey,
    p_kind: args.kind,
    p_reason: args.reason,
    ...(args.runId ? { p_run_id: args.runId } : {}),
    ...(args.toolKey ? { p_tool_key: args.toolKey } : {}),
    ...(args.projectId ? { p_project_id: args.projectId } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordAgentPolicyRefusal', detail: error.message }));
  }
}

/**
 * The tool half, decided and recorded. Both the permission row and — when
 * the call names a project — the assignment are asked, in that order: a
 * tool the owner denied is refused as denied even when the project would
 * also have been out of scope.
 */
export async function refuseToolCallIfUnpermitted(
  admin: Admin,
  policy: AgentPolicy,
  call: { toolKey: string; input: unknown; runId: string | null },
): Promise<PolicyVerdict> {
  const permission = policy.permissions.has(call.toolKey) ? { allowed: policy.permissions.get(call.toolKey) === true } : null;
  const toolVerdict = decideToolCall({ agentKey: policy.agentKey, toolKey: call.toolKey, permission });
  if (!toolVerdict.allowed) {
    await recordAgentPolicyRefusal(admin, {
      organizationId: policy.organizationId,
      agentKey: policy.agentKey,
      kind: toolVerdict.kind,
      reason: toolVerdict.reason,
      runId: call.runId,
      toolKey: call.toolKey,
    });
    return toolVerdict;
  }

  const projectId = projectIdOf(call.input);
  if (projectId) {
    const projectVerdict = decideProjectAction({ agentKey: policy.agentKey, projectId, assignedProjectIds: policy.assignedProjectIds });
    if (!projectVerdict.allowed) {
      await recordAgentPolicyRefusal(admin, {
        organizationId: policy.organizationId,
        agentKey: policy.agentKey,
        kind: projectVerdict.kind,
        reason: projectVerdict.reason,
        runId: call.runId,
        toolKey: call.toolKey,
        projectId,
      });
      return projectVerdict;
    }
  }

  return { allowed: true };
}
