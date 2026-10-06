import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import type { CostSource } from './cost-ranking';
import { normalizeCost } from './cost-ranking';
import type { DispatchDenial } from './tool-dispatch';
import type { FallbackVerdict } from './fallback';
import type { QaRoutingDecision } from './event-map';
import { routingDecisionRow } from './event-map';

/**
 * The writes of the Orchestrator's depth: leases, tool-dispatch denials, fallback records, usage costs and QA routing decisions.
 *
 * Every function here goes through a service-role door (`projects.claim_concurrency_lease` and the rest), whose own checks are the rules; this file
 * only carries a call and reports the door's answer in words. It does not decide: a refusal is the database's, and `outcome` is returned verbatim so
 * a caller can not mistake "conflict" for "claimed". None of it is called by a running job yet (see event-map.ts); it is the write side a verdict
 * handler or a dispatcher would use, and it is exercised by the SQL verifier (`scripts/verify-phase5-orchestrator.sql`), not by a live run.
 *
 * Generated database types do not know these doors until `db:types` is regenerated, so the client is narrowed to the one structural shape used.
 */

type Admin = ReturnType<typeof createAdminClient>;
type Answer = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Loose = {
  schema(name: string): {
    rpc(fn: string, args: Record<string, unknown>): Answer;
    from(table: string): { upsert(row: Record<string, unknown>, options: { onConflict: string; ignoreDuplicates: boolean }): Answer };
  };
};

const projects = (admin: Admin) => (admin as unknown as Loose).schema('projects');

function firstRow<T>(data: unknown): T | undefined {
  return (Array.isArray(data) ? data[0] : data) as T | undefined;
}

export type DoorAnswer<T extends Record<string, unknown> = Record<string, unknown>> = { ok: true; outcome: string; row: T } | { ok: false; detail: string };

async function call<T extends Record<string, unknown>>(admin: Admin, fn: string, args: Record<string, unknown>): Promise<DoorAnswer<T>> {
  const { data, error } = await projects(admin).rpc(fn, args);
  if (error) return { ok: false, detail: `${fn} did not answer: ${error.message}` };
  const row = firstRow<T & { outcome?: string }>(data);
  if (!row || typeof row.outcome !== 'string') return { ok: false, detail: `${fn} gave no outcome` };
  return { ok: true, outcome: row.outcome, row };
}

/** Claim the files a task will change. `conflict` names the lease and task that hold them; nothing is held on any outcome but `claimed`. */
export function claimLease(admin: Admin, input: { taskId: string; agentKey: string; filePaths: readonly string[]; ttlMinutes?: number }) {
  return call<{ outcome: string; lease_id: string | null; conflicting_lease_id: string | null; conflicting_task_id: string | null }>(admin, 'claim_concurrency_lease', {
    p_task_id: input.taskId,
    p_agent_key: input.agentKey,
    p_file_scope: [...input.filePaths],
    p_ttl_minutes: input.ttlMinutes ?? 60,
  });
}

export function releaseLease(admin: Admin, input: { leaseId: string; reason?: string }) {
  return call(admin, 'release_concurrency_lease', { p_lease_id: input.leaseId, p_reason: input.reason ?? 'completed' });
}

/** The expiry sweep: leases past their time are expired so a crashed worker does not hold files forever. Returns how many. */
export async function expireLeases(admin: Admin, projectId?: string): Promise<{ ok: true; expired: number } | { ok: false; detail: string }> {
  const { data, error } = await projects(admin).rpc('expire_concurrency_leases', { p_project_id: projectId ?? null });
  if (error) return { ok: false, detail: `expire_concurrency_leases did not answer: ${error.message}` };
  const row = firstRow<{ expired?: number }>(data);
  if (typeof row?.expired !== 'number' || row.expired < 0) return { ok: false, detail: 'expire_concurrency_leases refused the caller' };
  return { ok: true, expired: row.expired };
}

/** Write a refused dispatch to the audit log (argument names only, never values). The denial carries its own parameters. */
export function writeDispatchDenial(admin: Admin, denial: DispatchDenial) {
  return call(admin, 'record_tool_dispatch_denial', { ...denial.audit });
}

/** Persist a fallback verdict, rejected ones too: an Admin reads why a fallback was not taken. */
export function recordFallback(admin: Admin, input: { taskId: string; verdict: FallbackVerdict; reason: string; failureClass?: string }) {
  return call<{ outcome: string; fallback_id: string | null }>(admin, 'record_fallback', {
    p_task_id: input.taskId,
    p_primary_agent: input.verdict.primary,
    p_fallback_agent: input.verdict.fallback,
    p_reason: input.reason,
    p_violations: input.verdict.violations,
    p_failure_class: input.failureClass ?? null,
  });
}

/** Record what a run cost. A missing or invalid number is recorded as `unknown` with NULL, never as 0. */
export function recordUsageCost(
  admin: Admin,
  input: { projectId: string; agentKey: string; source: CostSource; costUsd?: number | null; taskId?: string; provider?: string; model?: string; inputTokens?: number; outputTokens?: number },
) {
  const cost = normalizeCost(input.source, input.costUsd);
  return call<{ outcome: string; usage_id: string | null }>(admin, 'record_usage_cost', {
    p_project_id: input.projectId,
    p_agent_key: input.agentKey,
    p_cost_source: cost.costSource,
    p_cost_usd: cost.costUsd,
    p_task_id: input.taskId ?? null,
    p_provider: input.provider ?? null,
    p_model: input.model ?? null,
    p_input_tokens: input.inputTokens ?? null,
    p_output_tokens: input.outputTokens ?? null,
  });
}

/**
 * Record a QA routing decision in `projects.routing_decisions`, and escalate a refusal to a person. `(task_id, outcome, code)` is unique, so a
 * replayed event records nothing twice. The row's organization is the caller's, taken from the job.
 */
export async function recordRoutingDecision(
  admin: Admin,
  decision: QaRoutingDecision,
  ctx: { organizationId: string; projectId: string; planId: string | null; taskId: string; policyVersion: string; requiredCapability?: string | null },
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { error } = await projects(admin).from('routing_decisions').upsert(routingDecisionRow(decision, ctx), { onConflict: 'task_id,outcome,code', ignoreDuplicates: true });
  if (error) return { ok: false, detail: `the routing decision could not be recorded: ${error.message}` };
  if (decision.outcome === 'refused') {
    const { error: escalationError } = await projects(admin).from('orchestrator_escalations').upsert(
      {
        organization_id: ctx.organizationId,
        project_id: ctx.projectId,
        task_id: ctx.taskId,
        required_capability: ctx.requiredCapability ?? null,
        root_cause: 'failure',
        candidates: decision.candidates,
        recommendation: `${decision.reason}.`,
      },
      { onConflict: 'task_id,root_cause', ignoreDuplicates: true },
    );
    if (escalationError) return { ok: false, detail: `the escalation could not be recorded: ${escalationError.message}` };
  }
  return { ok: true };
}
