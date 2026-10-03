import { z } from 'zod';

import { AGENT_DEFINITIONS, definitionFor } from './registry';
import { TOOL_NAMES, TOOLS, toolDefinition, type ToolActionClass } from './tools';

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

/**
 * SCR-061 (bucket G-3) — what a tool is, from its registered definition, and
 * which agents' definitions bind it. Pure: the registry and the tool list
 * are static, so the tool detail page can say what the tool does without a
 * read, and `null` for a name the registry has never heard of is the page's
 * not-found.
 */
export type ToolDetailDefinition = {
  name: string;
  purpose: string;
  actionClass: ToolActionClass;
  clientFacing: boolean;
  boundAgents: { key: string; displayName: string }[];
};

export function toolDetailFor(name: string): ToolDetailDefinition | null {
  const tool = toolDefinition(name);
  if (!tool) return null;
  return {
    name: tool.name,
    purpose: tool.purpose,
    actionClass: tool.actionClass,
    clientFacing: tool.clientFacing,
    boundAgents: AGENT_DEFINITIONS.filter((a) => a.tools.includes(tool.name)).map((a) => ({ key: a.key, displayName: a.displayName })),
  };
}

/** Every registered tool with the count of agents bound to it — the dashboard's tools list. */
export function listToolDefinitions(): ToolDetailDefinition[] {
  return TOOLS.map((t) => toolDetailFor(t.name)).filter((t): t is ToolDetailDefinition => t !== null);
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
