import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What staff see of the Orchestrator's depth for one project: who holds which files, which fallbacks were taken or refused, and what runs cost.
 *
 * Read with the user's own client, so RLS decides (internal staff of the organization only). Every read is guarded (G-054): a failed read is
 * `unreadable`, never rendered as "no leases" or "no cost", because "nothing held" and "could not look" lead to different decisions. The cost totals
 * keep their sources apart and an `unknown` total stays `null`: it is shown as unknown, never added up as 0.
 */

export type LeaseRow = { id: string; taskId: string; taskTitle: string | null; agentKey: string; filePaths: string[]; state: string; claimedAt: string; expiresAt: string };
export type FallbackRow = { id: string; taskTitle: string | null; primaryAgent: string; fallbackAgent: string; outcome: string; reason: string; violations: string[]; createdAt: string };
export type CostRow = { source: 'reported' | 'estimated' | 'unknown'; records: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
export type OrchestratorOverview = { leases: LeaseRow[]; fallbacks: FallbackRow[]; costs: CostRow[] };

type Answer = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Loose = {
  from(table: string): {
    select(columns: string): { eq(column: string, value: string): { order(column: string, options: { ascending: boolean }): { limit(n: number): Answer } } };
  };
  rpc(fn: string, args: Record<string, unknown>): Answer;
};

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const titleOf = (v: unknown): string | null => {
  const one = Array.isArray(v) ? v[0] : v;
  return one && typeof one === 'object' && typeof (one as Row).title === 'string' ? ((one as Row).title as string) : null;
};

export async function readOrchestratorOverview(projectId: string): Promise<OrchestratorOverview> {
  const supabase = await createClient();
  const projects = supabase.schema('projects') as unknown as Loose;

  const [{ data: leaseRows, error: leaseError }, { data: fallbackRows, error: fallbackError }, { data: costRows, error: costError }] = await Promise.all([
    projects.from('concurrency_leases').select('id, task_id, agent_key, file_scope, state, claimed_at, expires_at, tasks(title)').eq('project_id', projectId).order('claimed_at', { ascending: false }).limit(40),
    projects.from('fallback_records').select('id, primary_agent, fallback_agent, outcome, reason, violations, created_at, tasks(title)').eq('project_id', projectId).order('created_at', { ascending: false }).limit(20),
    projects.rpc('usage_cost_summary', { p_project_id: projectId }),
  ]);
  if (leaseError) unreadable('readOrchestratorOverview.leases', leaseError);
  if (fallbackError) unreadable('readOrchestratorOverview.fallbacks', fallbackError);
  if (costError) unreadable('readOrchestratorOverview.costs', costError);

  return {
    leases: ((leaseRows as Row[] | null) ?? []).map((r) => ({
      id: str(r.id),
      taskId: str(r.task_id),
      taskTitle: titleOf(r.tasks),
      agentKey: str(r.agent_key),
      filePaths: Array.isArray(r.file_scope) ? (r.file_scope as unknown[]).map(str) : [],
      state: str(r.state),
      claimedAt: str(r.claimed_at),
      expiresAt: str(r.expires_at),
    })),
    fallbacks: ((fallbackRows as Row[] | null) ?? []).map((r) => ({
      id: str(r.id),
      taskTitle: titleOf(r.tasks),
      primaryAgent: str(r.primary_agent),
      fallbackAgent: str(r.fallback_agent),
      outcome: str(r.outcome),
      reason: str(r.reason),
      violations: Array.isArray(r.violations) ? (r.violations as Row[]).map((v) => str(v.code)) : [],
      createdAt: str(r.created_at),
    })),
    costs: ((costRows as Row[] | null) ?? []).map((r) => ({
      source: (['reported', 'estimated'].includes(str(r.cost_source)) ? str(r.cost_source) : 'unknown') as CostRow['source'],
      records: Number(r.records ?? 0),
      inputTokens: numOrNull(r.input_tokens),
      outputTokens: numOrNull(r.output_tokens),
      // an unknown group has no number: null stays null here, it is never turned into 0
      costUsd: numOrNull(r.cost_usd),
    })),
  };
}
