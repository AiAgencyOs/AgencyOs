import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { attachMeetingSummarySchema, type AttachMeetingSummaryInput } from './meeting-memory-schema';

export type Attached = { memoryId: string; leadId: string | null; alreadyThere: boolean };

/**
 * Files what a meeting said as a project-scoped memory — SCR-017.
 *
 * The person-facing door to `ai.memory_records`, which until this migration
 * only the sales handoff handlers could write. `ai.attach_meeting_summary_to_memory`
 * takes the meeting's newest summary (or typed notes) as the fact, the
 * evidence row as the provenance, and sets the confidence the evidence
 * earns: explicit for notes a person typed, inferred for an analysis.
 * Idempotent per (project, evidence). Nothing is composed here.
 *
 * Gated on `lead.write` — owner and ops_admin, the two roles the INSERT
 * policy names through `core.is_admin()`; RLS decides again on the insert.
 */
export async function attachMeetingSummaryToMemory(input: AttachMeetingSummaryInput): Promise<Result<Attached>> {
  const parsed = attachMeetingSummarySchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'That is not a valid meeting or project.');

  const context = await requireInternal();
  if (!can(context, 'lead.write')) {
    return err('FORBIDDEN', 'Only the owner or an ops admin can attach a meeting to project memory.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('ai').rpc('attach_meeting_summary_to_memory', {
    p_meeting_id: parsed.data.meetingId,
    p_project_id: parsed.data.projectId,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'attachMeetingSummaryToMemory', detail: error.message }));
    return err('INTERNAL', 'Could not write the memory record.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome: string; memory_id: string | null; lead_id: string | null }
    | undefined;

  switch (row?.outcome) {
    case 'attached':
      return ok({ memoryId: row.memory_id ?? '', leadId: row.lead_id, alreadyThere: false });
    case 'already_attached':
      return ok({ memoryId: row.memory_id ?? '', leadId: row.lead_id, alreadyThere: true });
    case 'not_found':
      return err('NOT_FOUND', 'Meeting not found.');
    case 'unknown_project':
      return err('NOT_FOUND', 'That project is not one this organization can see.');
    case 'no_summary':
      return err('CONFLICT', 'This meeting has no summary or typed notes to attach — add notes on the meeting first.');
    case 'forbidden':
      return err('FORBIDDEN', 'Only the owner or an ops admin can attach a meeting to project memory.');
    case 'no_actor':
      return err('FORBIDDEN', 'No signed-in person to record the memory against.');
    default:
      return err('INTERNAL', `The memory could not be written (${row?.outcome ?? 'no answer'}).`);
  }
}
