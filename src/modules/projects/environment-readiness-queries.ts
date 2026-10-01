import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { READINESS_CHECKS, type ReadinessCheck } from './environment-readiness-schema';

/**
 * SCR-043 — the environment matrix: every environment with each of its
 * three readiness checks as recorded (or "not checked"), the build promoted
 * to it, and the release gates as `qa.release_gates()` answers them right
 * now. Read only; every failed read refuses.
 */

export type ReadinessEntry = {
  ok: boolean;
  evidenceUrl: string | null;
  note: string | null;
  checkedAt: string | null;
  checkedBy: string | null;
  /** 'workflow' when a dispatched GitHub workflow recorded it (owner decision 13); null when a person did. */
  source: string | null;
};

export type EnvironmentReadiness = {
  id: string;
  kind: string;
  label: string;
  url: string;
  checks: Record<ReadinessCheck, ReadinessEntry | null>;
  /** Every check recorded and ok. */
  ready: boolean;
  promotedBuildId: string | null;
  promotedAt: string | null;
};

export type ReleaseGate = { gate: string; state: 'pass' | 'fail' | 'undecided'; detail: string | null };

export async function listEnvironmentReadiness(projectId: string): Promise<EnvironmentReadiness[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('environments')
    .select('id, kind, label, url, readiness, promoted_build_id, promoted_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) unreadable('listEnvironmentReadiness', error);
  type Row = { id: string; kind: string; label: string; url: string; readiness: unknown; promoted_build_id: string | null; promoted_at: string | null };
  return ((data ?? []) as Row[]).map((e) => {
    const raw = (e.readiness && typeof e.readiness === 'object' ? e.readiness : {}) as Record<string, Record<string, unknown> | undefined>;
    const checks = {} as Record<ReadinessCheck, ReadinessEntry | null>;
    for (const c of READINESS_CHECKS) {
      const entry = raw[c];
      checks[c] = entry
        ? {
            ok: entry.ok === true,
            evidenceUrl: typeof entry.evidence_url === 'string' ? entry.evidence_url : null,
            note: typeof entry.note === 'string' ? entry.note : null,
            checkedAt: typeof entry.checked_at === 'string' ? entry.checked_at : null,
            checkedBy: typeof entry.checked_by === 'string' ? entry.checked_by : null,
            source: typeof entry.source === 'string' ? entry.source : null,
          }
        : null;
    }
    return {
      id: e.id,
      kind: e.kind,
      label: e.label,
      url: e.url,
      checks,
      ready: READINESS_CHECKS.every((c) => checks[c]?.ok === true),
      promotedBuildId: e.promoted_build_id,
      promotedAt: e.promoted_at,
    };
  });
}

export async function readReleaseGates(projectId: string): Promise<ReleaseGate[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('release_gates', { p_project_id: projectId });
  if (error) unreadable('readReleaseGates', error);
  return ((data ?? []) as { gate: string; state: string; detail: string | null }[]).map((g) => ({
    gate: g.gate,
    state: g.state === 'pass' ? 'pass' : g.state === 'fail' ? 'fail' : 'undecided',
    detail: g.detail,
  }));
}

export type EnvironmentCheckRun = {
  id: string;
  environmentId: string;
  checks: string[];
  workflowFile: string;
  dispatchedAt: string;
  status: 'dispatched' | 'in_progress' | 'completed';
  conclusion: string | null;
  runUrl: string | null;
  /** True once the result was written onto the environment's readiness. */
  recorded: boolean;
};

/** Owner decision 13 — the dispatches of the contract / migration check workflow, newest first, three per environment. */
export async function listEnvironmentCheckRuns(projectId: string): Promise<Map<string, EnvironmentCheckRun[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('environment_check_runs')
    .select('id, environment_id, checks, workflow_file, dispatched_at, status, conclusion, run_url, applied_at')
    .eq('project_id', projectId)
    .order('dispatched_at', { ascending: false })
    .limit(200);
  if (error) unreadable('listEnvironmentCheckRuns', error);
  const byEnvironment = new Map<string, EnvironmentCheckRun[]>();
  for (const r of data ?? []) {
    const list = byEnvironment.get(r.environment_id) ?? [];
    if (list.length >= 3) continue;
    list.push({
      id: r.id,
      environmentId: r.environment_id,
      checks: r.checks,
      workflowFile: r.workflow_file,
      dispatchedAt: r.dispatched_at,
      status: r.status === 'completed' ? 'completed' : r.status === 'in_progress' ? 'in_progress' : 'dispatched',
      conclusion: r.conclusion,
      runUrl: r.run_url,
      recorded: r.applied_at !== null,
    });
    byEnvironment.set(r.environment_id, list);
  }
  return byEnvironment;
}
