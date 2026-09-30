import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { QaStageFacts } from './qa-stage';

/**
 * The two facts the QA stage is derived from, per project (decision 9): its
 * open test runs and whether it has a release (a handover, or marked
 * production-ready). Three bounded reads; a failed read refuses rather than
 * printing a pipeline that silently has no QA in it.
 */
export async function readQaStageFacts(): Promise<Map<string, Pick<QaStageFacts, 'openTestRuns' | 'hasRelease'>>> {
  const supabase = await createClient();
  const [runs, handovers, ready] = await Promise.all([
    supabase.schema('qa').from('test_runs').select('project_id').eq('status', 'open').limit(5000),
    supabase.schema('projects').from('handovers').select('project_id').limit(2000),
    supabase.schema('projects').from('projects').select('id').not('production_ready_at', 'is', null).limit(2000),
  ]);
  if (runs.error) unreadable('readQaStageFacts.runs', runs.error);
  if (handovers.error) unreadable('readQaStageFacts.handovers', handovers.error);
  if (ready.error) unreadable('readQaStageFacts.ready', ready.error);

  const out = new Map<string, { openTestRuns: number; hasRelease: boolean }>();
  const slot = (id: string) => {
    let s = out.get(id);
    if (!s) out.set(id, (s = { openTestRuns: 0, hasRelease: false }));
    return s;
  };
  for (const r of runs.data ?? []) slot(r.project_id).openTestRuns += 1;
  for (const h of handovers.data ?? []) slot(h.project_id).hasRelease = true;
  for (const p of ready.data ?? []) slot(p.id).hasRelease = true;
  return out;
}
