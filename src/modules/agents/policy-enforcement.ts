import 'server-only';

import { loadAgentPolicy, refuseToolCallIfUnpermitted, type AgentPolicy } from '@/lib/ai/agent-policy';
import { projectIdOf } from '@/lib/ai/policy-decision';
import type { createAdminClient } from '@/lib/db/admin';
import { err, type Result } from '@/lib/result';

import { writeDispatchDenial } from '@/modules/orchestrator/orchestrator-service';
import type { DispatchDenial, DispatchDenialCode } from '@/modules/orchestrator/tool-dispatch';

import { definitionFor } from './registry';
import { dispatchTool } from './tool-dispatch';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * A refused call is written to the audit log (`projects.record_tool_dispatch_denial`) under the Orchestrator's own denial codes
 * (`checkToolDispatch`'s vocabulary, so one set of words describes every refusal): argument NAMES only, never values, because a refused call may
 * carry exactly the secret that was the reason. Only a call that names a project can be audited there (the door is project-scoped); a call that
 * names none is still recorded by the policy refusal row. Best effort: this never changes the answer the caller gets and never throws.
 */
async function auditDenial(
  admin: Admin,
  args: { agentKey: string; toolName: string; input: unknown },
  code: DispatchDenialCode,
  reason: string,
): Promise<void> {
  try {
    const projectId = projectIdOf(args.input);
    if (!projectId) return;
    const argKeys = args.input !== null && typeof args.input === 'object' && !Array.isArray(args.input) ? Object.keys(args.input as Record<string, unknown>).slice(0, 30) : [];
    const denial: DispatchDenial = {
      allowed: false,
      code,
      reason,
      agent: args.agentKey,
      tool: args.toolName,
      audit: { p_project_id: projectId, p_agent_key: args.agentKey, p_tool: args.toolName, p_code: code, p_detail: reason.slice(0, 300), p_arg_keys: argKeys },
    };
    const answer = await writeDispatchDenial(admin, denial);
    if (!answer.ok || answer.outcome !== 'recorded') {
      console.error(JSON.stringify({ level: 'error', scope: 'auditDenial', agent: args.agentKey, tool: args.toolName, detail: answer.ok ? `the door answered ${answer.outcome}` : answer.detail }));
    }
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'auditDenial', agent: args.agentKey, tool: args.toolName, detail: e instanceof Error ? e.message : 'unknown' }));
  }
}

/**
 * `dispatchTool`, held to this tenant's policy — decision 3 of 2026-09-29.
 *
 * `tool-dispatch.ts` decides from the agent's DEFINITION (`resolveTool`) and
 * from ADM-99's allowlist; neither knows what the owner of THIS tenant
 * recorded in `ai.agent_tool_permissions`. This wrapper asks that first, and
 * only a call the policy allows reaches `dispatchTool` at all. The order is
 * the one every other gate in the runner keeps: the narrowest, most recently
 * decided rule runs first, and a refusal here never re-loosens the boundary
 * beneath it.
 *
 * Every workflow that offers the model a tool calls THIS, not `dispatchTool`
 * — `tests/an-agent-is-held-to-its-permissions.test.ts` pins that the runner
 * source names no direct `dispatchTool(` call.
 */
export async function dispatchToolUnderPolicy(args: {
  admin: Admin;
  organizationId: string;
  agentKey: string;
  agentAutonomy: 'L0' | 'L1' | 'L2';
  toolName: string;
  input: unknown;
  runId: string | null;
  /** Loaded once per run by the caller, or here on first use. */
  policy?: AgentPolicy;
}): Promise<Result<string>> {
  const policy = args.policy ?? (await loadAgentPolicy(args.admin, args.organizationId, args.agentKey));

  const verdict = await refuseToolCallIfUnpermitted(args.admin, policy, {
    toolKey: args.toolName,
    input: args.input,
    runId: args.runId,
  });
  if (!verdict.allowed) {
    // an owner's tool permission is "this agent does not hold the tool"; an unassigned project is a call outside the scope it was given
    await auditDenial(args.admin, args, verdict.kind === 'project_unassigned' ? 'out_of_scope' : 'tool_not_bound', verdict.reason);
    return err('FORBIDDEN', verdict.reason);
  }

  const result = await dispatchTool({
    admin: args.admin,
    organizationId: args.organizationId,
    agentKey: args.agentKey,
    agentAutonomy: args.agentAutonomy,
    toolName: args.toolName,
    input: args.input,
  });
  // A refusal by the boundary or by ADM-99's allowlist (FORBIDDEN) or an argument that does not fit the tool (VALIDATION) is a denial; a failed read is not.
  if (!result.ok && result.error.code === 'FORBIDDEN') {
    await auditDenial(args.admin, args, definitionFor(args.agentKey) ? 'tool_not_bound' : 'unknown_agent', result.error.message);
  } else if (!result.ok && result.error.code === 'VALIDATION') {
    await auditDenial(args.admin, args, 'invalid_args', result.error.message);
  }
  return result;
}
