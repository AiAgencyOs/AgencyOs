import 'server-only';

import { recordAudit } from '@/lib/audit';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { linkMeetingProjectSchema, type LinkMeetingProjectInput } from './meeting-project-schema';

/**
 * SCR-010 — a meeting is linked to a project through the row's own column.
 * `lead.write`, the capability every other meeting edit takes; RLS
 * (`meetings_write`) decides again, and the tenancy trigger
 * `org_match_meetings_project` refuses a project of another organization.
 * The project must be readable by the caller, which is how a stranger's id
 * is refused by name rather than by a trigger's exception.
 */
export async function linkMeetingToProject(input: LinkMeetingProjectInput): Promise<Result<{ projectId: string | null }>> {
  const parsed = linkMeetingProjectSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid meeting or project.');

  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to edit meetings.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  if (parsed.data.projectId) {
    const { data: project, error } = await supabase.schema('projects').from('projects').select('id').eq('id', parsed.data.projectId).is('deleted_at', null).maybeSingle();
    if (error) return err('INTERNAL', 'Could not read the project.');
    if (!project) return err('NOT_FOUND', 'Project not found.');
  }

  const { data: before, error: readError } = await supabase.schema('crm').from('meetings').select('id, project_id').eq('id', parsed.data.meetingId).maybeSingle();
  if (readError) return err('INTERNAL', 'Could not read the meeting.');
  if (!before) return err('NOT_FOUND', 'Meeting not found.');

  const { data: updated, error } = await supabase
    .schema('crm')
    .from('meetings')
    .update({ project_id: parsed.data.projectId })
    .eq('id', before.id)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'linkMeetingToProject', detail: error.message }));
    return err('INTERNAL', 'Could not link the meeting.');
  }
  if (!updated) return err('FORBIDDEN', 'The database refused the change.');

  await recordAudit({
    organizationId: context.organizationId,
    action: 'meeting.project_linked',
    subjectType: 'meeting',
    subjectId: before.id,
    before: { project_id: before.project_id },
    after: { project_id: parsed.data.projectId },
  });

  return ok({ projectId: parsed.data.projectId });
}
