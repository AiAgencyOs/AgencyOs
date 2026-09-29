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
