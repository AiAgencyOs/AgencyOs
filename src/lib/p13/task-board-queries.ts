import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { BoardHandoff, BoardJob } from './task-board';

const SAMPLE = 500;

/** Recent jobs, recent handoffs and the jobs an open escalation names, all RLS-scoped. A capped sample is reported as capped, never as everything. */
export async function readTaskBoardSources(): Promise<{ jobs: BoardJob[]; handoffs: BoardHandoff[]; escalatedJobIds: Set<string>; capped: boolean }> {
  const supabase = await createClient();
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();

  const jobs = await supabase
    .schema('core')
    .from('jobs')
    .select('id, kind, status, priority, run_at, attempts, max_attempts, created_at, last_error')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(SAMPLE);
  if (jobs.error) unreadable('readTaskBoardSources.jobs', jobs.error);

  const handoffs = await supabase
    .schema('ai')
    .from('handoffs')
    .select('id, from_agent, to_agent, status, objective, created_at, sla_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(SAMPLE);
  if (handoffs.error) unreadable('readTaskBoardSources.handoffs', handoffs.error);

  const esc = await supabase.schema('core').from('escalations').select('subject_key').in('state', ['open', 'acknowledged']).like('subject_key', 'job-%');
  if (esc.error) unreadable('readTaskBoardSources.escalations', esc.error);

  return {
    jobs: (jobs.data ?? []) as BoardJob[],
    handoffs: (handoffs.data ?? []) as BoardHandoff[],
    escalatedJobIds: new Set((esc.data ?? []).map((e) => e.subject_key.replace(/^job-/, ''))),
    capped: (jobs.data?.length ?? 0) >= SAMPLE || (handoffs.data?.length ?? 0) >= SAMPLE,
  };
}
