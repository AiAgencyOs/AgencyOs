import 'server-only';

import { loadAgentPolicy, refuseToolCallIfUnpermitted, type AgentPolicy } from '@/lib/ai/agent-policy';
import type { createAdminClient } from '@/lib/db/admin';
import { err, type Result } from '@/lib/result';

import { dispatchTool } from './tool-dispatch';

type Admin = ReturnType<typeof createAdminClient>;

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
  if (!verdict.allowed) return err('FORBIDDEN', verdict.reason);

  return dispatchTool({
    admin: args.admin,
    organizationId: args.organizationId,
    agentKey: args.agentKey,
    agentAutonomy: args.agentAutonomy,
    toolName: args.toolName,
    input: args.input,
  });
}
