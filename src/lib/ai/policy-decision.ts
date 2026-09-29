/**
 * Whether this tenant's policy lets an agent do the thing it is about to do
 * — the owner's decision 3 of 2026-09-29.
 *
 * `ai.agent_tool_permissions` and `ai.agent_project_assignments` were written
 * (20260929170000) as "a policy record the orchestrator does not yet read".
 * This is the reading. Pure and dependency-free, like `autonomy.ts`: the
 * decision is worth testing on its own, and the thing that executes it holds
 * a service-role client a test has no business holding. The two loaders and
 * the refusal writer live in `agent-policy.ts`; the runner calls those, and
 * those call this.
 *
 * Two rules, both fail-closed:
 *
 *   TOOLS — a call runs only when a row says `allowed = true`. No row is a
 *   refusal too ("deny by default"): an owner who has recorded nothing has
 *   not consented, and a policy that let an unlisted tool through would be
 *   one the owner has to keep complete to be safe. `resolveTool` (does the
 *   agent hold this tool at all) still runs first and is not replaced.
 *
 *   PROJECTS — an agent with any ACTIVE assignment works only on those
 *   projects; an agent with none works on all. "None = all" is the owner's
 *   wording, and it is what keeps a fresh tenant running before anybody has
 *   assigned anything.
 */

export type ToolPermissionRecord = { allowed: boolean };

export type PolicyVerdict =
  | { allowed: true }
  | { allowed: false; kind: 'tool_denied' | 'tool_unrecorded' | 'project_unassigned'; reason: string };

/** The kinds a refusal row may carry — mirrors `ai.agent_policy_refusals.kind`. */
export const REFUSAL_KINDS = ['tool_denied', 'tool_unrecorded', 'project_unassigned'] as const;

export function decideToolCall(args: {
  agentKey: string;
  toolKey: string;
  /** The tenant's row for (agent, tool), or null when none was recorded. */
  permission: ToolPermissionRecord | null;
}): PolicyVerdict {
  if (args.permission === null) {
    return {
      allowed: false,
      kind: 'tool_unrecorded',
      reason: `"${args.toolKey}" has no permission recorded for ${args.agentKey} in this organisation; the owner has not allowed it.`,
    };
  }
  if (!args.permission.allowed) {
    return {
      allowed: false,
      kind: 'tool_denied',
      reason: `"${args.toolKey}" is denied for ${args.agentKey} by the owner's tool permissions.`,
    };
  }
  return { allowed: true };
}

export function decideProjectAction(args: {
  agentKey: string;
  projectId: string;
  /** The ids of every project the agent is ACTIVELY assigned to in this tenant. */
  assignedProjectIds: readonly string[];
}): PolicyVerdict {
  if (args.assignedProjectIds.length === 0) return { allowed: true };
  if (args.assignedProjectIds.includes(args.projectId)) return { allowed: true };
  return {
    allowed: false,
    kind: 'project_unassigned',
    reason: `${args.agentKey} is assigned to ${args.assignedProjectIds.length} project${
      args.assignedProjectIds.length === 1 ? '' : 's'
    } in this organisation and this is not one of them.`,
  };
}

/**
 * The project a piece of work is about, if the work says so.
 *
 * Every project workflow states `projectId` in the input it opens its run
 * with (`openRun(ctx, { input: { projectId, … } })`), so that is the one
 * place the runner can read it generically. Tool inputs use the same key
 * (`projects.readScope` takes `{ projectId }`). Anything that is not a
 * non-empty string is "no project named", which the caller treats as work
 * the assignment rule does not reach — not as permission.
 */
export function projectIdOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>).projectId;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
