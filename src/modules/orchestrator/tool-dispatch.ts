import { z } from 'zod';

import { definitionFor } from '@/modules/agents/registry';

import { scopeBase } from './conflicts';

/**
 * The tool permission and dispatchability gate - Phase 5 Orchestrator spec section 14:
 *
 *   tool must be registered; tool must be dispatchable for the specialist; the agent identity must have the action permission;
 *   project / repository scope must match; a high-risk tool must pass a policy / approval check.
 *
 * Pure. It decides whether a call MAY be dispatched and executes nothing: there is no executor in this file, and a denial is a value with a code
 * and a reason, never an exception a caller can swallow. Every denial also carries the parameters to write it down
 * (`projects.record_tool_dispatch_denial`, a service-role door onto `core.record_audit`), which `writeDispatchDenial` in
 * `orchestrator-service.ts` sends. Argument NAMES go to the audit, never values: a refused call may carry the secret that was the reason.
 *
 * Today no specialist holds a tool (`AgentDefinition.tools` is empty for all of them, by design until activation), so against the real registry
 * every call is denied `tool_not_bound`. That is the honest answer, and it is what makes the catalog below safe to ship before any tool is bound:
 * a name in the catalog grants nothing. Binding a tool to an agent is a reviewed change to the registry.
 */

export type ToolKind = 'read' | 'write';
export type TaskRisk = 'low' | 'medium' | 'high' | 'critical';

export type ToolSpec = {
  readonly name: string;
  readonly kind: ToolKind;
  /** A high-risk tool is never dispatched without an explicit approval, whatever the task's own risk. */
  readonly highRisk: boolean;
  readonly argsSchema: z.ZodType<Record<string, unknown>>;
  /** Names of arguments that hold repository paths. Every one must stay inside the lease scope (write tools) and out of forbidden places (all). */
  readonly pathArgs: readonly string[];
  /** The argument that names a project, when the tool has one: it must equal the dispatch scope's project. */
  readonly projectArg?: string;
  readonly description: string;
};

const path = z.string().min(1).max(500);

export const TOOL_CATALOG: readonly ToolSpec[] = [
  { name: 'read_file', kind: 'read', highRisk: false, argsSchema: z.object({ path }).strict(), pathArgs: ['path'], description: 'Read one repository file.' },
  { name: 'list_directory', kind: 'read', highRisk: false, argsSchema: z.object({ path }).strict(), pathArgs: ['path'], description: 'List a repository directory.' },
  {
    name: 'search_code',
    kind: 'read',
    highRisk: false,
    argsSchema: z.object({ query: z.string().min(1).max(200), path: path.optional() }).strict(),
    pathArgs: ['path'],
    description: 'Search the repository for text.',
  },
  {
    name: 'write_file',
    kind: 'write',
    highRisk: false,
    argsSchema: z.object({ path, content: z.string().max(200_000) }).strict(),
    pathArgs: ['path'],
    description: 'Create or replace one file inside the leased files.',
  },
  {
    name: 'apply_patch',
    kind: 'write',
    highRisk: false,
    argsSchema: z.object({ path, patch: z.string().min(1).max(200_000) }).strict(),
    pathArgs: ['path'],
    description: 'Apply a patch to one file inside the leased files.',
  },
  { name: 'delete_file', kind: 'write', highRisk: true, argsSchema: z.object({ path }).strict(), pathArgs: ['path'], description: 'Delete one file.' },
  { name: 'run_migration', kind: 'write', highRisk: true, argsSchema: z.object({ path }).strict(), pathArgs: ['path'], description: 'Apply a database migration.' },
  {
    name: 'open_pull_request',
    kind: 'write',
    highRisk: true,
    argsSchema: z.object({ project_id: z.string().uuid(), title: z.string().min(1).max(200), branch: z.string().min(1).max(200) }).strict(),
    pathArgs: [],
    projectArg: 'project_id',
    description: 'Open a pull request through the governed git writer.',
  },
];

export type DispatchScope = {
  projectId: string;
  /** `read_only` refuses every write tool; `read_write` allows them inside `filePaths`. */
  mode: 'read_only' | 'read_write';
  /** The files this dispatch holds a lease on. A write path must be inside one of them. */
  filePaths: readonly string[];
};

export const DISPATCH_DENIAL_CODES = [
  'unknown_agent',
  'unknown_tool',
  'tool_not_bound',
  'invalid_args',
  'out_of_scope',
  'write_not_permitted',
  'approval_required',
] as const;
export type DispatchDenialCode = (typeof DISPATCH_DENIAL_CODES)[number];

export type DispatchDenial = {
  allowed: false;
  code: DispatchDenialCode;
  reason: string;
  agent: string;
  tool: string;
  /** The audit parameters for `projects.record_tool_dispatch_denial`. Names of the arguments, never their values. */
  audit: { p_project_id: string; p_agent_key: string; p_tool: string; p_code: DispatchDenialCode; p_detail: string; p_arg_keys: string[] };
};

