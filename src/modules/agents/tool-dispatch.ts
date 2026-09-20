import 'server-only';

import type { AiToolSpec } from '@/lib/ai/types';
import type { createAdminClient } from '@/lib/db/admin';
import { err, ok, type Result } from '@/lib/result';

import { resolveTool, toolDefinition, type ToolDefinition } from './tools';

/**
 * The same alias `agent-run.ts` defines for the service-role client, typed
 * against its source rather than imported from `app/api/jobs/run` — nothing
 * under `src/modules` imports from `app/`, and this file is not the one to
 * start.
 */
type Admin = ReturnType<typeof createAdminClient>;

/**
 * The tool loop's other half — G-187, ADM-99.
 *
 * `tools.ts` decides which tool a call may even be attempted against
 * (`resolveTool`); this decides what happens once it is. Two files for the
 * same reason `resolveTool`'s own docblock gives for the boundary running
 * before a tool's own authorization: a call this file executes has already
 * cleared the boundary, and this file's job is never to re-loosen it.
 *
 * ── ADM-99: the four, and only the four ───────────────────────────────
 *
 * The owner's answer named "the four read-only tools" specifically — not
 * "everything L0", which happens to be the same four today but would silently
 * widen if a fifth L0 tool were ever added without this list being reread.
 * `DISPATCHABLE` is that list, spelled out rather than derived from
 * `actionClass === 'L0'`, so a new read-only tool needs a decision to reach
 * this file rather than reaching it by construction.
 *
 * Every other bound tool — `memory.remember`, `crm.sendClientMessage`,
 * `finance.generateInvoice`, all of it — is refused here with
 * `not_dispatched`, whatever `resolveTool` said. The boundary narrows what
 * MAY be attempted; this narrows it again to what actually runs, and the two
 * lists are allowed to disagree.
 */
const DISPATCHABLE: readonly string[] = [
  'crm.readLead',
  'crm.readConversation',
  'memory.recall',
  'projects.readScope',
];

/**
 * A tool's argument shape, as a JSON Schema the model fills in.
 *
 * Not part of `ToolDefinition` in `tools.ts`: that type is read by the
 * authorization boundary and by the Admin Panel's tool list, neither of which
 * needs to know a call's wire shape, and giving every consumer of that file a
 * reason to import a JSON Schema builder is exactly the kind of unrelated
 * coupling `ARCHITECTURE.md` §3.2 exists to prevent.
 */
const INPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  'crm.readLead': {
    type: 'object',
    properties: { leadId: { type: 'string', format: 'uuid' } },
    required: ['leadId'],
    additionalProperties: false,
  },
  'crm.readConversation': {
    type: 'object',
    properties: { conversationId: { type: 'string', format: 'uuid' } },
    required: ['conversationId'],
    additionalProperties: false,
  },
  'memory.recall': {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['organization', 'lead', 'project'] },
      scopeId: { type: 'string', format: 'uuid' },
    },
    required: ['scope'],
    additionalProperties: false,
  },
  'projects.readScope': {
    type: 'object',
    properties: { projectId: { type: 'string', format: 'uuid' } },
    required: ['projectId'],
    additionalProperties: false,
  },
};

/** What the model is offered for one dispatchable tool, or null if it has none here. */
export function toolSpecFor(name: string): AiToolSpec | null {
  const definition = toolDefinition(name);
  const inputSchema = INPUT_SCHEMAS[name];
  if (!definition || !inputSchema || !DISPATCHABLE.includes(name)) return null;
  return { name: definition.name, description: definition.purpose, inputSchema };
}

/**
 * The specs for whichever of an agent's bound tools this file can run.
 *
 * Deliberately the INTERSECTION of what the agent holds and what ADM-99
 * dispatches, computed here rather than left for the caller to remember: a
 * caller that offered the model tools it cannot execute would get `tool_use`
 * blocks this file then has to refuse one at a time, which is a worse failure
 * mode than the model never being offered them.
 */
export function dispatchableToolsFor(bound: readonly ToolDefinition[]): readonly AiToolSpec[] {
  return bound.map((t) => toolSpecFor(t.name)).filter((t): t is AiToolSpec => t !== null);
}

