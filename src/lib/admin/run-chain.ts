import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * One agent run and everything that shares its correlation id — SCR-065's
 * retry / dead-letter linkage and SCR-066's workflow view.
 *
 * A correlation id is the one thread through the system: the job that
 * started the run, the retries the queue made of it, the runs it produced
 * and the audit rows it left all carry the same one. `core.jobs` and
 * `ai.agent_runs` are read under their own RLS (`jobs_select`,
 * `agent_runs_select`, both owner / ops_admin), the same rows /operations
 * already shows one at a time. `unreadable()` on failure (G-054): an empty
 * chain reads as "nothing happened", which is the wrong thing to say when
 * the database did not answer.
 */

export type CorrelatedJob = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: string;
  updatedAt: string;
  correlationId: string | null;
};

/** The jobs carrying a correlation id — the retries and dead letters of one piece of work. */
export async function listJobsByCorrelation(correlationId: string): Promise<CorrelatedJob[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('core')
    .from('jobs')
    .select('id, kind, status, attempts, max_attempts, last_error, run_at, updated_at, correlation_id')
    .eq('correlation_id', correlationId)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) unreadable('listJobsByCorrelation', error);

  return (data ?? []).map((j) => ({
    id: j.id,
    kind: j.kind,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.max_attempts,
    lastError: j.last_error,
    runAt: j.run_at,
    updatedAt: j.updated_at,
    correlationId: j.correlation_id,
  }));
}

export type CorrelatedRun = {
  id: string;
  agentKey: string;
  status: string;
  trigger: string;
  error: string | null;
  costMinor: number;
  correlationId: string | null;
  createdAt: string;
};

/** The runs carrying a correlation id. */
export async function listRunsByCorrelation(correlationId: string): Promise<CorrelatedRun[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('ai')
    .from('agent_runs')
    .select('id, agent_key, status, trigger, error, cost_minor, correlation_id, created_at')
    .eq('correlation_id', correlationId)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) unreadable('listRunsByCorrelation', error);

  return (data ?? []).map((r) => ({
    id: r.id,
    agentKey: r.agent_key,
    status: r.status,
    trigger: r.trigger,
    error: r.error,
    costMinor: r.cost_minor,
    correlationId: r.correlation_id,
    createdAt: r.created_at,
  }));
}

export type Workflow = {
  correlationId: string;
  runs: CorrelatedRun[];
  jobs: CorrelatedJob[];
  firstAt: string;
  lastAt: string;
  /** failed when any run failed or any job is dead; running when a job is queued or a run open; else settled. */
  state: 'failed' | 'running' | 'settled';
};

/**
 * Recent work grouped by correlation id — SCR-066's "workflow runs". The
 * most recent runs are read, their correlation ids collected, and the jobs
 * sharing those ids fetched in one query. Runs without a correlation id are
 * one-off and are left out; they are on /usage and the agent pages.
 */
export async function listRecentWorkflows(limit = 25): Promise<Workflow[]> {
  const supabase = await createClient();

  const { data: runRows, error: runsError } = await supabase
    .schema('ai')
    .from('agent_runs')
    .select('id, agent_key, status, trigger, error, cost_minor, correlation_id, created_at')
    .not('correlation_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit * 4);
  if (runsError) unreadable('listRecentWorkflows.runs', runsError);

  const byCorrelation = new Map<string, CorrelatedRun[]>();
  for (const r of runRows ?? []) {
    if (!r.correlation_id) continue;
    if (!byCorrelation.has(r.correlation_id) && byCorrelation.size >= limit) continue;
    const list = byCorrelation.get(r.correlation_id) ?? [];
    list.push({
      id: r.id,
      agentKey: r.agent_key,
      status: r.status,
      trigger: r.trigger,
      error: r.error,
      costMinor: r.cost_minor,
      correlationId: r.correlation_id,
      createdAt: r.created_at,
    });
    byCorrelation.set(r.correlation_id, list);
  }
  const ids = [...byCorrelation.keys()];
  if (ids.length === 0) return [];

  const { data: jobRows, error: jobsError } = await supabase
    .schema('core')
    .from('jobs')
    .select('id, kind, status, attempts, max_attempts, last_error, run_at, updated_at, correlation_id')
    .in('correlation_id', ids)
    .order('created_at', { ascending: true })
    .limit(1000);
  if (jobsError) unreadable('listRecentWorkflows.jobs', jobsError);

  const jobsByCorrelation = new Map<string, CorrelatedJob[]>();
  for (const j of jobRows ?? []) {
    if (!j.correlation_id) continue;
    const list = jobsByCorrelation.get(j.correlation_id) ?? [];
    list.push({
      id: j.id,
      kind: j.kind,
      status: j.status,
      attempts: j.attempts,
      maxAttempts: j.max_attempts,
      lastError: j.last_error,
      runAt: j.run_at,
      updatedAt: j.updated_at,
      correlationId: j.correlation_id,
    });
    jobsByCorrelation.set(j.correlation_id, list);
  }

  return ids.map((correlationId) => {
    const runs = [...(byCorrelation.get(correlationId) ?? [])].reverse();
    const jobs = jobsByCorrelation.get(correlationId) ?? [];
    const stamps = [...runs.map((r) => r.createdAt), ...jobs.map((j) => j.updatedAt)].sort();
    const failed = runs.some((r) => r.status === 'failed') || jobs.some((j) => j.status === 'dead');
    const running = runs.some((r) => r.status === 'running' || r.status === 'queued') || jobs.some((j) => j.status === 'queued' || j.status === 'running');
    return {
      correlationId,
      runs,
      jobs,
      firstAt: stamps[0]!,
      lastAt: stamps[stamps.length - 1]!,
      state: failed ? 'failed' : running ? 'running' : 'settled',
    };
  });
}