export type DispatchAllowed = { allowed: true; tool: ToolSpec; args: Record<string, unknown> };
export type DispatchDecision = DispatchAllowed | DispatchDenial;

/** Never readable or writable by any tool: credentials, key material, git internals. */
const FORBIDDEN_PATH = /(^|\/)(\.env[^/]*|\.git(\/|$)|id_rsa[^/]*|[^/]*\.pem|[^/]*\.p12|\.npmrc|\.netrc)$|(^|\/)\.git\//i;

function normalizedPath(raw: string): { ok: true; path: string } | { ok: false; why: string } {
  const flat = raw.trim().replace(/\\/g, '/');
  if (/(^|\/)\.\.(\/|$)/.test(flat)) return { ok: false, why: 'it climbs out of the repository' };
  if (/[*?[{]/.test(flat)) return { ok: false, why: 'a tool names one path, not a pattern' };
  const base = scopeBase(flat);
  if (base === '') return { ok: false, why: 'it names no file' };
  if (FORBIDDEN_PATH.test(base)) return { ok: false, why: 'it is a credential or git-internal path' };
  return { ok: true, path: base };
}

/** Is `file` the same as, or inside, one of the leased paths? (`src/ui` holds `src/ui/a.tsx` and not `src/uikit/a.tsx`.) */
export function pathWithinScope(file: string, scope: readonly string[]): boolean {
  return scope.some((entry) => {
    const base = scopeBase(entry);
    return base === '' || file === base || file.startsWith(`${base}/`);
  });
}

export function checkToolDispatch(input: {
  agent: string;
  tool: string;
  args: unknown;
  scope: DispatchScope;
  /** The task's risk. A write under a high or critical task needs approval even for a tool that is not high-risk itself. */
  risk: TaskRisk | null;
  /** True only when a person (or the approval policy) has approved THIS call. Never inferred. */
  approved?: boolean;
  /** Overrides the registry's tool list for the agent (tests, and the day a binding exists in another source). Default: the registry. */
  boundTools?: readonly string[];
  catalog?: readonly ToolSpec[];
}): DispatchDecision {
  const argKeys =
    input.args !== null && typeof input.args === 'object' && !Array.isArray(input.args) ? Object.keys(input.args as Record<string, unknown>).slice(0, 30) : [];
  const deny = (code: DispatchDenialCode, reason: string): DispatchDenial => ({
    allowed: false,
    code,
    reason,
    agent: input.agent,
    tool: input.tool,
    audit: { p_project_id: input.scope.projectId, p_agent_key: input.agent, p_tool: input.tool, p_code: code, p_detail: reason.slice(0, 300), p_arg_keys: argKeys },
  });

  const definition = definitionFor(input.agent);
  if (!definition) return deny('unknown_agent', `${input.agent} is not a registered agent`);

  const spec = (input.catalog ?? TOOL_CATALOG).find((t) => t.name === input.tool);
  if (!spec) return deny('unknown_tool', `${input.tool} is not a registered tool`);

  const bound = input.boundTools ?? definition.tools;
  if (!bound.includes(spec.name)) {
    return deny('tool_not_bound', `${input.agent} is not bound to ${spec.name}: a tool the agent's definition does not list does not exist for it`);
  }

  if (spec.kind === 'write' && input.scope.mode !== 'read_write') {
    return deny('write_not_permitted', `${spec.name} writes, and this dispatch is read-only`);
  }

  const parsed = spec.argsSchema.safeParse(input.args);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return deny('invalid_args', `the arguments do not match ${spec.name}'s schema${first ? `: ${first.path.join('.') || '(root)'} ${first.message}` : ''}`);
  }
  const args = parsed.data;

  if (spec.projectArg && args[spec.projectArg] !== input.scope.projectId) {
    return deny('out_of_scope', `${spec.name} names a project other than the one this dispatch is scoped to`);
  }
  for (const name of spec.pathArgs) {
    const raw = args[name];
    if (typeof raw !== 'string') continue; // an optional path that was not given
    const normalized = normalizedPath(raw);
    if (!normalized.ok) return deny('out_of_scope', `${name} is refused: ${normalized.why}`);
    if (spec.kind === 'write' && !pathWithinScope(normalized.path, input.scope.filePaths)) {
      return deny('out_of_scope', `${name} is outside the files this dispatch holds a lease on`);
    }
  }

  const risky = spec.highRisk || (spec.kind === 'write' && (input.risk === 'high' || input.risk === 'critical'));
  if (risky && input.approved !== true) {
    return deny('approval_required', spec.highRisk ? `${spec.name} is a high-risk tool and needs an approval` : `${spec.name} writes under a ${input.risk}-risk task and needs an approval`);
  }

  return { allowed: true, tool: spec, args };
}
