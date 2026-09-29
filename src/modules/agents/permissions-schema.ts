import { z } from 'zod';

import { definitionFor } from './registry';
import { TOOL_NAMES } from './tools';

/**
 * SCR-062/063 — this tenant's policy for a global agent: which tools it may
 * use, and which projects it is assigned to. Mirrors
 * `ai.set_agent_tool_permission` / `ai.set_agent_project_assignment`
 * (20260929170000).
 *
 * The tool vocabulary is `TOOLS` in ./tools.ts — every tool an agent can be
 * bound to — re-exported here so a page may offer the same list without
 * reaching into the module. A record is a policy the orchestrator does not
 * yet read: `resolveTool` still decides from the agent definition alone.
 */

export const KNOWN_TOOL_KEYS: readonly string[] = TOOL_NAMES;

/** The tools an agent's definition binds today — what `resolveTool` actually permits. */
export function boundToolKeysFor(agentKey: string): readonly string[] {
  return definitionFor(agentKey)?.tools ?? [];
}

const agentKey = z.string().regex(/^[a-z][a-z0-9_]{2,48}$/, 'Not an agent key.');

export const setAgentToolPermissionSchema = z.object({
  agentKey,
  toolKey: z.string().regex(/^[a-z][a-zA-Z0-9_.]{1,80}$/, 'Not a tool key.'),
  allowed: z.boolean(),
  note: z.string().trim().max(500).optional(),
});
export type SetAgentToolPermissionInput = z.infer<typeof setAgentToolPermissionSchema>;

export const setAgentProjectAssignmentSchema = z.object({
  agentKey,
  projectId: z.uuid(),
  active: z.boolean(),
});
export type SetAgentProjectAssignmentInput = z.infer<typeof setAgentProjectAssignmentSchema>;
