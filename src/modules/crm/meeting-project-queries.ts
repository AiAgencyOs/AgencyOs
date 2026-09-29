import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-010 — which project each meeting is about, by meeting id. Read beside
 * `listMeetings`/`getMeeting` (queries.ts) so the meeting readers stay what
 * they are; the project's name comes under the caller's own RLS.
 */
export type MeetingProjectLink = { projectId: string; projectName: string };

export async function readMeetingProjects(meetingIds: readonly string[]): Promise<Map<string, MeetingProjectLink>> {
  const links = new Map<string, MeetingProjectLink>();
  if (meetingIds.length === 0) return links;
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('meetings')
    .select('id, project_id')
    .in('id', [...meetingIds])
    .not('project_id', 'is', null);
  if (error) unreadable('readMeetingProjects', error);
  const rows = (data ?? []).filter((r): r is { id: string; project_id: string } => r.project_id !== null);
  const projectIds = [...new Set(rows.map((r) => r.project_id))];
  if (projectIds.length === 0) return links;
  const { data: projects, error: projectsError } = await supabase.schema('projects').from('projects').select('id, name').in('id', projectIds);
  if (projectsError) unreadable('readMeetingProjects.projects', projectsError);
  const nameById = new Map((projects ?? []).map((p) => [p.id, p.name]));
  for (const r of rows) links.set(r.id, { projectId: r.project_id, projectName: nameById.get(r.project_id) ?? r.project_id.slice(0, 8) });
  return links;
}

/** The projects a meeting may be linked to: the ones its lead's client owns, then every other live project the caller can read. */
export async function listProjectOptionsForMeeting(limit = 200): Promise<{ id: string; name: string; status: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name, status')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listProjectOptionsForMeeting', error);
  return (data ?? []).map((p) => ({ id: p.id, name: p.name, status: p.status }));
}
