import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { linkRequirementSchema, type LinkRequirementInput } from './requirement-link-schema';

export type Linked = { linkId: string };

/**
 * Declares a link from a requirement version to a quotation, a design
 * deliverable or a development task — SCR-029. The door
 * (`crm.link_requirement`) checks the target is visible under RLS in the
 * same organisation (and, for a design, that the deliverable is a design or
 * prototype), writes one `crm.requirement_links` row per (version, target),
 * and audits `requirement.linked`. The derived "Cited by" list is untouched.
 *
 * Gated on `lead.write` (owner, ops_admin); the door re-checks
 * `core.is_admin()` and RLS decides again.
 */
export async function linkRequirement(input: LinkRequirementInput): Promise<Result<Linked>> {
  const parsed = linkRequirementSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Pick a quotation, a design or a task to link.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to link a requirement.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('link_requirement', {
    p_requirement_version_id: parsed.data.versionId,
    p_target_type: parsed.data.targetType,
    p_target_id: parsed.data.targetId,
    p_note: parsed.data.note && parsed.data.note.length > 0 ? parsed.data.note : null,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'linkRequirement', detail: error.message }));
    return err('INTERNAL', 'The link could not be written.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome: string; link_id: string | null } | undefined;

  switch (row?.outcome) {
    case 'linked':
      return ok({ linkId: row.link_id ?? '' });
    case 'already_linked':
      return err('CONFLICT', 'This version is already linked to that record.');
    case 'no_actor':
      return err('FORBIDDEN', 'No signed-in person to record the link against.');
    case 'forbidden':
      return err('FORBIDDEN', 'Only the owner or an ops admin can link a requirement.');
    case 'not_found':
      return err('NOT_FOUND', 'Requirement version not found.');
    case 'bad_target_type':
      return err('VALIDATION', 'A link targets a quotation, a design or a task.');
    case 'target_not_found':
      return err('NOT_FOUND', 'That record is not in this organisation, or is not a design or prototype.');
    default:
      return err('INTERNAL', `The link could not be written (${row?.outcome ?? 'no answer'}).`);
  }
}
