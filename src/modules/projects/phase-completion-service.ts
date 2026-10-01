import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { completePhaseSchema, type CompletePhaseInput } from './phase-completion-schema';

/**
 * Q-PH56 — completes Phase 5 or Phase 6 through `projects.complete_phase`
 * (project.write: owner, ops admin, delivery lead). The door re-reads the
 * Development / QA data under the project's lock, records the evidence, audits
 * it and emits the event that raises the M3 / M4 invoice and the PM message.
 * It never marks anything paid.
 */
export async function completePhase(input: CompletePhaseInput): Promise<Result<{ outcome: 'completed' | 'already_completed' }>> {
  const parsed = completePhaseSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid request.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to complete a phase.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('complete_phase', { p_project_id: parsed.data.projectId, p_phase: parsed.data.phase });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'completePhase', detail: error.message }));
    return err('INTERNAL', 'Could not complete the phase.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; missing?: string[] } | undefined;
  switch (row?.outcome) {
    case 'completed':
      return ok({ outcome: 'completed' });
    case 'already_completed':
      return ok({ outcome: 'already_completed' });
    case 'not_ready':
      return err('CONFLICT', `Not ready yet: ${(row.missing ?? []).join(' ') || 'the project data does not show the phase as done.'}`);
    case 'not_found':
      return err('NOT_FOUND', 'Project not found.');
    case 'invalid_phase':
      return err('VALIDATION', 'Only Phase 5 and Phase 6 are completed this way.');
    default:
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may complete a phase.');
  }
}
