import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-022 — the meetings a project calendar can honestly show.
 *
 * `crm.meetings` links to a lead and, optionally, to the opportunity the
 * lead became; it never links to a project. The one honest trace is
 * `projects.projects.opportunity_id` → `crm.meetings.opportunity_id`: the
 * meetings booked on the deal this project was won from. That is what is
 * read — nothing is inferred through the client account, which would pull
 * in every other deal's meetings too.
 */
export type ProjectMeeting = {
  id: string;
  leadId: string;
  status: string;
  outcome: string | null;
  mode: string | null;
  /** The confirmed start, or the requested one while it is still unconfirmed. */
  startAt: string | null;
  meetingUrl: string | null;
};

export async function listProjectMeetings(projectId: string): Promise<ProjectMeeting[]> {
  const supabase = await createClient();

  const { data: project, error: projectError } = await supabase
    .schema('projects')
    .from('projects')
    .select('opportunity_id')
    .eq('id', projectId)
    .is('deleted_at', null)
    .maybeSingle();
  if (projectError) unreadable('listProjectMeetings.project', projectError);
  if (!project) return [];

  // The meetings on the deal this project was won from, and the ones made from this project
  // (`crm.meetings.project_id`, written by `projects.attach_meeting_to_project`).
  const { data, error } = await supabase
    .schema('crm')
    .from('meetings')
    .select('id, lead_id, status, outcome, booked_mode, requested_mode, confirmed_start_at, requested_start_at, meeting_url')
    .or(project.opportunity_id ? `opportunity_id.eq.${project.opportunity_id},project_id.eq.${projectId}` : `project_id.eq.${projectId}`)
    .neq('status', 'cancelled')
    .order('confirmed_start_at', { ascending: true, nullsFirst: false });
  if (error) unreadable('listProjectMeetings.meetings', error);

  return (data ?? []).map((m) => ({
    id: m.id,
    leadId: m.lead_id,
    status: m.status,
    outcome: m.outcome,
    mode: m.booked_mode ?? m.requested_mode,
    startAt: m.confirmed_start_at ?? m.requested_start_at,
    meetingUrl: m.meeting_url,
  }));
}
