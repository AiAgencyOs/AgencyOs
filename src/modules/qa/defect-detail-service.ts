import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  addDefectEvidenceSchema,
  linkDefectBuildSchema,
  type AddDefectEvidenceInput,
  type LinkDefectBuildInput,
} from './defect-detail-schema';

/**
 * SCR-047 — attach evidence; link the build a fix lands in.
 *
 * Evidence is `task.write`: a member is the developer who submits the fix,
 * and their screenshot is the evidence — the same admission `recordTestRun`
 * and `qa.assign_retest` make (Doc 14 §18). The database asks again through
 * `core.can_write()`. The build link is `project.write`, matching
 * `triageDefect`, and `core.can_manage_delivery()` at the door — the roles
 * the `defects_write` policy names.
 */

export async function addDefectEvidence(input: AddDefectEvidenceInput): Promise<Result<{ evidenceId: string }>> {
  const parsed = addDefectEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid evidence.');
  }

  const context = await requireInternal();
  if (!can(context, 'task.write')) {
    return err('FORBIDDEN', 'You do not have permission to attach evidence.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('add_defect_evidence', {
    p_defect_id: parsed.data.defectId,
    p_kind: parsed.data.kind,
    p_value: parsed.data.value,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'addDefectEvidence', detail: error.message }));
    return err('INTERNAL', 'Could not attach the evidence.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string | null } | undefined;

  switch (row?.outcome) {
    case 'added':
      if (!row.id) return err('INTERNAL', 'Could not attach the evidence.');
      return ok({ evidenceId: row.id });
    case 'bad_kind':
      return err('VALIDATION', 'Evidence is a link or a note.');
    case 'bad_value':
      return err('VALIDATION', 'A link starts with http:// or https://; a note is at most 2000 characters.');
    case 'not_found':
      return err('NOT_FOUND', 'Defect not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to attach evidence.');
  }
}

export async function linkDefectBuild(input: LinkDefectBuildInput): Promise<Result<{ linked: boolean }>> {
  const parsed = linkDefectBuildSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid build link.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to triage defects.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('qa').rpc('link_defect_build', {
    p_defect_id: parsed.data.defectId,
    p_build_id: parsed.data.buildId,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'linkDefectBuild', detail: error.message }));
    return err('INTERNAL', 'Could not link the build.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;

  switch (row?.outcome) {
    case 'linked':
      return ok({ linked: true });
    case 'unlinked':
      return ok({ linked: false });
    case 'not_a_build':
      return err('VALIDATION', 'That deliverable is not a build — a design is reviewed, not built.');
    case 'wrong_project':
      return err('VALIDATION', 'That build is not on this project.');
    case 'settled':
      return err('CONFLICT', 'A settled defect is not re-triaged; reopen it first.');
    case 'not_found':
      return err('NOT_FOUND', 'Defect or build not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to triage defects.');
  }
}