type DispatchArgs = {
  admin: Admin;
  organizationId: string;
  agentKey: string;
  agentAutonomy: 'L0' | 'L1' | 'L2';
  toolName: string;
  input: unknown;
};

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Runs one tool call, or refuses it — the only path by which a model's
 * request becomes a database read.
 *
 * Order, and it matters: the AUTHORIZATION boundary first (does this agent
 * hold this tool, at a class its autonomy admits), then the DISPATCH boundary
 * (is this one of the four ADM-99 actually turns on), then the argument shape,
 * then the read itself — scoped to `organizationId` by hand exactly the way
 * every other service-role caller in `workflows.ts` is, because this runs on
 * the admin client, which RLS does not see.
 *
 * Returns a STRING always. What the model reads back is `tool_result` content
 * (this port's `AiContentBlock` says so), never a typed value — the shape a
 * result takes is this file's business and nobody downstream's.
 */
export async function dispatchTool(args: DispatchArgs): Promise<Result<string>> {
  const authorized = resolveTool(args.agentKey, args.toolName, args.agentAutonomy);
  if (!authorized.ok) return authorized;

  if (!DISPATCHABLE.includes(args.toolName)) {
    return err(
      'FORBIDDEN',
      `"${args.toolName}" is bound and authorized, but ADM-99 has not turned on dispatch for it.`,
    );
  }

  const input = asRecord(args.input);

  switch (args.toolName) {
    case 'crm.readLead': {
      const leadId = asString(input.leadId);
      if (!leadId) return err('VALIDATION', 'crm.readLead needs a leadId.');

      const { data, error } = await args.admin
        .schema('crm')
        .from('leads')
        .select('id, title, status, source, summary')
        .eq('id', leadId)
        .eq('organization_id', args.organizationId)
        .is('deleted_at', null)
        .maybeSingle();

      if (error) return err('INTERNAL', 'Could not read that lead.');
      if (!data) return err('NOT_FOUND', 'No lead with that id in this organization.');
      return ok(JSON.stringify(data));
    }

    case 'crm.readConversation': {
      const conversationId = asString(input.conversationId);
      if (!conversationId) return err('VALIDATION', 'crm.readConversation needs a conversationId.');

      // The conversation itself is checked for tenancy before its messages are
      // read: a message table scoped only by conversation_id would answer a
      // conversation id from another organization with that organization's
      // transcript, because the FK says nothing about WHICH organization.
      const { data: conversation, error: conversationError } = await args.admin
        .schema('crm')
        .from('conversations')
        .select('id')
        .eq('id', conversationId)
        .eq('organization_id', args.organizationId)
        .maybeSingle();

      if (conversationError) return err('INTERNAL', 'Could not read that conversation.');
      if (!conversation) return err('NOT_FOUND', 'No conversation with that id in this organization.');

      const { data: messages, error: messagesError } = await args.admin
        .schema('crm')
        .from('conversation_messages')
        .select('seq, author_type, body, occurred_at')
        .eq('conversation_id', conversationId)
        .order('seq', { ascending: true })
        .limit(200);

      if (messagesError) return err('INTERNAL', 'Could not read that conversation.');
      return ok(JSON.stringify(messages ?? []));
    }

    case 'memory.recall': {
      const scope = asString(input.scope);
      if (!scope || !['organization', 'lead', 'project'].includes(scope)) {
        return err('VALIDATION', 'memory.recall needs a scope of organization, lead or project.');
      }
      const scopeId = asString(input.scopeId);
      if (scope !== 'organization' && !scopeId) {
        return err('VALIDATION', `memory.recall for scope "${scope}" needs a scopeId.`);
      }

      // G-189: this runs with the service role, which has no RLS to be scoped
      // by, so the tenant is a parameter rather than left to RLS. The same
      // call `pricingDecisionsFor` and `revisionCorrectionsFor` make.
      const { data, error } = await args.admin.schema('ai').rpc('recall', {
        p_scope: scope,
        p_scope_id: scopeId ?? undefined,
        p_limit: 20,
        p_organization_id: args.organizationId,
      });

      if (error) return err('INTERNAL', 'Could not recall memory.');
      return ok(JSON.stringify(data ?? []));
    }

    case 'projects.readScope': {
      const projectId = asString(input.projectId);
      if (!projectId) return err('VALIDATION', 'projects.readScope needs a projectId.');

      const { data: version, error: versionError } = await args.admin
        .schema('projects')
        .from('scope_versions')
        .select('id, version, status')
        .eq('project_id', projectId)
        .eq('organization_id', args.organizationId)
        .eq('status', 'active')
        .maybeSingle();

      if (versionError) return err('INTERNAL', 'Could not read the scope baseline.');
      if (!version) return ok(JSON.stringify({ active: null, items: [] }));

      const { data: items, error: itemsError } = await args.admin
        .schema('projects')
        .from('scope_items')
        .select('id, title, inclusion')
        .eq('scope_version_id', version.id);

      if (itemsError) return err('INTERNAL', 'Could not read the scope baseline.');
      return ok(JSON.stringify({ active: version, items: items ?? [] }));
    }

    default:
      // Unreachable given the DISPATCHABLE check above; named rather than
      // left as a TypeScript exhaustiveness gap, because DISPATCHABLE is a
      // plain string array and cannot narrow the switch for the compiler.
      return err('INTERNAL', `"${args.toolName}" has no dispatch handler.`);
  }
}
