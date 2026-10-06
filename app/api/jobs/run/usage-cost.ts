/**
 * What a model call cost, written to `projects.usage_cost_records` for a run that belongs to a project.
 *
 * `recordModelCall` keeps the trace of a call (`ai.agent_steps`); this keeps the COST of it where the project's cost panel reads, through the
 * Orchestrator's own writer (`recordUsageCost`), so a cost carries where its number came from:
 *
 *   - a price the Admin recorded for the model produced a figure: `estimated` (tokens x the Admin's price per million, rounded up to a minor unit),
 *   - no figure (no price recorded, the provider reported none): `unknown`, and the number stays NULL. It is never written as 0: "we do not know"
 *     is not "this was free".
 *
 * A run's project (and task, when it names one) is read from the run's own `input`, which every project workflow opens with. A run with no project
 * (a conversation, a lead) has no project to charge, and writes nothing here.
 *
 * Best effort by design: a failure to write the cost record is logged and swallowed, because the agent's work must never fail on its bookkeeping.
 */

import type { AiUsage } from '@/lib/ai/types';
import type { createAdminClient } from '@/lib/db/admin';
import { recordUsageCost } from '@/modules/orchestrator/orchestrator-service';

type Admin = ReturnType<typeof createAdminClient>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOf(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
}

/** The cost fields for one call: a figure only when there is one, `unknown` (NULL) otherwise. Minor units are cents of the Admin's price list. */
export function costFor(usage: AiUsage): { source: 'estimated' | 'unknown'; costUsd: number | null } {
  return Number.isFinite(usage.costMinor) && usage.costMinor > 0 ? { source: 'estimated', costUsd: usage.costMinor / 100 } : { source: 'unknown', costUsd: null };
}

export async function recordRunUsageCost(
  admin: Admin,
  args: { runId: string | null; providerId: string; model: string; usage: AiUsage | null },
): Promise<void> {
  if (!args.runId || !args.usage) return;
  try {
    const { data: run, error } = await admin.schema('ai').from('agent_runs').select('agent_key, input').eq('id', args.runId).maybeSingle();
    if (error || !run) return;
    const input = typeof run.input === 'object' && run.input !== null && !Array.isArray(run.input) ? (run.input as Record<string, unknown>) : {};
    const projectId = uuidOf(input.projectId);
    if (!projectId || typeof run.agent_key !== 'string') return;

    const cost = costFor(args.usage);
    const answer = await recordUsageCost(admin, {
      projectId,
      agentKey: run.agent_key,
      source: cost.source,
      costUsd: cost.costUsd,
      taskId: uuidOf(input.taskId),
      provider: args.providerId,
      model: args.model,
      inputTokens: args.usage.inputTokens,
      outputTokens: args.usage.outputTokens,
    });
    if (!answer.ok || answer.outcome !== 'recorded') {
      console.error(JSON.stringify({ level: 'error', scope: 'recordRunUsageCost', runId: args.runId, detail: answer.ok ? `the door answered ${answer.outcome}` : answer.detail }));
    }
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordRunUsageCost', runId: args.runId, detail: e instanceof Error ? e.message : 'unknown' }));
  }
}
