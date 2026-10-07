import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Phase 8 observability: counts and ages, read-only, from the existing 8A tables through `projects.phase_eight_observability`. The database groups and counts;
 * this file only reshapes the rows. Health is the existing derived read, SLA state the existing support clock, stages the stored statuses. A failed read is
 * refused (G-054): an empty dashboard must mean there is nothing to count.
 */

export type ObservabilityMetric = 'tickets_by_state' | 'tickets_by_sla' | 'tickets_by_response_sla' | 'health_distribution' | 'recovery_plans' | 'renewals_due' | 'opportunities_by_stage';
export type ObservabilityBucket = { bucket: string; count: number; oldestAt: string | null };
export type Observability = Record<ObservabilityMetric, ObservabilityBucket[]>;

export const OBSERVABILITY_METRICS: readonly ObservabilityMetric[] = [
  'tickets_by_state', 'tickets_by_sla', 'tickets_by_response_sla', 'health_distribution', 'recovery_plans', 'renewals_due', 'opportunities_by_stage',
];

export function emptyObservability(): Observability {
  return { tickets_by_state: [], tickets_by_sla: [], tickets_by_response_sla: [], health_distribution: [], recovery_plans: [], renewals_due: [], opportunities_by_stage: [] };
}

/** Whole days between a timestamp and now (never negative); null when there is no timestamp. */
export function ageInDays(oldestAt: string | null, now: Date): number | null {
  if (!oldestAt) return null;
  const then = Date.parse(oldestAt);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / 86400000));
}

export async function readPhaseEightObservability(): Promise<Observability> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('phase_eight_observability' as never, {} as never);
  if (error) unreadable('readPhaseEightObservability', error);
  const out = emptyObservability();
  for (const r of Array.isArray(data) ? (data as Record<string, unknown>[]) : []) {
    const metric = String(r.metric) as ObservabilityMetric;
    if (!(metric in out)) continue;
    out[metric].push({ bucket: String(r.bucket), count: Number(r.n ?? 0), oldestAt: typeof r.oldest_at === 'string' ? r.oldest_at : null });
  }
  return out;
}
