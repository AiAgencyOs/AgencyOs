import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { PhaseCompletionPhase } from './phase-completion-schema';

export type PhaseCompletionReading = {
  phase: PhaseCompletionPhase;
  state: 'completed' | 'ready' | 'not_ready';
  completedAt: string | null;
  missing: string[];
};

/** Where Phase 5 and Phase 6 stand for a project: completed, ready to complete, or what is missing. */
export async function readPhaseCompletions(projectId: string): Promise<PhaseCompletionReading[]> {
  const supabase = await createClient();
  const { data: done, error } = await supabase.schema('projects').from('phase_completions').select('phase, completed_at').eq('project_id', projectId);
  if (error) unreadable('readPhaseCompletions.completions', error);
  const completedAt = new Map((done ?? []).map((r) => [r.phase, r.completed_at] as const));

  const out: PhaseCompletionReading[] = [];
  for (const phase of [5, 6] as const) {
    const at = completedAt.get(phase);
    if (at) {
      out.push({ phase, state: 'completed', completedAt: at, missing: [] });
      continue;
    }
    const { data, error: readError } = await supabase.schema('projects').rpc('phase_readiness', { p_project_id: projectId, p_phase: phase });
    if (readError) unreadable('readPhaseCompletions.readiness', readError);
    const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; missing?: string[] } | undefined;
    out.push({ phase, state: row?.outcome === 'ready' ? 'ready' : 'not_ready', completedAt: null, missing: row?.missing ?? [] });
  }
  return out;
}
