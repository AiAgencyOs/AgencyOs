import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { reviseRequirementVersionSchema, type ReviseRequirementVersionInput } from './requirement-revise-schema';

export type Revised = { versionId: string; version: number; leadId: string | null };

/**
 * Writes the next requirement version from an existing one with an edited
 * payload — SCR-009. `crm.requirement_versions` is append-only except for
 * status, so an edit cannot touch the row it edits: the door
 * (`crm.revise_requirement_version`) inserts version n+1 as `proposed`,
 * source `human`, and marks the source `superseded` through the one
 * transition the guard trigger allows from any state. The new version then
 * goes through the same approval gate as an extraction would.
 *
 * Gated on `lead.write` (owner, ops_admin) — the same roles the table's
 * UPDATE policy admits; the door re-checks `core.is_admin()` and RLS
 * decides again.
 */
export async function reviseRequirementVersion(input: ReviseRequirementVersionInput): Promise<Result<Revised>> {
  const parsed = reviseRequirementVersionSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'The edited requirement could not be validated: a summary is required, and every item is at most 500 characters.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to revise requirements.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('revise_requirement_version', {
    p_source_version_id: parsed.data.versionId,
    p_payload: parsed.data.payload,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'reviseRequirementVersion', detail: error.message }));
    return err('INTERNAL', 'Could not write the new version.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome: string; version_id: string | null; version: number | null; lead_id: string | null }
    | undefined;

  switch (row?.outcome) {
    case 'revised':
      return ok({ versionId: row.version_id ?? '', version: row.version ?? 0, leadId: row.lead_id });
    case 'not_found':
      return err('NOT_FOUND', 'Requirement version not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'Only the owner or an ops admin can revise a requirement version.');
    case 'not_revisable':
      return err('CONFLICT', 'Only a proposed or accepted version can be edited; this one is already rejected, superseded or failed.');
    case 'invalid_payload':
      return err('VALIDATION', 'The edited requirement needs a summary.');
    case 'no_actor':
      return err('FORBIDDEN', 'No signed-in person to record the edit against.');
    default:
      return err('INTERNAL', `The new version could not be written (${row?.outcome ?? 'no answer'}).`);
  }
}
