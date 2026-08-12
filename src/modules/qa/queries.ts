import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { Defect, ProjectQuality } from './types';

/**
 * Reads for QA. RLS-scoped and internal only — a client is told what was
 * fixed, not what is currently broken.
 *
 * Every reader refuses rather than answering with a zero, for the same reason
 * the operations page does: a QA board that renders "no open blockers" because the database did
 * not answer is the single most expensive false statement in this system. It
 * is the sentence somebody reads immediately before telling a client the build
 * is ready.
 */

const SELECT =
  'id, severity, status, title, reproduction, expected, actual, environment, evidence_url, resolution, deliverable_id, verified_at, created_at';

export async function listDefects(projectId: string): Promise<Defect[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('qa')
    .from('defects')
    .select(SELECT)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) unreadable('listDefects', error);

  return data ?? [];
}

export async function readProjectQuality(projectId: string): Promise<ProjectQuality> {
  const supabase = await createClient();

  // `.single()` rather than reading data[0]: a function that returns no row is
  // a read that could not answer, and this makes it an error travelling the
  // same path as any other rather than a second refusal beside the first.
  const { data, error } = await supabase
    .schema('qa')
    .rpc('project_quality', { p_project_id: projectId })
    .single();

  if (error) unreadable('readProjectQuality', error);

  return data as ProjectQuality;
}
