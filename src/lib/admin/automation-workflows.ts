import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { statsByJobKind, type JobKindStats } from './automation-workflows-eval';

/**
 * How each job kind has actually run in the last thirty days, for the
 * workflow definitions panel. `core.jobs` is readable by owner and ops admin
 * (the same read Operations uses). The sample is bounded, and the answer says
 * so (`capped`) rather than reporting a partial figure as the whole.
 */
const WINDOW_DAYS = 30;
const SAMPLE = 5000;

export async function readJobKindStats(): Promise<{ stats: Map<string, JobKindStats>; capped: boolean; windowDays: number }> {
  const supabase = await createClient();
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase
    .schema('core')
    .from('jobs')
    .select('kind, status, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(SAMPLE);
  if (error) unreadable('readJobKindStats', error);
  const rows = (data ?? []) as { kind: string; status: string; created_at: string }[];
  return { stats: statsByJobKind(rows), capped: rows.length >= SAMPLE, windowDays: WINDOW_DAYS };
}
