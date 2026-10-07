import 'server-only';

import { createAdminClient } from '@/lib/db/admin';
import { adminRpc, asRows, firstRow, text } from '@/lib/db/p1o-rpc';

import { createHandoffArgs, routeTask, validateTaskEnvelope, type Capability, type Route } from './p1o-envelope';

/**
 * The sanctioned way for a workflow to hand a task to another agent (Orchestrator s4/s5/s10, Coordination s5): validate the envelope, route it, then create the
 * handoff through `ai.p1o_create_handoff`, which is idempotent on the key. An envelope that is malformed is refused before anything runs; a task type with no safe
 * route is NOT created (there is no agent to hold it) and the caller is told to escalate to a person; a duplicate returns the task it already made.
 * Service-role only: this is for the job runner. A person acts through the task board.
 */

export type DispatchResult =
  | { state: 'created'; handoffId: string }
  | { state: 'duplicate'; handoffId: string }
  | { state: 'invalid'; problems: string[] }
  | { state: 'no_route'; reason: string }
  | { state: 'refused'; outcome: string };

export async function readCapabilities(): Promise<{ capabilities: Capability[]; enabledAgents: Set<string> }> {
  const admin = createAdminClient();
  const caps = await admin.schema('ai' as never).from('p1o_capabilities' as never).select('task_type, handler_kind, handler_key, agent_key, available');
  if (caps.error) throw new Error(`capabilities could not be read: ${caps.error.message}`);
  const agents = await admin.schema('ai').from('agents').select('key, enabled');
  if (agents.error) throw new Error(`agents could not be read: ${agents.error.message}`);
  return {
    capabilities: asRows(caps.data).map((r) => ({
      taskType: String(r.task_type),
      handlerKind: r.handler_kind as Capability['handlerKind'],
      handlerKey: String(r.handler_key),
      agentKey: text(r.agent_key),
      available: r.available === true,
    })),
    enabledAgents: new Set((agents.data ?? []).filter((a) => a.enabled).map((a) => a.key)),
  };
}

export async function dispatchTask(input: unknown, deps: { route?: (taskType: string) => Promise<Route> } = {}): Promise<DispatchResult> {
  const verdict = validateTaskEnvelope(input);
  if (!verdict.ok) return { state: 'invalid', problems: verdict.problems };
  const envelope = verdict.envelope;

  const route = deps.route
    ? await deps.route(envelope.taskType)
    : await readCapabilities().then(({ capabilities, enabledAgents }) => routeTask(envelope.taskType, capabilities, enabledAgents));
  if (!route.routed) return { state: 'no_route', reason: route.reason };

  const { data, error } = await adminRpc('ai')('p1o_create_handoff', createHandoffArgs(envelope));
  if (error) throw new Error(`the handoff could not be created: ${error.message}`);
  const row = firstRow(data);
  const outcome = String(row?.outcome ?? '');
  if (outcome === 'created') return { state: 'created', handoffId: String(row?.handoff_id) };
  if (outcome === 'duplicate') return { state: 'duplicate', handoffId: String(row?.handoff_id) };
  return { state: 'refused', outcome };
}
